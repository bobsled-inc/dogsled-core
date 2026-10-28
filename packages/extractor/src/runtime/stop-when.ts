import { stopWhenAsPredicate, type StopWhen } from '../framework/extractor/stop-when.js';
import {
  evaluateResolvedPredicate,
  resolvePredicate,
  type ResolvedPredicate,
} from './predicates.js';

/**
 * Bookkeeping for `extract.stop_when`. After each page is mapped, if every
 * record on the page failed the predicate, halt pagination.
 *
 * IMPORTANT — composition with `extract.where`:
 * Callers must feed `shouldHalt` records that survived `mapResponse` but NOT
 * records filtered out by `extract.where` / `record_filters` / user
 * `recordFilter`. The halt decision is a property of the API stream ("the
 * source has paginated past our window of interest"), and where-style
 * filters are a downstream client-side concern. If we evaluated against
 * post-filter records, a strict `where` that drops every record on the late
 * pages would hide the signal that should halt pagination, and `where` +
 * `stop_when` would not compose for "rolling N-day window" use cases.
 *
 * Empty pages do not trigger halt — only a non-empty page where every
 * record failed.
 *
 * `requires_sort` is validated at schema parse time; this runtime only sees
 * the resolved predicate. Calling `shouldHalt` with an empty page-records
 * array is a no-op (returns false).
 */
export class StopWhenTracker {
  private constructor(private readonly predicate: ResolvedPredicate) {}

  static from(stopWhen: StopWhen | undefined, now: Date): StopWhenTracker | undefined {
    if (!stopWhen) return undefined;
    return new StopWhenTracker(resolvePredicate(stopWhenAsPredicate(stopWhen), now));
  }

  /**
   * Returns true when every record on `pageRecords` fails the predicate AND
   * the page was non-empty. An empty page typically means the API has nothing
   * left to return — that's a "stop" but should be signaled by pagination
   * exhaustion, not by stop_when (we never want to halt when we haven't seen
   * any data to make the decision against).
   */
  shouldHalt(pageRecords: ReadonlyArray<Record<string, unknown>>): boolean {
    if (pageRecords.length === 0) return false;
    for (const record of pageRecords) {
      if (evaluateResolvedPredicate(record, this.predicate)) {
        return false;
      }
    }
    return true;
  }
}
