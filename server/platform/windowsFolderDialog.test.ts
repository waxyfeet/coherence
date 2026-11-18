import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: processMock.spawn }));
import { FOLDER_DIALOG_SCRIPT, windowsFolderDialog } from "./outputFolder";

let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.useFakeTimers();
  // These cases check the PowerShell dialog; server/platform/nativeHelper.test.ts covers the native helper.
  vi.stubEnv("SCREENSCRIBE_V2_PLATFORM_HELPER", "");
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  processMock.spawn.mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
function respond(value: unknown) {
  child.stdout.write(JSON.stringify(value));
  child.emit("close", 0);
}
it("uses a fixed STA script and sends Unicode/untrusted-looking paths only through JSON stdin", async () => {
  const initial = 'C:\\Synthetic\\résumé\"; Write-Output SYNTHETIC; #';
  const pending = windowsFolderDialog(initial, new AbortController().signal);
  const [executable, args, options] = processMock.spawn.mock.calls[0];
  expect(executable).toBe("powershell.exe");
  expect(args).toContain("-STA");
  expect(args).not.toContain(initial);
  expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toBe(
    FOLDER_DIALOG_SCRIPT,
  );
  expect(FOLDER_DIALOG_SCRIPT.indexOf("$owner.Show()")).toBeLessThan(
    FOLDER_DIALOG_SCRIPT.indexOf("$dialog.ShowDialog($owner)"),
  );
  expect(FOLDER_DIALOG_SCRIPT).toContain("$owner.TopMost = $true");
  expect(FOLDER_DIALOG_SCRIPT).not.toContain("$dialog.ShowDialog()");
  expect(FOLDER_DIALOG_SCRIPT).toContain("$owner.Dispose()");
  expect(options).toMatchObject({
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  expect(JSON.parse(child.stdin.read().toString())).toEqual({
    initialPath: initial,
    description: "Choose a Coherence project folder",
  });
  respond({ path: initial });
  expect(await pending).toBe(initial);
  expect(vi.getTimerCount()).toBe(0);
});
it("returns null when the user cancels, without killing a successfully closed helper", async () => {
  const pending = windowsFolderDialog(
    "C:\\Synthetic",
    new AbortController().signal,
  );
  respond({ path: null });
  expect(await pending).toBeNull();
  expect(child.kill).not.toHaveBeenCalled();
});
it("aborts the native helper on client cancellation and removes its listener", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = windowsFolderDialog("C:\\Synthetic", controller.signal);
  const failure = expect(pending).rejects.toMatchObject({ status: 408 });
  controller.abort();
  await failure;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
it("times out an abandoned dialog without leaking helper errors", async () => {
  const pending = windowsFolderDialog(
    "C:\\Synthetic",
    new AbortController().signal,
  );
  const failure = expect(pending).rejects.toMatchObject({
    status: 408,
    code: "FOLDER_CHOOSER_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(120_000);
  await failure;
  expect(child.kill).toHaveBeenCalledOnce();
});
it.each(["error", "nonzero", "malformed", "oversized"])(
  "sanitizes %s helper failure",
  async (kind) => {
    const pending = windowsFolderDialog(
      "C:\\Synthetic",
      new AbortController().signal,
    );
    const failure = expect(pending).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining("SYNTHETIC_PRIVATE_MARKER"),
    });
    if (kind === "error")
      child.emit("error", Error("SYNTHETIC_PRIVATE_MARKER"));
    else if (kind === "nonzero") child.emit("close", 1);
    else if (kind === "oversized")
      child.stdout.write("SYNTHETIC_PRIVATE_MARKER".repeat(1000));
    else {
      child.stdout.write("SYNTHETIC_PRIVATE_MARKER");
      child.emit("close", 0);
    }
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  },
);
