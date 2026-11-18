/** Test-only preload: production storage acceptance may use loopback and local kernel leases only. */
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let value = args[0];
  if (Array.isArray(value)) value = value[0];
  const host =
    typeof value === "object"
      ? value.host
      : typeof args[1] === "string"
        ? args[1]
        : undefined;
  if (host && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw Error("External network prohibited by storage fixture");
  return connect.apply(this, args);
};
syncBuiltinESMExports();
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("External network prohibited by storage fixture");
  return fetch(input, init);
};
