import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import type { LLMConnection } from "../../shared/types";

export const SYNTHETIC_KEY = "synthetic-reliability-fixture-not-a-real-key";
export const MODEL = "nvidia/nemotron-3.5-super-vl:free";
let sequence = 0;
export function connection(extra: Partial<LLMConnection> = {}): LLMConnection {
  return {
    id: `conn_reliability_${++sequence}`,
    name: "Synthetic reliability fixture",
    provider: "openai-compatible",
    model: MODEL,
    apiKey: SYNTHETIC_KEY,
    concurrency: 2,
    requestTimeoutSec: 5,
    structuredOutput: "auto",
    vision: "yes",
    refusalFallback: false,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...extra,
  };
}

// All request bodies here belong to disposable, explicitly synthetic loopback fixtures.
export interface Seen {
  url: string;
  method: string;
  body: Record<string, any>;
  syntheticAuth: boolean;
}
export const servers: http.Server[] = [];
export async function serve(
  handler: (
    request: Seen,
    response: http.ServerResponse,
    index: number,
  ) => void,
) {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const seen: Seen = {
        url: req.url ?? "",
        method: req.method ?? "",
        body: raw ? JSON.parse(raw) : {},
        syntheticAuth: [
          req.headers.authorization,
          req.headers["x-api-key"],
          req.headers["x-goog-api-key"],
        ].some((h) => h === SYNTHETIC_KEY || h === `Bearer ${SYNTHETIC_KEY}`),
      };
      requests.push(seen);
      handler(seen, res, requests.length - 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
export async function closeServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
export function completion(
  text: string,
  finish = "stop",
  usage: Record<string, unknown> = {
    prompt_tokens: 100,
    completion_tokens: 50,
  },
) {
  return {
    id: "synthetic-completion",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finish,
      },
    ],
    usage,
  };
}
export function geminiReply(text: string, finishReason = "STOP") {
  return {
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason },
    ],
    modelVersion: "gemini-3.5-flash-lite",
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
    },
  };
}
export async function evidence(name: string, records: unknown) {
  await fs.mkdir("artifacts/provider-reliability", { recursive: true });
  await fs.writeFile(
    `artifacts/provider-reliability/${name}.json`,
    JSON.stringify(
      {
        source:
          "Deterministic synthetic characterization of unchanged production code; not model inference or remediation acceptance.",
        externalRequests: 0,
        records,
      },
      null,
      2,
    ) + "\n",
  );
}
