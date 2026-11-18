import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every program started through node:child_process, so a test can prove that no PowerShell ran.
const started = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (load) => {
  const real = await load<typeof import("node:child_process")>();
  const note = (file: unknown) => started.push(path.basename(String(file)));
  return {
    ...real,
    spawn: ((file: string, ...rest: unknown[]) => {
      note(file);
      return (real.spawn as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof real.spawn,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      note(file);
      return (real.execFileSync as (...args: unknown[]) => unknown)(
        file,
        ...rest,
      );
    }) as typeof real.execFileSync,
  };
});

/**
 * Installer Stage 6: CoherencePlatform.exe must behave exactly like the PowerShell it replaces. These tests need a
 * built helper (`node packaging/build-launcher.mjs` puts it in build/helper, or set SCREENSCRIBE_V2_PLATFORM_HELPER)
 * and are skipped without one; `node scripts/test-platform-helper.mjs` refuses to run without it.
 */
const HELPER =
  process.env.SCREENSCRIBE_V2_PLATFORM_HELPER ||
  path.resolve("build", "helper", "CoherencePlatform.exe");
const available = process.platform === "win32" && fs.existsSync(HELPER);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-test-helper-"));
  vi.resetModules();
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", path.join(root, "global"));
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_DIR", path.join(root, "workspace"));
  started.length = 0;
});
afterEach(async () => {
  await (await import("../storage/projectRegistry")).releaseProjectLeases();
  await (
    await import("../storage/windowsStorageGuard")
  ).releaseFilesystemGuard();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

type Reply = { id: number; ok: boolean; error?: string };
function guardSession(file: string, args: string[]) {
  const child = spawn(file, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, (reply: Reply) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as Reply;
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  let id = 0;
  return {
    send: (request: Record<string, unknown>) =>
      new Promise<Reply>((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        child.stdin.write(JSON.stringify({ ...request, id: n }) + "\n");
      }),
    close: () =>
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.stdin.end();
      }),
  };
}

const ino = (p: string) => fs.statSync(p, { bigint: true }).ino.toString();
const sha = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const ancestors = (p: string) => {
  const all: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    all.unshift(at);
    if (path.dirname(at) === at) return all;
  }
};
// Windows' own tools: a developer shell (Git Bash) may put a different whoami first on PATH.
const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const currentSid = () =>
  /"(S-1-[\d-]+)"/.exec(
    execFileSync(
      path.join(system32, "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true },
    ),
  )![1];
const icacls = (...args: string[]) =>
  execFileSync(path.join(system32, "icacls.exe"), args, {
    windowsHide: true,
    stdio: "ignore",
  });

/** The same requests, in order, against one implementation; returns every answer and observable outcome. */
async function guardScenario(file: string, args: string[], base: string) {
  fs.mkdirSync(base);
  const s = guardSession(file, args);
  const out: unknown[] = [];
  const ask = async (request: Record<string, unknown>) =>
    out.push((await s.send(request)).ok);
  const a = path.join(base, "a");
  fs.mkdirSync(a);
  await ask({ action: "lock", token: "t1", paths: [base, a] });
  await ask({ action: "lock", token: "t2", paths: [path.join(base, "gone")] });
  await ask({ action: "unlock", token: "t1" });
  const owned = path.join(base, "owned");
  await ask({ action: "create-directory", token: "t3", path: owned });
  await ask({ action: "create-directory", token: "t4", path: owned });
  await ask({ action: "unlock", token: "t3" });
  const note = path.join(a, "note.md");
  fs.writeFileSync(note, "hello");
  await ask({ action: "verify-file", path: note, identity: ino(note) });
  await ask({ action: "verify-file", path: note, identity: "1" });
  const remove = (hash: string) =>
    ask({
      action: "remove",
      path: note,
      identity: ino(note),
      hash,
      directory: false,
    });
  await remove("0".repeat(64));
  out.push(fs.existsSync(note));
  await remove(sha(note));
  out.push(fs.existsSync(note));
  const next = path.join(a, "next.tmp-0123456789ab"),
    current = path.join(a, "current.md");
  fs.writeFileSync(next, "v2");
  fs.writeFileSync(current, "v1");
  await ask({
    action: "replace",
    from: next,
    to: current,
    identity: ino(next),
  });
  out.push(fs.readFileSync(current, "utf8"));
  const moved = path.join(base, "moved");
  await ask({ action: "rename", from: owned, to: moved, identity: ino(owned) });
  out.push(fs.existsSync(moved));
  await ask({
    action: "remove",
    path: moved,
    identity: ino(moved),
    hash: "",
    directory: true,
  });
  out.push(fs.existsSync(moved));
  const jobs = path.join(a, "jobs");
  const queue = (target: string, rootIdentity: string) =>
    ask({
      action: "queue",
      paths: ancestors(a),
      root: a,
      rootIdentity,
      directory: jobs,
      target: path.join(jobs, target),
      content: '{"name":"Café — 東京"}',
    });
  await queue("job_one.json", ino(a));
  out.push(fs.readFileSync(path.join(jobs, "job_one.json"), "utf8"));
  await queue("job_two.json", "1");
  out.push(fs.readdirSync(jobs));
  await ask({ action: "unknown" });
  await s.close();
  return out;
}

describe.runIf(available)("CoherencePlatform.exe", () => {
  it("answers the storage guard protocol exactly like the PowerShell guard", async () => {
    const { STORAGE_GUARD_SCRIPT } =
      await import("../storage/windowsStorageGuard");
    const powershell = await guardScenario(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        STORAGE_GUARD_SCRIPT,
      ],
      path.join(root, "powershell"),
    );
    const helper = await guardScenario(
      HELPER,
      ["guard"],
      path.join(root, "helper"),
    );
    expect(helper).toEqual(powershell);
    // prettier-ignore
    expect(helper).toEqual([
      true, false, true, // lock; a missing path is refused; unlock
      true, false, true, // create; an existing folder is never adopted; unlock
      true, false, // verify-file: right and wrong identity
      false, true, true, false, // remove: a wrong hash keeps the file, the right one removes it
      true, "v2", // replace
      true, true, // rename
      true, false, // remove an empty folder
      true, '{"name":"Café — 東京"}', // queue, with UTF-8 intact
      false, ["job_one.json"], // queue refused for a changed root, nothing left behind
      false, // unknown operation
    ]);
  }, 60_000);

  it("reads saved keys either implementation protected (the same DPAPI call)", async () => {
    const secrets = await import("../storage/protectedSecrets");
    const settings = {
      connections: [{ id: "c1", apiKey: "test-key-not-real" }],
    };
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "");
    const byPowerShell = await secrets.protectSettings(settings);
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", HELPER);
    expect(await secrets.unprotectSettings(byPowerShell)).toEqual(settings);
    const byHelper = await secrets.protectSettings(settings);
    expect(JSON.stringify(byHelper)).not.toContain("test-key-not-real");
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "");
    expect(await secrets.unprotectSettings(byHelper)).toEqual(settings);
  }, 60_000);

  it("resolves the same Known Folders", async () => {
    const { knownFolder } = await import("../storage/locations");
    const both = () => [
      knownFolder("MyDocuments"),
      knownFolder("LocalApplicationData"),
    ];
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "");
    const expected = both();
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", HELPER);
    expect(both()).toEqual(expected);
  }, 60_000);

  it("makes the launcher folder private: owned by and open only to the current user", () => {
    const dir = path.join(root, "privé");
    fs.mkdirSync(dir);
    const base64 = Buffer.from(dir, "utf8").toString("base64");
    execFileSync(HELPER, ["private-directory"], {
      input: base64,
      windowsHide: true,
    });
    const sddl = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Acl -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))).Sddl",
      ],
      { input: base64, encoding: "utf8", windowsHide: true },
    ).trim();
    const sid = currentSid();
    // A protected DACL (P; Windows adds the auto-inherited flag AI) with one entry: full control for this user.
    expect(sddl).toMatch(
      new RegExp(`^O:${sid}G:[^D]+D:P(AI)?\\(A;OICI;FA;;;${sid}\\)$`),
    );
  }, 60_000);

  it("names Controlled Folder Access when Windows denies access, from the guard and from a plain write", async () => {
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", HELPER);
    await (await import("../storage/projectStore")).ensureDataDirs();
    const guard = await import("../storage/windowsStorageGuard");
    const io = await import("../storage/fsUtils");
    const sid = currentSid();
    const noFolders = path.join(root, "no-folders"),
      noFiles = path.join(root, "global", "no-files");
    fs.mkdirSync(noFolders);
    fs.mkdirSync(noFiles);
    icacls(noFolders, "/deny", `*${sid}:(AD)`);
    icacls(noFiles, "/deny", `*${sid}:(WD)`);
    try {
      const s = guardSession(HELPER, ["guard"]);
      expect(
        await s.send({
          action: "create-directory",
          token: "t",
          path: path.join(noFolders, "project"),
        }),
      ).toMatchObject({ ok: false, error: "access-denied" });
      await s.close();
      await expect(
        guard.createOwnedDirectory(path.join(noFolders, "project")),
      ).rejects.toMatchObject({ status: 409, code: "ACCESS_DENIED" });
      const refused = io.writeFileAtomic(path.join(noFiles, "x.json"), "{}");
      await expect(refused).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(refused).rejects.toThrow(
        /Controlled Folder Access.*CoherencePlatform\.exe/,
      );
    } finally {
      icacls(noFolders, "/remove:d", `*${sid}`);
      icacls(noFiles, "/remove:d", `*${sid}`);
    }
  }, 60_000);

  it("runs no PowerShell once the helper is in use", async () => {
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", HELPER);
    const store = await import("../storage/projectStore");
    await store.ensureDataDirs();
    const project = await store.createProject({
      name: "Helper only",
      description: "",
    });
    const secrets = await import("../storage/protectedSecrets");
    await secrets.unprotectSettings(
      await secrets.protectSettings({ apiKey: "test-key-not-real" }),
    );
    (await import("../storage/locations")).knownFolder("MyDocuments");
    const jobs = await import("../jobs/jobManager");
    const job = await jobs.startJob("export", project.id, async () => "done");
    expect((await jobs.waitForJob(job.id)).status).toBe("succeeded");
    expect(started).toContain("CoherencePlatform.exe");
    expect(started.filter((name) => name !== path.basename(HELPER))).toEqual(
      [],
    );
  }, 60_000);
});

describe("platformProcess", () => {
  it("uses a helper only when an absolute path is configured (developer runs)", async () => {
    const { platformProcess } = await import("./nativeHelper");
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "");
    expect(platformProcess("guard", ["-Command", "x"])).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "x"],
    });
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "CoherencePlatform.exe");
    expect(platformProcess("guard", []).file).toBe("powershell.exe");
    const absolute = path.join(root, "CoherencePlatform.exe");
    vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", absolute);
    expect(platformProcess("reveal", ["-Command", "x"])).toEqual(
      process.platform === "win32"
        ? { file: absolute, args: ["reveal"] }
        : expect.objectContaining({ file: "powershell.exe" }),
    );
  });
});
