import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { BadRequestError } from "../errors";

export type AddressPolicy = "public" | "configured" | "loopback" | "lan";

/** Normalize mapped IPv6 before classifying; transition/link-local/metadata ranges are not endpoints. */
export function permitsAddress(
  address: string,
  policy: AddressPolicy,
): boolean {
  try {
    const range = ipaddr.process(address.replace(/^\[|\]$/g, "")).range();
    if (policy === "public") return range === "unicast";
    if (policy === "loopback") return range === "loopback";
    const local = ["private", "uniqueLocal", "loopback"].includes(range);
    return local || (policy === "configured" && range === "unicast");
  } catch {
    return false;
  }
}

function blocked(): BadRequestError {
  return new BadRequestError(
    "The endpoint resolves to a network address that is not allowed for this connection. Use a loopback/private LAN model address or a secure approved endpoint; link-local, metadata and reserved destinations are blocked.",
  );
}

type Resolver = (host: string) => Promise<LookupAddress[]>;

/** Runs inside the socket connector: the validated addresses are the ones actually used, without a second DNS lookup. */
export function guardedLookup(
  policy: AddressPolicy,
  resolve: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (
          !addresses.length ||
          addresses.some((a) => !permitsAddress(a.address, policy))
        ) {
          callback(blocked(), "", 0);
          return;
        }
        const selected = options.family
          ? addresses.filter((a) => a.family === options.family)
          : addresses;
        if (!selected.length) {
          callback(blocked(), "", 0);
          return;
        }
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      },
      () =>
        callback(
          new Error(
            "Endpoint DNS lookup failed. Check the endpoint and connectivity.",
          ),
          "",
          0,
        ),
    );
  };
}

const agents = new Map<AddressPolicy, Agent>();

export function outboundDispatcher(url: URL, policy: AddressPolicy): Agent {
  // Literal IP connections bypass lookup() in Node, so guard them here as well.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !permitsAddress(host, policy)) throw blocked();
  let agent = agents.get(policy);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup(policy), rejectUnauthorized: true },
      // Provider RequestGuard remains responsible for long/local inference timeouts.
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    agents.set(policy, agent);
  }
  return agent;
}

/** Image URLs are untrusted remote output, unlike an endpoint deliberately entered by the owner. */
export function figmaImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError("Figma returned an invalid image destination.");
  }
  const allowed = new Set([
    "s3-alpha-sig.figma.com",
    "s3-alpha.figma.com",
    "figma-alpha-api.s3.us-west-2.amazonaws.com",
    "figma-alpha-api.s3-us-west-2.amazonaws.com",
    "figma-alpha-api.s3.amazonaws.com",
  ]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !allowed.has(url.hostname)
  )
    throw new BadRequestError(
      "Figma returned an unapproved image destination. No download was made.",
    );
  return url;
}
