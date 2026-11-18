/** Real production startup ordering in a disposable application copy. Only the permission step is delayed. */
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = process.cwd(),
  fixture = path.join(root, ".cache", "startup-order-" + Date.now());
await fs.mkdir(fixture, { recursive: true });
for (const folder of ["server", "shared"])
  await fs.cp(path.join(root, folder), path.join(fixture, folder), {
    recursive: true,
  });
for (const file of ["package.json", "tsconfig.json", "tsconfig.server.json"])
  await fs.cp(path.join(root, file), path.join(fixture, file));
await fs.symlink(
  path.join(root, "node_modules"),
  path.join(fixture, "node_modules"),
  "junction",
);
const dataDir = path.join(fixture, "runtime"),
  launchDir = path.join(dataDir, ".local-auth"),
  recordFile = path.join(launchDir, "launch.json"),
  marker = path.join(dataDir, "prepare-began");
await fs.mkdir(launchDir, { recursive: true });
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const backend = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("SCREENSCRIBE_V2_") &&
      !/(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET)$/i.test(key),
  ),
);
Object.assign(env, {
  SCREENSCRIBE_V2_DATA_DIR: dataDir,
  SCREENSCRIBE_V2_WORKSPACE_DIR: dataDir + "-workspace",
  SCREENSCRIBE_V2_PORT: String(port),
});
for (const key of Object.keys(process.env))
  if (key.startsWith("SCREENSCRIBE_V2_")) delete process.env[key];
Object.assign(process.env, env);
const { prepareBrowserLaunch, verifyLocalServer } =
  await import("../server/security/localLauncher.ts");
const { LauncherError, launcherFailureMessage } =
  await import("../server/security/launcherErrors.ts");
const modulePath = path.join(fixture, "server/security/localLauncher.ts");
const source = await fs.readFile(modulePath, "utf8");
const needle = "await privateDirectory(runtimeDir());";
assert(source.includes(needle));
await fs.writeFile(
  modulePath,
  source.replace(
    needle,
    'await fs.writeFile(path.join(config.dataDir, "prepare-began"), "fixture"); await new Promise((resolve) => setTimeout(resolve, 1200)); ' +
      needle,
  ),
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(40);
  }
  throw Error("Isolated startup condition timed out");
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
async function listening() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
function start(script = "server/index.ts", args = []) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.isAbsolute(script) ? script : path.join(fixture, script),
      ...args,
    ],
    { cwd: fixture, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    error = "",
    exit;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  child.once("exit", (code) => {
    exit = code;
  });
  return { child, output: () => output, error: () => error, exit: () => exit };
}
async function stop(run) {
  if (!run || run.child.exitCode !== null) return;
  const ended = new Promise((resolve) => run.child.once("exit", resolve));
  run.child.kill("SIGTERM");
  await ended;
}
const checks = [],
  notices = [];
const check = (message) => {
  checks.push(message);
  console.log("PASS " + message);
};
let run;
try {
  await fs.writeFile(
    recordFile,
    JSON.stringify({ capability: "a".repeat(64), backend }),
  );
  let previous = "a".repeat(64);
  for (const phase of ["cold start", "hard-kill restart"]) {
    await fs.unlink(marker).catch(() => {});
    run = start();
    await until(() => exists(marker));
    assert.equal(await listening(), false);
    const unavailable = await prepareBrowserLaunch().catch((error) => error);
    assert(
      unavailable instanceof LauncherError &&
        unavailable.code === "SERVER_UNAVAILABLE",
    );
    await until(() => run.output().includes("Coherence running at"));
    const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
    assert(record.capability !== previous);
    assert.equal(record.backend, backend);
    await verifyLocalServer(record.capability, backend);
    const handoff = await prepareBrowserLaunch();
    assert.equal(handoff.origin, backend);
    assert(!run.output().includes(record.capability));
    assert(!run.error().includes(record.capability));
    check(
      phase +
        ": no listening socket during delayed permission preparation; ready log follows fresh record publication and verified launch succeeds",
    );
    const original = await fs.readFile(recordFile, "utf8"),
      second = start();
    await until(() => second.exit() !== undefined);
    assert.equal(second.exit(), 1);
    assert.equal(await fs.readFile(recordFile, "utf8"), original);
    await verifyLocalServer(record.capability, backend);
    check(
      phase +
        ": a second instance cannot clear the live launch record or take its startup claim",
    );
    previous = record.capability;
    await stop(run);
    await until(async () => !(await listening()));
  }
  // Block the protected-directory preparation using a regular file, without changing any ACL.
  assert(
    path.relative(fixture, launchDir) === path.join("runtime", ".local-auth"),
  );
  await fs.rm(launchDir, { recursive: true });
  await fs.writeFile(launchDir, "synthetic-private-permission-fixture");
  await fs.unlink(marker).catch(() => {});
  run = start();
  await until(() => run.exit() !== undefined);
  assert.equal(run.exit(), 1);
  assert.equal(await listening(), false);
  assert.equal(await exists(path.join(dataDir, ".instance-lock.json")), false);
  assert(
    run.error().includes("could not prepare its protected local launcher"),
  );
  assert(
    !run.error().includes(dataDir) &&
      !run.error().includes("synthetic-private-permission-fixture"),
  );
  check(
    "Preparation failure exits before listening, releases the startup claim and prints only a safe actionable category",
  );
  const cli = start(path.join(root, "scripts/open-local.ts"), ["--dev"]);
  await until(() => cli.exit() !== undefined);
  assert.equal(cli.exit(), 1);
  assert(cli.error().includes("protected local launcher"));
  assert(
    !cli.error().includes(dataDir) &&
      !cli.error().includes("owns the V2 data folder"),
  );
  check(
    "Actual open:dev CLI distinguishes local preparation failure without paths, tokens or the ownership assertion",
  );
  await fs.unlink(launchDir);
  const absent = start(path.join(root, "scripts/open-local.ts"), ["--dev"]);
  await until(() => absent.exit() !== undefined);
  assert.equal(absent.exit(), 1);
  assert(absent.error().includes("not ready or unavailable"));
  check(
    "Actual open:dev CLI identifies missing readiness state as unavailable",
  );
  notices.push(
    "Directory obstruction and mocked permission-helper failure exercised; destructive SYSTEM/orphan-SID ACL cases were not run.",
    "Browser-open rejection is mocked in unit tests; OS default-browser refusal is not reproduced here.",
  );
  await fs.writeFile(
    path.join(root, "artifacts/startup-readiness-verification.json"),
    JSON.stringify(
      {
        checks,
        notices,
        scope:
          "Disposable application copy, actual production startup/launcher/Windows permission helper. Delayed preparation only in the fixture; no real project or credential data, provider calls or tracker writes.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await stop(run);
}
