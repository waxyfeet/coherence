/** Run the unchanged prototype assertions on a test-owned built app, never an owner service. */
import { spawn } from "node:child_process";
import net from "node:net";
import { authenticatedFixture } from "./authenticated-fixture.mjs";

const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const fixture = await authenticatedFixture(port);
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-prototype.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PROTOTYPE_ORIGIN: fixture.origin },
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code) process.exitCode = code;
} finally {
  fixture.stop();
}
