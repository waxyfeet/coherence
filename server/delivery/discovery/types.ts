import type { DestinationSchema } from "@shared/delivery";

/** What an adapter discovers; the cache adds the schema version, fingerprint and timestamp. */
export type DiscoveryDraft = Omit<
  DestinationSchema,
  "schemaVersion" | "fingerprint" | "discoveredAt"
>;
