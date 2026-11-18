import net from "node:net";
import { createHash } from "node:crypto";
import { ConflictError } from "../errors";

/** Kernel ownership, automatically released on crash. Never recover by unlinking a PID file. */
export async function kernelLease(
  identity: string,
  prefix = "coherence-project-",
): Promise<() => Promise<void>> {
  const name = prefix + createHash("sha256").update(identity).digest("hex");
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\" + name
      : process.platform === "linux"
        ? "\0" + name
        : undefined;
  if (!endpoint)
    throw Error("Safe storage ownership currently requires Windows or Linux.");
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: endpoint, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(() => {
    throw new ConflictError(
      "This project or profile is open in another Coherence process. Close it before continuing.",
    );
  });
  let released: Promise<void> | undefined;
  return () =>
    (released ??= new Promise((resolve) => server.close(() => resolve())));
}
