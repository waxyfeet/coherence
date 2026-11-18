import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
// Prevent an import-only test from selecting the real user's AppData profile.
process.env.SCREENSCRIBE_V2_DATA_DIR ??= fs.mkdtempSync(
  path.join(os.tmpdir(), "coherence-test-default-"),
);
process.env.SCREENSCRIBE_V2_WORKSPACE_DIR ??= `${process.env.SCREENSCRIBE_V2_DATA_DIR}-workspace`;
fs.mkdirSync(path.join(process.cwd(), ".cache", "test-temp"), {
  recursive: true,
});
// A fixture that forgets its HTTP mock must fail before contacting a real provider/tracker.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const host =
    options && typeof options === "object" && "host" in options
      ? String((options as { host: string }).host)
      : typeof args[1] === "string"
        ? args[1]
        : undefined;
  if (host && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host))
    throw new Error(
      "Offline verification blocked an external network connection.",
    );
  return Reflect.apply(connect, this, args);
} as typeof connect;
