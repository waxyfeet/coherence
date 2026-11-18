/** No browsers, user profiles, paid models or live integrations. Real production-server HTTP and filesystem IO. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "coherence-test-storage-api-"),
);
const ownedRoots = [root],
  servers = [],
  checks = [],
  inventories = {};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installedSamplesBefore = await inventory("samples");
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function inventory(folder) {
  const out = {};
  async function visit(dir, rel = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const key = rel ? rel + "/" + entry.name : entry.name,
        file = path.join(dir, entry.name);
      assert(!entry.isSymbolicLink(), "Fixture inventory refuses links");
      if (entry.isDirectory()) await visit(file, key);
      else out[key] = sha(await fs.readFile(file));
    }
  }
  await visit(folder);
  return out;
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function until(fn, message, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(message);
}
async function start(data, workspace = data + "-workspace", existingPort) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
    ),
  );
  Object.assign(env, {
    SCREENSCRIBE_V2_DATA_DIR: data,
    SCREENSCRIBE_V2_PORT: String(existingPort ?? (await port())),
    SCREENSCRIBE_V2_MOCK_DELAY_MS: "1",
    SCREENSCRIBE_V2_WORKSPACE_DIR: workspace,
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.resolve("scripts/storage-network-fixture.mjs")).href,
      "--import",
      "tsx",
      "server/index.ts",
    ],
    {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const instance = {
    child,
    data,
    workspace,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exit;
    },
  };
  servers.push(instance);
  await until(async () => {
    if (child.exitCode !== null)
      throw Error("Synthetic storage server failed to start: " + output);
    return output.includes("Coherence running at");
  }, "Synthetic server startup timed out");
  const record = JSON.parse(
    await fs.readFile(path.join(data, ".local-auth", "launch.json"), "utf8"),
  );
  instance.origin = record.backend;
  const challenge = randomBytes(32).toString("hex");
  const identity = await fetch(record.backend + "/api/auth/identity", {
    method: "POST",
    headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ challenge }),
  }).then((r) => r.json());
  assert.equal(
    identity.proof,
    createHmac("sha256", record.capability)
      .update("identity\n" + challenge)
      .digest("hex"),
  );
  const payload = Buffer.from(
    JSON.stringify({
      nonce: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 60000,
      origin: record.backend,
    }),
  ).toString("base64url");
  const ticket =
    payload +
    "." +
    createHmac("sha256", record.capability)
      .update("bootstrap\n" + payload)
      .digest("hex");
  const response = await fetch(record.backend + "/api/auth/bootstrap", {
    method: "POST",
    headers: {
      Origin: "null",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ticket }),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const encoded = html.match(
    /localStorage\.setItem\([^,]+,\s*("(?:\\.|[^"\\])*")\)/,
  )?.[1];
  assert(encoded, "Expected actual bootstrap session");
  const session = JSON.parse(JSON.parse(encoded));
  instance.request = async (
    route,
    method = "GET",
    body,
    authenticated = true,
    headers = {},
  ) =>
    fetch(record.backend + "/api" + route, {
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${session.token}` } : {}),
        "X-ScreenScribe": "1",
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  instance.api = async (route, method = "GET", body) => {
    const r = await instance.request(route, method, body);
    assert(
      r.ok,
      `${method} ${route} failed ${r.status}: ${await r.clone().text()}`,
    );
    return r.json();
  };
  instance.job = async (start) => {
    const job = await start;
    const id = job.jobId ?? job.id;
    return until(
      async () => {
        const value = await instance.api("/jobs/" + id);
        if (value.status === "failed" || value.status === "cancelled")
          throw Error(
            "Synthetic job failed: " +
              JSON.stringify(value.logs?.slice(-2)) +
              " " +
              value.error,
          );
        return value.status === "succeeded" ? value : false;
      },
      "Synthetic job timed out",
      180000,
    );
  };
  instance.assertNoLeak = () => {
    assert(!output.includes(record.capability));
    assert(!output.includes(session.token));
  };
  return instance;
}
async function generate(s, p) {
  return s.job(
    s.api(`/projects/${p.id}/generate`, "POST", {
      ...p.llm,
      preserveEdited: true,
      thoroughness: "standard",
    }),
  );
}
async function replace(s, p, screen) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([await fs.readFile("samples/screens/02-dashboard.png")], {
      type: "image/png",
    }),
    "synthetic-replacement.png",
  );
  return s.api(`/projects/${p.id}/screens/${screen.id}/image`, "PUT", body);
}
try {
  if (process.platform === "win32") {
    const resolved = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          "import {knownFolder} from './server/storage/locations.ts'; process.stdout.write(JSON.stringify([knownFolder('MyDocuments'),knownFolder('LocalApplicationData')]));",
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
    assert(resolved.every((folder) => path.isAbsolute(folder)));
    check(
      "Native Windows Known Folder resolution succeeds read-only; redirected mappings are separately fixture-tested",
    );
  }
  const workspace = path.join(root, "project-container", "projects");
  await fs.mkdir(workspace, { recursive: true });
  const unrelatedGlobal = path.join(root, "unrecognised-global");
  await fs.mkdir(unrelatedGlobal);
  await fs.writeFile(
    path.join(unrelatedGlobal, "unrelated.txt"),
    "Never adopt or alter unrelated profile content",
  );
  const unrelatedBefore = await inventory(unrelatedGlobal);
  await assert.rejects(start(unrelatedGlobal, workspace), /failed to start/);
  assert.deepEqual(await inventory(unrelatedGlobal), unrelatedBefore);
  check(
    "Production startup refuses an unrecognised nonempty global folder without altering its contents",
  );
  await fs.writeFile(
    path.join(workspace, "unrelated.txt"),
    "SYNTHETIC UNRELATED FILE MUST STAY BYTE IDENTICAL",
  );
  let s = await start(path.join(root, "global"), workspace);
  for (const route of ["/storage", "/projects", "/storage/migrations"]) {
    assert.equal((await s.request(route, "GET", undefined, false)).status, 401);
  }
  assert.equal(
    (await s.request("/storage/workspace", "PUT", { path: workspace }, false))
      .status,
    401,
  );
  assert.equal(
    (
      await s.request("/storage/workspace", "PUT", { path: workspace }, true, {
        Origin: "https://foreign.invalid",
      })
    ).status,
    403,
  );
  check(
    "New storage endpoints preserve authentication and foreign-Origin rejection",
  );
  for (const route of [
    "/storage/migrations",
    "/storage/migrations/preview",
    "/storage/migrations/execute",
    "/system/output-folder",
  ]) {
    assert.equal((await s.request(route, "POST", {})).status, 404);
  }
  const unsupported = path.join(workspace, "parked-old-demo");
  await fs.mkdir(unsupported);
  await fs.writeFile(
    path.join(unsupported, "project.json"),
    JSON.stringify({
      id: "old-demo",
      name: "Parked old demo",
      screens: [],
      llm: {},
    }),
  );
  await fs.writeFile(
    path.join(unsupported, "human.md"),
    "KEEP OLD DEMO INTACT",
  );
  const unsupportedBefore = await inventory(unsupported);
  assert.equal(
    (await s.request("/storage/open", "POST", { path: unsupported })).status,
    400,
  );
  assert.deepEqual(await inventory(unsupported), unsupportedBefore);
  assert.equal((await s.api("/projects")).length, 0);
  assert.equal(
    (
      await s.request("/projects", "POST", {
        name: "Custom output",
        description: "",
        outputDir: path.join(root, "arbitrary-output"),
      })
    ).status,
    400,
  );
  check(
    "Only the complete current format can be opened; old formats and arbitrary output roots are refused unchanged; migration/output-folder APIs are absent",
  );
  const p = await s.api("/projects/demo", "POST");
  assert.equal(p.screens.length, 4);
  assert(p.projectPath.startsWith(workspace + path.sep));
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(p.projectPath, "project.json"), "utf8"),
    ).outputDir,
    "specs",
  );
  inventories.created = {
    project: await inventory(p.projectPath),
    globalFiles: (await fs.readdir(s.data)).filter(
      (n) => !n.startsWith(".local-auth"),
    ),
  };
  assert(!inventories.created.globalFiles.includes("projects"));
  assert(!inventories.created.globalFiles.includes(".trash"));
  check(
    "Production startup separates global settings and complete ACME project folder",
  );
  const portableBeforeLegacyProbe = await inventory(p.projectPath);
  await assert.rejects(start(path.dirname(workspace)), /failed to start/);
  assert.deepEqual(await inventory(p.projectPath), portableBeforeLegacyProbe);
  check(
    "An unrecognised parent profile cannot gain authority over an existing project workspace",
  );
  const projectRoute = `/projects/${p.id}`;
  await generate(s, p);
  let model = await s.api(projectRoute + "/model");
  assert(model.useCases.length > 0);
  assert(
    (await fs.readdir(path.join(p.projectPath, "jobs"))).some((n) =>
      n.endsWith(".json"),
    ),
  );
  check(
    "Full offline generation persists actual requirements, model, images and durable jobs in the project",
  );
  const uc = model.useCases[0],
    rel = uc.filePath;
  const file = await s.api(
    projectRoute + "/files/content?path=" + encodeURIComponent(rel),
  );
  const edited =
    file.content + "\n\nSYNTHETIC HUMAN REQUIREMENT — KEEP THIS EXACT END\n";
  await s.api(projectRoute + "/files/content", "PUT", {
    path: rel,
    content: edited,
    baseHash: file.contentHash,
    baseMtimeMs: file.mtimeMs,
  });
  await s.api(projectRoute + `/use-cases/${uc.id}/status`, "PATCH", {
    status: "approved",
  });
  const external = edited + "\nSYNTHETIC EXTERNAL EDIT AFTER APPROVAL\n";
  await fs.writeFile(path.join(p.outputDir, ...rel.split("/")), external);
  model = await s.api(projectRoute + "/model");
  assert.equal(model.useCases.find((u) => u.id === uc.id).status, "edited");
  await generate(s, p);
  let preserved = await fs.readFile(
    path.join(p.outputDir, ...rel.split("/")),
    "utf8",
  );
  const narrative = (value) =>
    value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  assert.equal(narrative(preserved), narrative(external));
  check(
    "App edits, approval invalidation on external edits and regeneration preserve exact human narrative; generated status/revision metadata refreshes",
  );
  await replace(s, p, p.screens[0]);
  const changed = await s.api(projectRoute);
  assert.equal(changed.screens[0].version, 2);
  const screenDir = path.join(p.projectPath, "screens", p.screens[0].id);
  assert((await fs.readdir(screenDir)).length >= 2);
  await s.job(
    s.api(projectRoute + "/impact", "POST", {
      change: {
        targetKind: "screen",
        targetId: p.screens[0].id,
        source: "screen-replace",
        description:
          "Synthetic screen replacement; check affected requirements",
      },
      connectionId: p.llm.textConnectionId,
    }),
  );
  assert((await s.api(projectRoute + "/impact")).length > 0);
  const afterImpact = await fs.readFile(
    path.join(p.outputDir, ...rel.split("/")),
    "utf8",
  );
  assert.equal(narrative(afterImpact), narrative(preserved));
  preserved = afterImpact;
  check(
    "Screenshot replacement retains originals and change-impact history stays in the project folder",
  );
  const duplicate = await s.api(projectRoute + "/duplicate", "POST", {});
  assert.equal(duplicate.status, "draft");
  assert.notEqual(duplicate.projectPath, p.projectPath);
  assert(!(await fs.readdir(duplicate.projectPath)).includes("model.json"));
  const siblingBefore = await inventory(p.projectPath);
  inventories.workflowAfter = {
    project: siblingBefore,
    globalFiles: (await fs.readdir(s.data)).filter(
      (n) => n !== ".local-auth" && n !== ".instance-lock.json",
    ),
  };
  await s.api(`/projects/${duplicate.id}/trash`, "POST", {
    confirmation: duplicate.id,
    expectedUpdatedAt: duplicate.updatedAt,
  });
  let trash = (await s.api("/trash")).find((t) => t.projectId === duplicate.id);
  assert(trash);
  await s.api(`/trash/${trash.id}/restore`, "POST");
  const restored = await s.api(`/projects/${duplicate.id}`);
  await s.api(`/projects/${duplicate.id}/trash`, "POST", {
    confirmation: duplicate.id,
    expectedUpdatedAt: restored.updatedAt,
  });
  trash = (await s.api("/trash")).find((t) => t.projectId === duplicate.id);
  const deletion = await s.api(`/trash/${trash.id}/deletion-preview`);
  await s.api(`/trash/${trash.id}/permanent-delete`, "POST", {
    confirmation: trash.id,
    expectedRevision: deletion.revision,
  });
  assert.deepEqual(await inventory(p.projectPath), siblingBefore);
  assert.equal(
    await fs.readFile(path.join(workspace, "unrelated.txt"), "utf8"),
    "SYNTHETIC UNRELATED FILE MUST STAY BYTE IDENTICAL",
  );
  check(
    "Duplicate, whole-folder Trash, restore and permanent purge preserve sibling and parent bytes",
  );
  const old = s;
  old.assertNoLeak();
  await old.stop();
  s = await start(old.data, workspace, Number(new URL(old.origin).port));
  assert.equal((await old.request("/projects")).status, 401);
  assert.equal(
    (
      await s.api(
        projectRoute + "/files/content?path=" + encodeURIComponent(rel),
      )
    ).content,
    preserved,
  );
  check(
    "Production restart rejects old sessions and reopens human-edited project content",
  );
  await s.stop();
  const relocated = path.join(root, "portable-copy");
  await fs.cp(p.projectPath, relocated, { recursive: true });
  const raw = JSON.parse(
    await fs.readFile(path.join(relocated, "project.json"), "utf8"),
  );
  raw.llm = {
    visionConnectionId: "missing-local-account",
    textConnectionId: "missing-cloud-account",
    visionModelId: "local-model",
    textModelId: "cloud-model",
  };
  await fs.writeFile(path.join(relocated, "project.json"), JSON.stringify(raw));
  const reopened = await start(
    path.join(root, "fresh-global"),
    path.join(root, "fresh-workspace"),
  );
  await reopened.api("/storage/open", "POST", { path: relocated });
  const detail = await reopened.api(projectRoute);
  assert.equal(detail.llm.visionConnectionId, "missing-local-account");
  assert.equal(
    (
      await reopened.api(
        projectRoute + "/files/content?path=" + encodeURIComponent(rel),
      )
    ).content,
    preserved,
  );
  const concurrent = await start(
    path.join(root, "other-global"),
    path.join(root, "other-workspace"),
  );
  assert.equal(
    (await concurrent.request("/storage/open", "POST", { path: relocated }))
      .status,
    409,
  );
  await concurrent.stop();
  check(
    "Copied project reopens without original AppData; missing connection IDs remain explicit and cross-profile second writer is rejected",
  );
  const retainedBeforeGuardFailure = await inventory(relocated);
  if (process.platform === "win32") {
    const script =
      "$p=[int][Console]::ReadLine(); @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$p+\" AND Name='powershell.exe'\") | ForEach-Object {$_.ProcessId}) | ConvertTo-Json -Compress";
    const found = JSON.parse(
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          input: String(reopened.child.pid) + "\n",
          encoding: "utf8",
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        },
      ).trim(),
    );
    const pids = Array.isArray(found) ? found : [found];
    assert.equal(pids.length, 1);
    assert(Number.isSafeInteger(pids[0]));
    process.kill(pids[0]);
    await until(
      () =>
        reopened.child.exitCode !== null || reopened.child.signalCode !== null,
      "Owned native-guard failure did not stop the server",
    );
    assert.equal(reopened.child.exitCode, 1);
    assert.deepEqual(await inventory(relocated), retainedBeforeGuardFailure);
    const recovered = await start(
      reopened.data,
      path.join(root, "fresh-workspace"),
    );
    assert.equal((await recovered.api(projectRoute)).id, p.id);
    await recovered.stop();
    check(
      "Loss of the owned Windows storage guard fails closed, preserves project bytes and permits crash recovery",
    );
  } else await reopened.stop();
  let otherDrive;
  if (process.platform === "win32")
    try {
      otherDrive = await fs.mkdtemp("D:\\coherence-test-storage-api-");
    } catch {}
  if (otherDrive) {
    ownedRoots.push(otherDrive);
    const cross = await start(path.join(root, "cross-global"), otherDrive);
    const cp = await cross.api("/projects/demo", "POST");
    assert(cp.projectPath.startsWith(otherDrive));
    await generate(cross, cp);
    await cross.api(`/projects/${cp.id}/trash`, "POST", {
      confirmation: cp.id,
      expectedUpdatedAt: (await cross.api(`/projects/${cp.id}`)).updatedAt,
    });
    const savedTrash = (await cross.api("/trash")).find(
      (t) => t.projectId === cp.id,
    );
    assert(savedTrash);
    await cross.api(`/trash/${savedTrash.id}/restore`, "POST");
    const copied = path.join(otherDrive, "complete-copy-from-c");
    const sourceInventory = await inventory(relocated);
    await fs.cp(relocated, copied, { recursive: true });
    assert.deepEqual(await inventory(copied), sourceInventory);
    await cross.api("/storage/open", "POST", { path: copied });
    assert.equal((await cross.api(projectRoute)).projectPath, copied);
    assert.equal(
      (
        await cross.api(
          projectRoute + "/files/content?path=" + encodeURIComponent(rel),
        )
      ).content,
      preserved,
    );
    assert.deepEqual(await inventory(copied), sourceInventory);
    check(
      "A complete current-format C:-to-D: copy reopens with identical files and human edits, without migration or the original profile",
    );
    await cross.stop();
    check(
      "Actual C: global profile and D: project workspace support generation and same-volume Trash/restore",
    );
  } else
    check(
      "SKIP other-volume runtime fixture: no writable D: fixture available",
    );
  for (const server of servers) server.assertNoLeak?.();
  const installedSamplesAfter = await inventory("samples");
  assert.deepEqual(installedSamplesAfter, installedSamplesBefore);
  inventories.installation = {
    before: installedSamplesBefore,
    after: installedSamplesAfter,
  };
  const report = {
    date: new Date().toISOString(),
    checks,
    inventories,
    automatedBrowser: false,
    ownerDataModified: false,
    paidApis: false,
  };
  await fs.mkdir("artifacts/storage-foundation", { recursive: true });
  await fs.writeFile(
    "artifacts/storage-foundation/single-format-api.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  for (const server of servers.reverse()) await server.stop();
  for (const folder of ownedRoots) {
    const absolute = path.resolve(folder);
    assert(path.basename(absolute).startsWith("coherence-test-storage-api-"));
    assert(
      [path.resolve(os.tmpdir()), "D:\\"].includes(path.dirname(absolute)),
    );
    await fs.rm(absolute, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 150,
    });
  }
}
