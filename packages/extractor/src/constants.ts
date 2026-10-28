/**
 * Shared constants used by both schemas and runtime.
 */

import type { CursorType } from './framework/core/index.js';

export { CursorTypeValues as CURSOR_KINDS } from './framework/core/index.js';
export type CursorKind = CursorType;

/** Default JSONPath for extracting records from API responses. */
export const DEFAULT_RECORD_PATH = '$';

/** Default maximum records per batch file. */
export const DEFAULT_BATCH_MAX_RECORDS = 10_000;
