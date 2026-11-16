export {
  buildReverseEtlActionFromSpec,
  buildSalesforceUpsertAction,
  pruneUnmappedOptionalInputs,
  type BuildReverseEtlActionOptions,
  type BuildSalesforceUpsertActionOptions,
} from '../reverse-etl/build-action.js';
export { buildCursorQuery, type CursorQuery, type CursorQueryInput } from './cursor-query.js';
export { stableJson, syncNamespace } from './idempotency.js';
export {
  runBatchActions,
  type BatchActionRecord,
  type BatchActionResult,
} from './run-batch-actions.js';
export { runSync, resolveAction, validateInputMapping, type RunSyncOptions } from './run.js';
export {
  loadSyncSpec,
  listSyncSpecs,
  parseSyncSpecFile,
  SyncSpecSchema,
  type LoadedSyncSpec,
  type SyncSpec,
} from './spec.js';
export {
  FileSyncStateStore,
  truncatePayloadSnapshot,
  type Lease,
  type SyncActionIdempotencyClaim,
  type SyncActionIdempotencyClaimResult,
  type SyncCheckpoint,
  type SyncDeadLetter,
  type SyncReceipt,
  type SyncRunSummary,
  type SyncStateStore,
} from './state-store.js';
