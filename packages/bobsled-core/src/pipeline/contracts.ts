import { z } from 'zod';

import { ExtractorStateSchema } from '@bobsled-inc/extractor';
import type { SerializedErrorCause } from '@bobsled-inc/protocol';
import { buildPipelineSummaryMessage, type PipelineSummary } from '../commands/pipeline-summary.js';

import type { PipelineExecutionStage } from '../commands/pipeline.js';
import type { ResolvedPipeline } from '../runner/config/loader.js';
import type { BobsledConfig } from '../runner/config/schema.js';
import type { SpawnFunction } from '../runtime/process.js';

export const PipelineExecutionStateSchema = ExtractorStateSchema;

export type PipelineExecutionState = z.infer<typeof PipelineExecutionStateSchema>;
export type PipelineRunStatus = 'success' | 'failure' | 'cancelled';

export interface PipelineResourceMetrics {
  status: 'success' | 'failure' | 'skipped' | 'unknown';
  recordsExtracted: number;
  rowsLoaded: number;
  apiCalls: number;
  extractMs: number;
  loadMs: number;
  durationMs: number;
  error?: string;
  cause?: SerializedErrorCause;
  skippedReason?: string;
}

export interface PipelineRunMetrics {
  totalRecordsExtracted: number;
  totalRowsLoaded: number;
  totalApiCalls: number;
  resources: Record<string, PipelineResourceMetrics>;
}

export interface PipelineRunError {
  code: 'PIPELINE_FAILED' | 'RUNTIME_ERROR' | 'STATE_READ_FAILED';
  message: string;
  stage?: PipelineExecutionStage;
  resource?: string;
  cause?: SerializedErrorCause;
}

interface PipelineRunEventBase {
  sequence: number;
  timestamp: string;
  pipelineName: string;
}

export type PipelineRunEvent =
  | (PipelineRunEventBase & { type: 'run_started'; resources: string[] })
  | (PipelineRunEventBase & {
      type: 'stage_started' | 'stage_completed';
      stage: PipelineExecutionStage;
    })
  | (PipelineRunEventBase & {
      type: 'progress';
      stage: PipelineExecutionStage;
      metrics: PipelineRunMetrics;
    })
  | (PipelineRunEventBase & {
      type: 'run_completed';
      status: PipelineRunStatus;
      exitCode: number;
      metrics: PipelineRunMetrics;
    });

export type PipelineRunEventInput = PipelineRunEvent extends infer Event
  ? Event extends PipelineRunEventBase
    ? Omit<Event, keyof PipelineRunEventBase>
    : never
  : never;

export interface RunProjectPipelineOptions {
  projectRoot: string;
  pipelineName: string;
  configPath?: string;
  resources?: string[];
  fullRefresh?: boolean;
  /**
   * One-shot Snowflake schema reconciliation for the named resources. This is
   * an invocation override, not persisted pipeline configuration; callers must
   * also request an extractor full refresh so a destination truncation cannot
   * reload only an incremental slice.
   */
  reconcileSchema?: string[];
  outputDir?: string;
  logFile?: string;
  logFormat?: string;
  verbose?: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  declaredEnvNames?: readonly string[];
  /**
   * Set to `true` only when this host runs every `platform.models` profile and
   * signs in to the model provider itself. Project validation then accepts each
   * profile's own `api_key` name. Pipeline embeddings, sources, and
   * destinations keep their declaration rules. Defaults to `false`.
   */
  hostManagedModelAuth?: boolean;
  /** Cooperative cancellation signal. All active child processes are terminated and settled. */
  signal?: AbortSignal;
  /** Preview bound forwarded to the extractor's `--limit` contract. */
  maxRecords?: number;
  /** Trusted execution-only Snowflake warehouse selector for this run. */
  warehouse?: string;
  /**
   * Trusted physical warehouse for the singular materialized Snowflake destination;
   * never YAML-authored.
   */
  destinationWarehouse?: string;
  /** Trusted execution-only Snowflake query tag; never persisted to YAML. */
  queryTag?: string;
  /**
   * Invocation-local incremental state. When supplied, Bobsled Core uses an isolated
   * project-contained state backend and returns the resulting state.
   */
  state?: PipelineExecutionState;
  /** Receives immutable, ordered lifecycle and metric snapshots. */
  onEvent?: (event: PipelineRunEvent) => void;
}

export interface RunProjectPipelineDependencies {
  spawn?: SpawnFunction;
  metaUrl?: string;
  resolvePipeline?: PipelineRunProjectResolver;
}

export interface ResolvePipelineRunOptions {
  projectRoot: string;
  configPath?: string;
  pipelineName: string;
}

export interface ResolvedPipelineRunProject {
  config: BobsledConfig;
  pipeline: ResolvedPipeline;
  projectRoot: string;
  warnings: string[];
}

export type PipelineRunProjectResolver = (
  options: ResolvePipelineRunOptions,
  resolveDefault: (options: ResolvePipelineRunOptions) => Promise<ResolvedPipelineRunProject>
) => Promise<ResolvedPipelineRunProject>;

export interface RunProjectPipelineResult {
  exitCode: number;
  status: PipelineRunStatus;
  pipelineName: string;
  resources: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  metrics: PipelineRunMetrics;
  errors: PipelineRunError[];
  warnings: string[];
  state?: PipelineExecutionState;
}

export function emptyPipelineRunMetrics(): PipelineRunMetrics {
  return {
    totalRecordsExtracted: 0,
    totalRowsLoaded: 0,
    totalApiCalls: 0,
    resources: {},
  };
}

export function pipelineRunMetricsFromSummary(
  summary: PipelineSummary,
  integration: string,
  redact: (value: string) => string = (value) => value
): PipelineRunMetrics {
  const message = buildPipelineSummaryMessage(summary, integration);
  return {
    totalRecordsExtracted: message.total_records_extracted,
    totalRowsLoaded: message.total_rows_loaded,
    totalApiCalls: message.total_api_calls,
    resources: Object.fromEntries(
      Object.entries(message.streams).map(([resource, stream]) => {
        const cause = summary.streams.get(resource)?.cause;
        return [
          resource,
          {
            status: stream.status,
            recordsExtracted: stream.records_extracted,
            rowsLoaded: stream.rows_loaded,
            apiCalls: stream.api_calls,
            extractMs: stream.extract_ms,
            loadMs: stream.load_ms,
            durationMs: stream.duration_ms,
            ...(stream.error ? { error: redact(stream.error) } : {}),
            ...(cause ? { cause: structuredClone(cause) } : {}),
            ...(stream.skipped_reason ? { skippedReason: redact(stream.skipped_reason) } : {}),
          },
        ];
      })
    ),
  };
}
