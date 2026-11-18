import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { isRestartFile, createContentGate } from "./dev-server.mjs";
const root = process.cwd();
for (const filename of [
  "server/index.ts",
  "server/new/handler.ts",
  "server/specs/specStore.ts",
  "shared/types.ts",
  "package.json",
  "tsconfig.json",
  "tsconfig.server.json",
])
  test("restarts for " + filename, () =>
    assert.equal(isRestartFile(root, filename), true),
  );
for (const filename of [
  "node_modules/ws/lib/event-target.js",
  "server/node_modules/ws/lib/event-target.js",
  "shared/node_modules/dependency.js",
  ".screenscribe-v2/projects/customer/project.json",
  ".cache/generated.ts",
  "dist/index.js",
  "artifacts/build.log",
  "server/logs/event.json",
  "server/generated/model.ts",
  "server/build/output.js",
  "server/schema.json",
  "server/tmp/generated.ts",
  "server/.cache/generated.ts",
  "server/index.ts.tmp",
  "server/index.tmp.ts",
  "server/handler.test.ts",
  "shared/schema.spec.ts",
  "server/.index.ts",
  "server/#index.ts",
  "server/index.ts~",
  "server/notes.md",
  "src/RealApp.tsx",
  "package-lock.json",
  "README.md",
])
  test("ignores " + filename, () =>
    assert.equal(isRestartFile(root, filename), false),
  );
test("ignores configured runtime storage even inside source", () => {
  assert.equal(
    isRestartFile(
      root,
      "server/runtime/project.json",
      path.join(root, "server/runtime"),
    ),
    false,
  );
  assert.equal(
    isRestartFile(
      root,
      "server/runtime-copy/handler.ts",
      path.join(root, "server/runtime"),
    ),
    true,
  );
});
test("rejects absent events and paths outside the application", () => {
  assert.equal(isRestartFile(root, undefined), false);
  assert.equal(isRestartFile(root, "../server/index.ts"), false);
});

function fixture(t) {
  fs.mkdirSync(path.join(root, ".cache/test-temp"), { recursive: true });
  const dir = fs.mkdtempSync(
    path.join(root, ".cache/test-temp/watch-content-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["server", "shared"])
    fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, "server/index.ts"), "// original source\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  return dir;
}
test("content baseline ignores reads, timestamps, identical writes and identical atomic replacements", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "server/index.ts");
  const gate = createContentGate(dir);
  fs.readFileSync(file);
  fs.utimesSync(file, new Date(0), new Date(0));
  assert.deepEqual(gate.changes(), []);
  fs.writeFileSync(file, "// original source\n");
  assert.deepEqual(gate.changes(), []);
  fs.writeFileSync(file + ".tmp", "// original source\n");
  fs.renameSync(file + ".tmp", file);
  assert.deepEqual(gate.changes(), []);
});
test("content changes, edits reverted later, additions and deletions are identified exactly once", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "server/index.ts");
  const gate = createContentGate(dir);
  fs.appendFileSync(file, "// genuine change\n");
  assert.deepEqual(gate.changes(), ["server/index.ts"]);
  assert.deepEqual(gate.changes(), []);
  fs.writeFileSync(file, "// original source\n");
  assert.deepEqual(gate.changes(), ["server/index.ts"]);
  fs.mkdirSync(path.join(dir, "shared/new"));
  fs.writeFileSync(path.join(dir, "shared/new/types.ts"), "export {};\n");
  assert.equal(gate.affects("shared/new"), true);
  assert.deepEqual(gate.changes(), ["shared/new/types.ts"]);
  fs.rmSync(path.join(dir, "shared/new"), { recursive: true });
  assert.equal(gate.affects("shared/new"), true);
  assert.deepEqual(gate.changes(), ["shared/new/types.ts"]);
  assert.deepEqual(gate.changes(), []);
});
test("configuration atomic saves compare contents, including creation and deletion", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "tsconfig.json");
  const gate = createContentGate(dir);
  fs.writeFileSync(file, "{}");
  assert.deepEqual(gate.changes(), ["tsconfig.json"]);
  fs.writeFileSync(file + ".tmp", "{}");
  fs.renameSync(file + ".tmp", file);
  assert.deepEqual(gate.changes(), []);
  fs.writeFileSync(file + ".tmp", '{"compilerOptions":{}}');
  fs.renameSync(file + ".tmp", file);
  assert.deepEqual(gate.changes(), ["tsconfig.json"]);
  fs.unlinkSync(file);
  assert.deepEqual(gate.changes(), ["tsconfig.json"]);
});
test("non-regular eligible files fail before accepting a baseline or new contents", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "server/index.ts");
  const gate = createContentGate(dir);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => gate.changes(), /Cannot safely fingerprint/);
  assert.throws(() => createContentGate(dir), /Cannot safely fingerprint/);
});
test("unreadable input fails closed without exposing its raw error or secret", (t) => {
  const dir = fixture(t),
    gate = createContentGate(dir);
  const fault = t.mock.method(fs, "readFileSync", () => {
    throw new Error("synthetic-secret C:\\private\\sensitive-path");
  });
  try {
    assert.throws(
      () => gate.changes(),
      (error) =>
        !error.message.includes("synthetic-secret") &&
        !error.message.includes("sensitive-path"),
    );
    assert.throws(() => createContentGate(dir), /Cannot safely fingerprint/);
  } finally {
    fault.mock.restore();
  }
});
