/**
 * Per-connection concurrency limiter. The pipeline fires many calls in parallel (Promise.all over
 * screens / use cases); this keeps the number in flight per connection at connection.concurrency.
 */
import type { LLMConnection } from "@shared/types";
import { CancelledError } from "../errors";

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Limiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private limit: number) {}

  get concurrency(): number {
    return this.limit;
  }

  /** Change the limit in place: calls already running keep their slots, waiters start if there is room. */
  setConcurrency(limit: number): void {
    this.limit = limit;
    this.drain();
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Run `fn` once a slot is free. Waiting is abandoned (CancelledError) when `signal` aborts. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new CancelledError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new CancelledError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  /** Start waiters while there is room (after a release or a raised limit). */
  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort)
        next.signal.removeEventListener("abort", next.onAbort);
      this.active += 1;
      next.resolve();
    }
  }
}

const limiters = new Map<string, { updatedAt: string; limiter: Limiter }>();

/**
 * Limiter for a connection: ONE per connection id, so jobs that resolved different saved versions of
 * the same connection still share its slots. The newest saved concurrency applies; an older snapshot
 * never switches it back.
 */
export function limiterFor(connection: LLMConnection): Limiter {
  const concurrency = Math.max(1, Math.floor(connection.concurrency || 1));
  const existing = limiters.get(connection.id);
  if (!existing) {
    const limiter = new Limiter(concurrency);
    limiters.set(connection.id, { updatedAt: connection.updatedAt, limiter });
    return limiter;
  }
  // ISO timestamps compare chronologically as strings.
  if (connection.updatedAt >= existing.updatedAt) {
    existing.updatedAt = connection.updatedAt;
    if (existing.limiter.concurrency !== concurrency)
      existing.limiter.setConcurrency(concurrency);
  }
  return existing.limiter;
}
