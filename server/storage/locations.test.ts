import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: native }));
import { defaultWorkspace, knownFolder, storageLocations } from "./locations";
beforeEach(() => {
  native.mockReset();
  for (const key of [
    "SCREENSCRIBE_V2_DATA_DIR",
    "SCREENSCRIBE_V2_WORKSPACE_DIR",
    "SCREENSCRIBE_V2_STORAGE_LAYOUT",
    // These cases check the PowerShell lookup; server/platform/nativeHelper.test.ts covers the native helper.
    "SCREENSCRIBE_V2_PLATFORM_HELPER",
  ])
    vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());
it("uses the current Windows Known Folder mapping, including redirected Documents, with fixed code and a GUID on stdin", () => {
  native.mockReturnValue("D:\\Synthetic Redirected Documents\\日本語\r\n");
  expect(knownFolder("MyDocuments")).toBe(
    "D:\\Synthetic Redirected Documents\\日本語",
  );
  const [, args, options] = native.mock.calls[0];
  expect(args.at(-1)).toContain("SHGetKnownFolderPath");
  expect(args.at(-1)).toContain("0x4000");
  expect(options.input).toBe("FDD39AD0-238F-46AF-ADB4-6C85480369C7\n");
  expect(options.windowsHide).toBe(true);
});
it("defaults to separate Known Folder authorities without assuming C:\\Users or the checkout", () => {
  native.mockImplementation((_cmd, _args, options) =>
    options.input.startsWith("FDD")
      ? "D:\\Synthetic Documents"
      : "C:\\Synthetic LocalAppData",
  );
  const locations = storageLocations("C:\\Synthetic Installation");
  expect(locations.storageLayout).toBe("portable");
  expect(locations.workspaceDir).toBe(
    path.join("D:\\Synthetic Documents", "Coherence", "Projects"),
  );
  expect(locations.dataDir).toBe(
    path.join("C:\\Synthetic LocalAppData", "Coherence"),
  );
});
it("a global-data override still uses the sole project format and a separate workspace", () => {
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", "C:\\Synthetic Legacy");
  native.mockReturnValue("D:\\Synthetic Documents");
  const locations = storageLocations("C:\\Synthetic Installation");
  expect(locations.storageLayout).toBe("portable");
  expect(locations.workspaceDir).toBe(
    path.join("D:\\Synthetic Documents", "Coherence", "Projects"),
  );
});
it("refuses explicit obsolete layout requests without resolving or modifying any folders", () => {
  vi.stubEnv("SCREENSCRIBE_V2_STORAGE_LAYOUT", "legacy");
  expect(() => storageLocations("C:\\Synthetic Installation")).toThrow(
    /no longer supported/,
  );
  expect(native).not.toHaveBeenCalled();
});
it("uses explicit portable fixtures without resolving or writing the real user's Known Folders", () => {
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", "C:\\Synthetic Global");
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_DIR", "D:\\Synthetic Workspace");
  expect(storageLocations("C:\\Synthetic Installation").storageLayout).toBe(
    "portable",
  );
  expect(native).not.toHaveBeenCalled();
});
it("fails clearly when Windows cannot resolve a known folder", () => {
  native.mockReturnValue("");
  expect(() => knownFolder("MyDocuments")).toThrow(/could not resolve/);
});

it("an unavailable Documents mapping leaves an explicit Browse choice rather than moving projects into global storage", () => {
  native.mockImplementation((_cmd, _args, options) =>
    options.input.startsWith("FDD") ? "" : "C:\\Synthetic LocalAppData",
  );
  const locations = storageLocations("C:\\Synthetic Installation");
  expect(locations.storageLayout).toBe("portable");
  expect(locations.workspaceDir).toBe("");
  expect(locations.dataDir).toBe(
    path.join("C:\\Synthetic LocalAppData", "Coherence"),
  );
});
it("reports an unresolvable or timed-out user folder as a typed start-up error, logging which helper timed out", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    native.mockReturnValue("relative\\path");
    expect(() => knownFolder("LocalApplicationData")).toThrow(
      expect.objectContaining({ code: "USER_FOLDERS_UNAVAILABLE" }),
    );
    expect(log).not.toHaveBeenCalled();
    native.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    });
    expect(() => storageLocations("C:\\Synthetic Installation")).toThrow(
      expect.objectContaining({ code: "USER_FOLDERS_UNAVAILABLE" }),
    );
    expect(log).toHaveBeenCalledWith(
      "[helper-timeout] Known-folder lookup did not finish within 15 s.",
    );
  } finally {
    log.mockRestore();
  }
});
it("gives developer runs their own Coherence-Dev folders, while explicit folders still win", () => {
  native.mockImplementation((_cmd, _args, options) =>
    options.input.startsWith("FDD")
      ? "D:\\Synthetic Documents"
      : "C:\\Synthetic LocalAppData",
  );
  const dev = storageLocations("C:\\Synthetic Checkout", "Coherence-Dev");
  expect(dev.dataDir).toBe(
    path.join("C:\\Synthetic LocalAppData", "Coherence-Dev"),
  );
  expect(dev.workspaceDir).toBe(
    path.join("D:\\Synthetic Documents", "Coherence-Dev", "Projects"),
  );
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", "C:\\Synthetic Chosen");
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_DIR", "D:\\Synthetic Chosen Workspace");
  const chosen = storageLocations("C:\\Synthetic Checkout", "Coherence-Dev");
  expect(chosen.dataDir).toBe(path.resolve("C:\\Synthetic Chosen"));
  expect(chosen.workspaceDir).toBe(
    path.resolve("D:\\Synthetic Chosen Workspace"),
  );
});
it("keeps projects out of OneDrive-synced or network Documents, explaining why (decision D8)", () => {
  const home = "C:\\Users\\Synthetic";
  const env = { OneDriveCommercial: "C:\\Users\\Synthetic\\OneDrive - Acme" };
  expect(
    defaultWorkspace(
      "C:\\Users\\Synthetic\\OneDrive - Acme\\Documents",
      "Coherence",
      env,
      home,
    ),
  ).toEqual({
    dir: path.join(home, "Coherence Projects"),
    note: "onedrive",
  });
  expect(
    defaultWorkspace(
      "\\\\fileserver\\home$\\synthetic",
      "Coherence",
      env,
      home,
    ),
  ).toEqual({ dir: path.join(home, "Coherence Projects"), note: "network" });
  // A folder that only starts with the same letters is not inside OneDrive.
  expect(
    defaultWorkspace(
      "C:\\Users\\Synthetic\\OneDrive - Acme Archive\\Documents",
      "Coherence-Dev",
      env,
      home,
    ),
  ).toEqual({
    dir: path.join(
      "C:\\Users\\Synthetic\\OneDrive - Acme Archive\\Documents",
      "Coherence-Dev",
      "Projects",
    ),
  });
  expect(
    defaultWorkspace("C:\\Users\\Synthetic\\Documents", "Coherence", {}, home),
  ).toEqual({
    dir: path.join("C:\\Users\\Synthetic\\Documents", "Coherence", "Projects"),
  });
});
it("takes the launcher's workspace note only with its workspace, and only known notes", () => {
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", "C:\\Synthetic Data");
  vi.stubEnv(
    "SCREENSCRIBE_V2_WORKSPACE_DIR",
    "C:\\Users\\S\\Coherence Projects",
  );
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_NOTE", "onedrive");
  expect(storageLocations("C:\\Synthetic Installation").workspaceNote).toBe(
    "onedrive",
  );
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_NOTE", "anything else");
  expect(
    storageLocations("C:\\Synthetic Installation").workspaceNote,
  ).toBeUndefined();
});
