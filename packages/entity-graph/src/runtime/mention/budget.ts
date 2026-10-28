/**
 * Per-source rate limiter for mention extraction.
 *
 * Token bucket per integration handle. Default 60 rpm prevents one
 * Confluence resource's 50K-page corpus from burning the whole project's
 * AI budget. Wraps `enforceBudget` from @bobsled-inc/ai for per-call +
 * per-project-per-day ceilings.
 */

import { CommandError } from '@bobsled-inc/protocol';

export interface RateLimitOptions {
  perSourceRpm: number;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

export class PerSourceRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; refilledAt: number }>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    if (!Number.isInteger(options.perSourceRpm) || options.perSourceRpm <= 0) {
      throw new CommandError(
        `perSourceRpm must be a positive integer; got ${options.perSourceRpm}.`,
        2
      );
    }
    this.capacity = options.perSourceRpm;
    this.now = options.now ?? Date.now;
  }

  /**
   * Throws `CommandError(2)` for input-validation failures (non-positive /
   * non-integer `tokens`) and `CommandError(1)` for runtime failures (the
   * bucket is empty for `sourceHandle`). Per AGENTS.md exit codes:
   * 1 = runtime, 2 = validation.
   */
  consume(sourceHandle: string, tokens = 1): void {
    // Validation guard — non-positive / non-integer requests would
    // INCREASE the bucket past capacity. Validation failure → exit code 2.
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new CommandError(
        `consume(tokens=${tokens}) requires a positive integer; refusing to mutate bucket.`,
        2
      );
    }
    const t = this.now();
    let bucket = this.buckets.get(sourceHandle);
    if (!bucket) {
      bucket = { tokens: this.capacity, refilledAt: t };
      this.buckets.set(sourceHandle, bucket);
    }
    // Refill: clamp elapsedMs to >= 0 so a wall-clock that moves
    // backward (NTP correction, suspend/resume) doesn't silently drain
    // the bucket.
    const elapsedMs = Math.max(0, t - bucket.refilledAt);
    const refill = (elapsedMs / 60_000) * this.capacity;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.refilledAt = t;
    if (bucket.tokens < tokens) {
      // Empty bucket is a runtime condition, not user-input invalid.
      throw new CommandError(
        `per_source_rpm exceeded for source '${sourceHandle}' (capacity=${this.capacity} rpm). ` +
          `Wait or raise platform.budget.per_source_rpm.`,
        1
      );
    }
    bucket.tokens -= tokens;
  }
}
