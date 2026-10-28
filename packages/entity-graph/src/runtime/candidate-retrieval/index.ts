export type {
  Candidate,
  CandidateRetrievalInput,
  CandidateRetrievalRow,
  CandidateRetrievalStrategy,
} from './interface.js';
export { topKEquivalent, validateCandidateRetrievalRow } from './interface.js';
export { DuckDbCandidateRetrieval, buildDuckDbCandidateSql } from './duckdb.js';
export type { DuckDbCandidateOptions } from './duckdb.js';
export {
  buildPostgresCandidateSql,
  buildSnowflakeCandidateSql,
  buildBigQueryCandidateSql,
} from './dialects.js';
export { assertSafeIdentifier } from './sql-utils.js';
export {
  createCandidateRetrieval,
  type CandidateRetrievalRegistryOptions,
  type CandidateRetrievalQuery,
  type SupportedRetrievalDialect,
} from './registry.js';
