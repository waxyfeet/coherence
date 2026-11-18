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

// SF-B-01: independent physical boundaries, tested through authenticated real servers.
async function rejected(response) {
  const r = await response;
  assert(
    [400, 409, 500].includes(r.status),
    "Expected boundary refusal, got " + r.status,
  );
  const message = await r.text();
  assert(/project|folder|CORRUPT_PROJECT/i.test(message));
}
async function profile(name, workspace = path.join(root, "workspace-" + name)) {
  await fs.mkdir(workspace, { recursive: true });
  return start(path.join(root, "global-" + name), workspace);
}
async function create(s, name) {
  return s.api("/projects", "POST", { name, description: "Synthetic only" });
}
async function plant(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  await fs.mkdir(path.join(target, "specs"), { recursive: true });
  await fs.writeFile(
    path.join(target, "specs", "human.md"),
    "KEEP SYNTHETIC HUMAN REQUIREMENT\n".repeat(200) + "APPROVED TAIL",
  );
}
try {
  const a = await profile("a"),
    parent = await create(a, "Parent fixture");
  const cleanParent = path.join(root, "parent-template");
  await fs.cp(parent.projectPath, cleanParent, { recursive: true });
  await a.stop();
  const b = await profile("b"),
    nestedWorkspace = path.join(parent.projectPath, "specs");
  await fs.mkdir(nestedWorkspace);
  const original = await inventory(parent.projectPath);
  await rejected(
    b.request("/storage/workspace", "PUT", { path: nestedWorkspace }),
  );
  await rejected(
    b.request("/projects", "POST", {
      name: "Rejected child",
      description: "Synthetic",
      workspaceDir: nestedWorkspace,
    }),
  );
  assert.deepEqual(await inventory(parent.projectPath), original);
  check(
    "Original Track B sequence: a fresh profile cannot select/create inside an unregistered portable parent; all parent files unchanged",
  );

  const template = await create(b, "Child template");
  // Reconstruct already-existing invalid layouts externally; the app must not adopt or repair them.
  const child = path.join(parent.projectPath, "specs", "foreign-child");
  await plant(template.projectPath, child);
  const nestedBefore = await inventory(parent.projectPath);
  const c = await profile("c");
  await rejected(
    c.request("/storage/open", "POST", { path: parent.projectPath }),
  );
  await rejected(c.request("/storage/open", "POST", { path: child }));
  assert.deepEqual(await inventory(parent.projectPath), nestedBefore);
  check(
    "Both opening orders reject existing parent/child overlap across fresh profiles, including inactive nested children",
  );

  // Open an independent child first; introduce a containing marker while it stays active.
  const container = path.join(root, "late-containing"),
    liveChild = path.join(container, "specs", "live-child");
  await plant(template.projectPath, liveChild);
  await c.api("/storage/open", "POST", { path: liveChild });
  const beforeContaining = await inventory(liveChild);
  await fs.copyFile(
    path.join(cleanParent, "project.json"),
    path.join(container, "project.json"),
  );
  const d = await profile("d");
  await rejected(d.request("/storage/open", "POST", { path: container }));
  const childRead = await c.request("/projects/" + template.id);
  assert(!childRead.ok);
  assert.deepEqual(await inventory(liveChild), beforeContaining);
  check(
    "Active child becomes unavailable after an external containing project marker appears; another profile cannot enroll its parent",
  );

  // Open parent first, then insert a complete foreign project below specs without using app APIs.
  const late = path.join(root, "late-parent");
  await fs.cp(cleanParent, late, { recursive: true });
  const p = await d.api("/storage/open", "POST", { path: late });
  const nested = path.join(late, "specs", "late-child");
  await plant(template.projectPath, nested);
  const before = await inventory(late),
    rel = "late-child/specs/human.md";
  await rejected(
    d.request(
      "/projects/" + p.id + "/files/content?path=" + encodeURIComponent(rel),
    ),
  );
  await rejected(
    d.request(
      "/projects/" + p.id + "/files/raw?path=" + encodeURIComponent(rel),
    ),
  );
  await rejected(
    d.request("/projects/" + p.id + "/files/content", "PUT", {
      path: rel,
      content: "MUST NOT APPLY",
      baseHash: sha(await fs.readFile(path.join(nested, "specs", "human.md"))),
      baseMtimeMs: (await fs.stat(path.join(nested, "specs", "human.md")))
        .mtimeMs,
    }),
  );
  await rejected(d.request("/projects/" + p.id + "/duplicate", "POST", {}));
  await rejected(
    d.request("/projects/" + p.id + "/trash", "POST", {
      confirmation: p.id,
      expectedUpdatedAt: p.updatedAt,
    }),
  );
  await rejected(b.request("/storage/open", "POST", { path: nested }));
  assert.deepEqual(await inventory(late), before);
  check(
    "Late nested project blocks parent file/raw reads, exact-base writes, duplication and Trash; every file remains unchanged",
  );
  await d.stop();
  const restarted = await start(
    path.join(root, "global-d"),
    path.join(root, "workspace-d"),
  );
  const cards = await restarted.api("/projects");
  assert.equal(cards.find((x) => x.id === p.id)?.availability, "unavailable");
  await rejected(
    restarted.request("/storage/open", "POST", {
      path: late,
      expectedId: p.id,
    }),
  );
  assert.deepEqual(await inventory(late), before);
  check(
    "Restart/relink cannot resurrect a previously enrolled overlapping parent",
  );

  // Unrelated sibling projects remain usable in different profiles.
  const left = await create(b, "Safe left"),
    right = await create(restarted, "Safe right");
  assert.equal((await b.api("/projects/" + left.id)).id, left.id);
  assert.equal((await restarted.api("/projects/" + right.id)).id, right.id);
  check("Separate sibling project workflows remain available across profiles");
  await b.api(`/projects/${left.id}/trash`, "POST", {
    confirmation: left.id,
    expectedUpdatedAt: left.updatedAt,
  });
  const trash = (await b.api("/trash")).find((t) => t.projectId === left.id);
  const review = await b.api(`/trash/${trash.id}/deletion-preview`);
  const index = JSON.parse(
    await fs.readFile(
      path.join(root, "global-b", "projects-index.json"),
      "utf8",
    ),
  );
  const trashRoot = index.entries.find((e) => e.trashId === trash.id).root;
  await plant(cleanParent, path.join(trashRoot, "foreign-project"));
  const trashBefore = await inventory(trashRoot);
  await rejected(
    b.request(`/trash/${trash.id}/permanent-delete`, "POST", {
      confirmation: trash.id,
      expectedRevision: review.revision,
    }),
  );
  assert.deepEqual(await inventory(trashRoot), trashBefore);
  check(
    "Permanent purge refuses a foreign project inserted after deletion review; all Trash and child canaries remain unchanged",
  );
  for (const s of servers) s.assertNoLeak?.();
  await fs.mkdir("artifacts/storage-foundation", { recursive: true });
  await fs.writeFile(
    "artifacts/storage-foundation/single-format-boundaries.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        automatedBrowser: false,
        ownerDataModified: false,
        paidApis: false,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  for (const s of servers.reverse()) await s.stop();
  const absolute = path.resolve(root);
  assert(path.basename(absolute).startsWith("coherence-test-storage-api-"));
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  await fs.rm(absolute, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 150,
  });
}
