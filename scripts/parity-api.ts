/** Isolated browser acceptance server. This helper is never imported by production code. */
import fs from "node:fs/promises";
import { createApp } from "../server/app";
import { config, ROOT_DIR } from "../server/config";
import { ensureDataDirs } from "../server/storage/projectStore";
import { setFigmaToken } from "../server/storage/settingsStore";
import { acquireInstanceLock } from "../server/storage/instanceLock";
import path from "node:path";
import { LocalAuth, makeTicket } from "../server/security/localAuth";
import { publishLaunchRecord } from "../server/security/localLauncher";
const png = await fs.readFile(
  path.join(ROOT_DIR, "samples/screens/01-login.png"),
);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (["127.0.0.1", "localhost"].includes(url.hostname))
    return realFetch(input, init);
  if (url.origin === "https://models.fixture.invalid") {
    if (
      url.pathname !== "/v1/chat/completions" ||
      new Headers(init?.headers).get("authorization") !==
        "Bearer synthetic-ui-check-token"
    )
      throw Error("Unexpected synthetic provider request");
    return Response.json({
      id: "synthetic-check",
      object: "chat.completion",
      created: 1,
      model: "UNTRUSTED-RESPONSE-MARKER",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "UNTRUSTED-RESPONSE-MARKER synthetic-ui-check-token",
            refusal: null,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  if (url.origin === "https://api.figma.com") {
    if (
      new Headers(init?.headers).get("X-Figma-Token") !==
      "synthetic-parity-token"
    )
      throw Error("Fixture credential mismatch");
    if (url.pathname.includes("/images/"))
      return Response.json({
        images: { "1:1": "https://s3-alpha-sig.figma.com/frame.png" },
      });
    const frame = {
      id: "1:1",
      name: "Parity login frame",
      type: "FRAME",
      absoluteBoundingBox: { width: 1440, height: 900 },
    };
    if (url.pathname.endsWith("/nodes"))
      return Response.json({ nodes: { "1:1": { document: frame } } });
    return Response.json({
      name: "Isolated Figma fixture",
      document: {
        children: [{ type: "CANVAS", name: "Fixture page", children: [frame] }],
      },
    });
  }
  if (url.href === "https://s3-alpha-sig.figma.com/frame.png")
    return new Response(new Uint8Array(png));
  throw Error("External network blocked by parity acceptance server");
}) as typeof fetch;
const release = await acquireInstanceLock();
await ensureDataDirs();
await setFigmaToken("synthetic-parity-token");
const auth = new LocalAuth();
const removeLaunchRecord = await publishLaunchRecord(
  auth.capability,
  config.port,
  release,
);
const server = createApp(auth).listen(config.port, config.host, () => {
  // Private parent/child IPC is test-launcher authority, never an HTTP authentication bypass.
  const origin = `http://127.0.0.1:${config.port}`;
  process.send?.({
    type: "test-session",
    session: auth.consume(makeTicket(auth.capability, origin), origin),
  });
  process.stdout.write("PARITY_API_READY\n");
});
const stop = () => {
  auth.invalidate();
  server.closeAllConnections();
  server.close(
    () =>
      void removeLaunchRecord()
        .then(release)
        .finally(() => process.exit(0)),
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
