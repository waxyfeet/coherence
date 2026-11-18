/**
 * The only HTTP access destination discovery has: GET, bounded in count, through the guarded export transport
 * (endpoint policy, no redirects, credential-free errors). There is deliberately no way to send a body or another
 * method from here, so discovery cannot create, update or delete anything in a tracker.
 */
import { IntegrationError } from "../../errors";
import {
  requestJson,
  type HttpResponse,
  type ServiceInfo,
} from "../../export/http";

/** Enough for every adapter's documented calls with pagination; a runaway loop stops here. */
export const MAX_DISCOVERY_REQUESTS = 40;

export class ReadOnlyClient {
  readonly requests: { path: string; status: number }[] = [];

  constructor(
    private readonly service: ServiceInfo,
    private readonly origin: string,
    private readonly headers: Record<string, string>,
    private readonly signal?: AbortSignal,
    private readonly maxRequests = MAX_DISCOVERY_REQUESTS,
  ) {}

  /** `path` is appended to the validated origin; `allow` statuses are returned instead of thrown. */
  async get<T>(path: string, allow: number[] = []): Promise<HttpResponse<T>> {
    if (this.requests.length >= this.maxRequests)
      throw new IntegrationError(
        `${this.service.label} discovery stopped after ${this.maxRequests} read requests. Nothing was changed in ${this.service.label}.`,
      );
    const res = await requestJson<T>(this.service, `${this.origin}${path}`, {
      method: "GET",
      headers: this.headers,
      signal: this.signal,
      allowStatuses: allow,
      retries: 1,
    });
    // Paths only, so diagnostics never carry the origin's credentials or query secrets.
    this.requests.push({ path: path.split("?")[0], status: res.status });
    return res;
  }
}
