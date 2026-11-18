import ipaddr from "ipaddr.js";
import type { Connection } from "./data";

export type ConnectionFilter = "all" | "cloud" | "local";

// Presentation only: no DNS requests, routing decisions or security authority.
// Compatible gateways may be remote cloud services or local/LAN model servers.
export function matchesConnectionFilter(
  c: Connection,
  filter: ConnectionFilter,
): boolean {
  if (filter === "all") return true;
  if (c.provider === "mock") return false;
  let local = c.provider === "ollama" || c.provider === "lmstudio";
  if (c.provider === "compatible") {
    try {
      const host = new URL(c.endpoint).hostname.replace(/^\[|\]$/g, "");
      local =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local");
      if (ipaddr.isValid(host)) {
        const range = ipaddr.process(host).range();
        local = ["loopback", "private", "linkLocal", "uniqueLocal"].includes(
          range,
        );
      }
    } catch {
      /* An unfinished address remains visible in All and Cloud. */
    }
  }
  return filter === "local" ? local : !local;
}
