import type { Predicate } from '../framework/extractor/predicate.js';
import {
  evaluateResolvedPredicate,
  resolvePredicate,
  type ResolvedPredicate,
} from './predicates.js';
import { splitWherePushdown, type WherePushdownSplit } from './where-pushdown.js';
import type { QuerySpec } from '../framework/extractor/resource.js';

/**
 * Bookkeeping for `extract.where` across a resource extraction. Pre-resolves
 * relative durations against a single `now` so per-record evaluation is
 * allocation-free, mirrors `RecordFilterTracker`'s shape (static `from(...)`,
 * `matches()` hot path, optional empty-result warning), and decouples the
 * pushdown split from the runtime by computing both eagerly.
 *
 * Order of operations at call site:
 *   1. `pushedParams` injected into the request builder
 *   2. `record_filters` evaluated against each record (existing tracker)
 *   3. `WhereTracker.matches()` evaluated against each remaining record
 */
export class WhereTracker {
  private rejectedCount = 0;
  private constructor(
    private readonly declaredPredicates: ReadonlyArray<Predicate>,
    private readonly remainingPredicates: ReadonlyArray<ResolvedPredicate>,
    readonly pushedParams: Record<string, string | number | boolean>
  ) {}

  static from(
    predicates: ReadonlyArray<Predicate> | undefined,
    query: QuerySpec | undefined,
    now: Date
  ): WhereTracker {
    const declared = predicates ?? [];

    // Resolve every predicate's value once at run start so relative durations
    // are pinned. Resolved values feed both the pushdown split and the
    // client-side remainder, keeping the two sides consistent.
    const resolvedValues = new Map<number, unknown>();
    declared.forEach((predicate, index) => {
      const resolved = resolvePredicate(predicate, now);
      resolvedValues.set(index, resolved.value);
    });

    const split: WherePushdownSplit = splitWherePushdown(declared, query, resolvedValues);

    const remaining = split.remaining.map((predicate) => resolvePredicate(predicate, now));
    return new WhereTracker(declared, remaining, split.pushedParams);
  }

  /**
   * Returns true when every client-side remainder predicate passes. Increments
   * the rejected counter on the first failure so we can surface an
   * empty-result warning when the configuration drops everything.
   */
  matches(record: Record<string, unknown>): boolean {
    if (this.remainingPredicates.length === 0) return true;
    for (const predicate of this.remainingPredicates) {
      if (!evaluateResolvedPredicate(record, predicate)) {
        this.rejectedCount += 1;
        return false;
      }
    }
    return true;
  }

  emptyResultWarning(resourceName: string, apiCalls: number, recordCount: number): string | null {
    if (this.declaredPredicates.length === 0) return null;
    if (recordCount !== 0 || this.rejectedCount === 0 || apiCalls === 0) return null;
    const fields = [...new Set(this.declaredPredicates.map((p) => p.field))].join(', ');
    return (
      `Resource "${resourceName}" emitted 0 records: extract.where rejected ` +
      `${this.rejectedCount} records returned by the API. Check the predicates ` +
      `on fields (${fields}) against the upstream values, or push the filter ` +
      `down via resource.query.filters.<field>.compile.`
    );
  }
}
