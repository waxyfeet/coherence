import { afterEach, expect, it, vi } from "vitest";

// Simulates a blocked native library: loading the package fails as ERR_DLOPEN_FAILED does.
const library = vi.hoisted(() => ({ blocked: true }));
vi.mock("sharp", () => {
  if (library.blocked)
    throw Object.assign(
      new Error("The specified module could not be found. C:\\private\\x.dll"),
      { code: "ERR_DLOPEN_FAILED" },
    );
  return { default: () => "a sharp pipeline" };
});
afterEach(() => vi.restoreAllMocks());

it("turns an image library that cannot load into a plain 503 and tries again on the next use", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { loadSharp } = await import("./sharpLoader");
  await expect(loadSharp()).rejects.toMatchObject({
    status: 503,
    code: "IMAGES_UNAVAILABLE",
    message: expect.stringContaining("Reinstall Coherence"),
  });
  // sharp itself rethrows a load failure as a plain Error with instructions: only its class is logged.
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(/^\[images\] The image library could not load: \w/),
  );
  expect(String(log.mock.calls)).not.toMatch(/private|specified module/);

  library.blocked = false;
  vi.resetModules();
  const sharp = await loadSharp();
  expect(sharp(Buffer.alloc(0))).toBe("a sharp pipeline");
});
