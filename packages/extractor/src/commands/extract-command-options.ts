import {
  BATCH_FORMATS,
  type BatchFormat,
  CommandError,
  isBatchFormat,
} from '@bobsled-inc/protocol';

import type { CursorKind } from '../runtime/cursor.js';
import { parseResourceViaPair } from './default-via.js';
import type {
  ResourceInputMatrixConcurrencyMap,
  ResourceInputMatricesMap,
  ResourceInputsMap,
} from './resource-inputs.js';

export interface ExtractOptions {
  hostEnvNamesJson?: string;
  integration?: string;
  fullRefresh?: boolean;
  input?: string[];
  output?: string;
  defaultVia?: string;
  resourceVia?: Record<string, string>;
  resourceInputs?: ResourceInputsMap;
  resourceInputMatrices?: ResourceInputMatricesMap;
  resourceInputMatrixConcurrency?: ResourceInputMatrixConcurrencyMap;
  limit?: number;
  lint?: boolean;
  emitModelSpecSource?: boolean;
  embedConfigFile?: string;
  batch?: boolean;
  batchFormat?: BatchFormat;
  batchSize?: number;
  recordFilter?: (record: Record<string, unknown>) => boolean;
  sinceOverride?: string;
  untilValue?: string;
  cursorKind?: CursorKind;
  advanceState?: boolean;
  noStateWrite?: boolean;
  stateWrite?: boolean;
  timeout?: string;
  maxConsecutiveFailures?: string;
  outputDir?: string;
  plan?: string;
  stateBackend?: string;
  stateAuthEnv?: string;
  /** Where a pipeline wants the state of a file source, until its later stages have ended well. */
  stagedState?: string;
  /** Pipeline-scoped Snowflake warehouse selector (not persisted source config). */
  warehouse?: string;
  /** Trusted execution-only Snowflake query tag. */
  queryTag?: string;
}

export type ExtractCommandOptions = ExtractOptions & {
  /** Commander's camel-cased property name for `--resource-inputs-json`. */
  resourceInputsJson?: ResourceInputsMap;
  /** Commander's camel-cased property name for `--resource-input-matrices-json`. */
  resourceInputMatricesJson?: ResourceInputMatricesMap;
  /** Commander's camel-cased property name for `--resource-input-matrix-concurrency-json`. */
  resourceInputMatrixConcurrencyJson?: ResourceInputMatrixConcurrencyMap;
};

export function collectResourceVia(
  value: string,
  previous: Record<string, string>
): Record<string, string> {
  const { resource, via } = parseResourceViaPair(value);
  return { ...previous, [resource]: via };
}

export function parseBatchFormat(value: string): BatchFormat {
  if (!isBatchFormat(value)) {
    throw new CommandError(
      `Invalid batch format "${value}". Must be one of: ${BATCH_FORMATS.join(', ')}.`
    );
  }
  return value;
}
