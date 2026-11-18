import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withProjectNamespace } from "./projectNamespace";
import { assertOutsideProjects } from "./projectBoundaries";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-test-namespace-"));
});
afterEach(async () => {
  // A killed child's storage-guard worker can hold a directory handle for a moment after it exits.
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
});

it("serializes local namespace changes, permits awaited nesting, and releases after failure", async () => {
  const order: number[] = [];
  await Promise.all([
    withProjectNamespace(async () => {
      order.push(1);
      await withProjectNamespace(async () => {
        order.push(2);
      });
      await new Promise((r) => setTimeout(r, 20));
      order.push(3);
    }),
    withProjectNamespace(async () => {
      order.push(4);
    }),
  ]);
  expect(order).toEqual([1, 2, 3, 4]);
  await expect(
    withProjectNamespace(async () => {
      throw Error("Synthetic preparation failure");
    }),
  ).rejects.toThrow(/Synthetic/);
  await expect(withProjectNamespace(async () => "next owner")).resolves.toBe(
    "next owner",
  );
});

async function otherProfile() {
  const module = pathToFileURL(
    path.resolve("server/storage/projectNamespace.ts"),
  ).href;
  const code = `import fs from 'node:fs'; import {withProjectNamespace} from ${JSON.stringify(module)};
    await withProjectNamespace(async()=>{
      process.send('prepared');
      await new Promise(resolve=>process.once('message',resolve));
      fs.writeFileSync(${JSON.stringify(path.join(root, "project.json"))},JSON.stringify({storage:{format:'coherence-project'}}));
    }); process.disconnect();`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const ready = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw Error("Synthetic profile exited before claiming namespace");
    }),
  ]);
  expect(ready[0]).toBe("prepared");
  return child;
}
it("a different profile waits until an unmarked parent is published, then rejects its nested workspace", async () => {
  const child = await otherProfile();
  try {
    let entered = false;
    const select = withProjectNamespace(async () => {
      entered = true;
      assertOutsideProjects(path.join(root, "specs"));
    });
    const expected = expect(select).rejects.toThrow(/cannot contain/);
    await new Promise((r) => setTimeout(r, 100));
    expect(entered).toBe(false);
    child.send("publish");
    await expected;
    expect(
      JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"))
        .storage.format,
    ).toBe("coherence-project");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
it("a crashed profile releases the namespace gate without stale-file recovery", async () => {
  const child = await otherProfile(),
    exited = once(child, "exit");
  child.kill();
  await exited;
  await expect(withProjectNamespace(async () => "recovered")).resolves.toBe(
    "recovered",
  );
  expect(await fs.readdir(root)).toEqual([]);
});

it("real project creation holds the namespace until its manifest is published", async () => {
  const module = pathToFileURL(
    path.resolve("server/storage/projectStore.ts"),
  ).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
    ),
  );
  env.SCREENSCRIBE_V2_DATA_DIR = path.join(root, "global");
  env.SCREENSCRIBE_V2_WORKSPACE_DIR = path.join(root, "workspace");
  const code = `import path from 'node:path';import {createProject} from ${JSON.stringify(module)};
    await createProject({name:'Unpublished project',description:'Synthetic'},async p=>{
      process.send(path.dirname(p.outputDir));await new Promise(resolve=>process.once('message',resolve));
    });process.disconnect();`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw Error("Synthetic project creation failed");
      }),
    ]);
    const folder = String(ready[0]);
    expect(folder.startsWith(root + path.sep)).toBe(true);
    let entered = false;
    const select = withProjectNamespace(async () => {
      entered = true;
      assertOutsideProjects(path.join(folder, "specs"));
    });
    const result = expect(select).rejects.toThrow(/cannot contain/);
    await new Promise((r) => setTimeout(r, 100));
    expect(entered).toBe(false);
    child.send("publish");
    await result;
    expect(
      JSON.parse(await fs.readFile(path.join(folder, "project.json"), "utf8"))
        .storage.format,
    ).toBe("coherence-project");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

it("failed project preparation retains a foreign project instead of recursively cleaning it up", async () => {
  const module = pathToFileURL(
    path.resolve("server/storage/projectStore.ts"),
  ).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
    ),
  );
  env.SCREENSCRIBE_V2_DATA_DIR = path.join(root, "global");
  env.SCREENSCRIBE_V2_WORKSPACE_DIR = path.join(root, "workspace");
  const code = `import fs from 'node:fs/promises';import path from 'node:path';import {createProject} from ${JSON.stringify(module)};
    let folder;try{await createProject({name:'Failed prep',description:'Synthetic'},async p=>{
      folder=path.dirname(p.outputDir);const child=path.join(folder,'foreign-project');await fs.mkdir(child);
      await fs.writeFile(path.join(child,'project.json'),JSON.stringify({id:'foreign',storage:{format:'coherence-project'}}));
      await fs.writeFile(path.join(child,'human.md'),'KEEP FOREIGN HUMAN CONTENT');throw Error('Synthetic preparation failure');
    });throw Error('Unexpected successful creation');}catch(e){if(e.message!=='Synthetic preparation failure')throw e;}
    process.send(folder);process.disconnect();`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw Error("Synthetic failed-creation probe exited early");
      }),
    ]);
    const folder = String(ready[0]);
    expect(folder.startsWith(root + path.sep)).toBe(true);
    expect(
      await fs.readFile(
        path.join(folder, "foreign-project", "human.md"),
        "utf8",
      ),
    ).toBe("KEEP FOREIGN HUMAN CONTENT");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(folder, "foreign-project", "project.json"),
          "utf8",
        ),
      ).id,
    ).toBe("foreign");
    await expect(
      withProjectNamespace(async () => "gate released"),
    ).resolves.toBe("gate released");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
