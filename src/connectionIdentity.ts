import type { Connection } from "./data";

/** In-memory request ownership only. Never log or persist this value: it may contain a typed key. */
export const catalogueIdentity = (c: Connection) =>
  JSON.stringify([
    c.id,
    c.provider,
    c.endpoint,
    c.apiKey,
    c.keyPresent,
    c.azureVersion,
  ]);
