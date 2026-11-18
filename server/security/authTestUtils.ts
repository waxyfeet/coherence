/** Test-only trusted launcher. Never imported by the production app or launcher. */
import { LocalAuth, makeTicket } from "./localAuth";
export async function authenticatedTestApp() {
  const { createApp } = await import("../app");
  const origins: string[] = [];
  const auth = new LocalAuth({ origins });
  const headers = new Map<string, string>();
  return {
    app: createApp(auth),
    authenticate(base: string) {
      base = new URL(base).origin;
      const aliases = [base];
      for (const origin of aliases) {
        origins.push(origin);
        const session = auth.consume(
          makeTicket(auth.capability, origin),
          origin,
        )!;
        headers.set(origin, `Bearer ${session.token}`);
      }
    },
    authorization(origin: string) {
      return headers.get(origin)!;
    },
    fetch(input: string | URL, init?: RequestInit) {
      const token = headers.get(new URL(input).origin);
      const requestHeaders = new Headers(init?.headers);
      if (token) requestHeaders.set("Authorization", token);
      return globalThis.fetch(input, { ...init, headers: requestHeaders });
    },
  };
}
