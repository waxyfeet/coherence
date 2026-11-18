import {
  SESSION_STORAGE_KEY,
  SESSION_REQUIRED_EVENT,
  SESSION_CHANGED_EVENT,
  isLiteralLoopbackOrigin,
  type BrowserSession,
} from "../shared/localAuth";

export function browserSession(): BrowserSession | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem(SESSION_STORAGE_KEY) ?? "null",
    ) as BrowserSession | null;
    if (
      value &&
      /^[a-f0-9]{64}$/.test(value.token) &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now()
    )
      return value;
  } catch {
    /* Storage may be disabled; fail closed and show recovery instructions. */
  }
}
export function requireSession(): void {
  window.dispatchEvent(new Event(SESSION_REQUIRED_EVENT));
}
export async function sessionFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!isLiteralLoopbackOrigin(window.location.origin)) {
    requireSession();
    throw Error(
      "Reopen the verified 127.0.0.1 session using the local launcher. Hostname sessions cannot be reconnected here.",
    );
  }
  // Never forward the local credential to provider URLs, redirects or arbitrary Markdown images.
  const url = new URL(path, window.location.origin);
  if (
    url.origin !== window.location.origin ||
    !url.pathname.startsWith("/api/") ||
    url.username ||
    url.password
  )
    throw Error("Only local Coherence API paths can use this session.");
  const session = browserSession();
  if (!session) {
    requireSession();
    throw Error(
      "Reopen Coherence using the local launcher, then reconnect this tab.",
    );
  }
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${session.token}`);
  const response = await fetch(url.pathname + url.search, {
    ...options,
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  // A reply from an old in-flight request must not invalidate a newly launched session.
  if (response.status === 401 && browserSession()?.token === session.token)
    requireSession();
  return response;
}
export async function checkSession(): Promise<boolean> {
  if (!isLiteralLoopbackOrigin(window.location.origin)) return false;
  if (!browserSession()) return false;
  try {
    const response = await sessionFetch("/api/auth/session");
    if (!response.ok) return false;
    window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export async function downloadPrivate(
  path: string,
  fallback: string,
): Promise<void> {
  const response = await sessionFetch(path);
  if (!response.ok)
    throw Error(
      "The download could not be authorized. Reconnect your local session and try again.",
    );
  const blob = URL.createObjectURL(await response.blob());
  const name =
    /filename="([^"/\\]+)"/.exec(
      response.headers.get("Content-Disposition") ?? "",
    )?.[1] ?? fallback;
  const link = document.createElement("a");
  link.href = blob;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}

/** SSE over authenticated fetch. No credentials in stream URLs, and reconnects never replay mutations. */
export class SessionEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private paused = false;
  private resume = () => {
    if (this.paused && !this.closed) {
      this.paused = false;
      void this.connect();
    }
  };
  constructor(private path: string) {
    window.addEventListener(SESSION_CHANGED_EVENT, this.resume);
    void this.connect();
  }
  close() {
    this.closed = true;
    this.controller.abort();
    window.removeEventListener(SESSION_CHANGED_EVENT, this.resume);
    clearTimeout(this.timer);
  }
  private async connect() {
    try {
      const attemptToken = browserSession()?.token;
      const response = await sessionFetch(this.path, {
        signal: this.controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        if (response.status === 401) {
          if (
            browserSession()?.token &&
            browserSession()?.token !== attemptToken
          ) {
            void this.connect();
            return;
          }
          this.paused = true;
          return;
        }
        throw Error("Stream unavailable");
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      try {
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + value).replace(/\r\n/g, "\n");
          let boundary: number;
          while (!this.closed && (boundary = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) this.onmessage?.({ data });
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      /* Errors intentionally contain no headers, response bodies or credentials. */
    }
    if (!this.closed && !browserSession()) this.paused = true;
    if (!this.closed && !this.paused) {
      this.onerror?.();
      this.timer = setTimeout(() => {
        void this.connect();
      }, 5000);
    }
  }
}
