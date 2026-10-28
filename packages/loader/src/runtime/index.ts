export { readProtocol } from './protocol-reader.js';
export { RecordBuffer } from './record-buffer.js';
export type { RecordBufferOptions } from './record-buffer.js';
export { createDuckDbWriter } from './duckdb-writer.js';
export type { ConvertFileOptions, DuckDbWriter } from './duckdb-writer.js';
export { getFormatDef, OUTPUT_FORMATS } from './formats.js';
export type { FormatDef, OutputFormat } from './formats.js';
export { createDestination, GcsDestination, LocalDestination } from './destinations/index.js';
export type { FileDestination } from './destinations/index.js';
export { reverseMapDbType, sanitizeTableName } from './destinations/database.js';
export type { DatabaseDestination, LoadResult } from './destinations/database.js';
export {
  createDefaultDatabaseDestination,
  isDatabaseDestConfig,
} from '../commands/run-database-destination.js';
export type {
  CreateDatabaseDestinationOptions,
  DatabaseDestConfig,
} from '../commands/run-database-destination.js';
