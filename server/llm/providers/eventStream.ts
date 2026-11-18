/**
 * Newline-delimited JSON (Ollama's stream), read directly from a fetch response body. Every chunk of bytes counts as
 * provider activity. `onLine` receives each non-empty line; returning true stops reading.
 */
export async function readLines(
  body: ReadableStream<Uint8Array> | null,
  onActivity: () => void,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line && onLine(line) === true) return;
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) onLine(rest);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * Server-sent events, read directly from a fetch response body. Every chunk of bytes received — comments and
 * keep-alives included — counts as provider activity, so a model that is still thinking while its server keeps the
 * connection alive is never mistaken for a stalled request (see RequestGuard). Only `data` fields matter here.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array> | null,
  onActivity: () => void,
  /** One event's data (multi-line data joined with "\n"). Returning true stops reading, e.g. at "[DONE]". */
  onEvent: (data: string) => boolean | void,
): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const dispatch = (): boolean => {
    if (!data.length) return false;
    const payload = data.join("\n");
    data = [];
    return onEvent(payload) === true;
  };
  /** Returns true when reading should stop. */
  const line = (raw: string): boolean => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return dispatch();
    if (text.startsWith(":")) return false;
    const colon = text.indexOf(":");
    if ((colon < 0 ? text : text.slice(0, colon)) === "data")
      data.push(colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, ""));
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line(text)) return;
      }
    }
    buffer += decoder.decode();
    if (buffer && line(buffer)) return;
    dispatch();
  } finally {
    // Stops the download once the answer is complete (or reading failed); harmless after the end.
    reader.cancel().catch(() => undefined);
  }
}
