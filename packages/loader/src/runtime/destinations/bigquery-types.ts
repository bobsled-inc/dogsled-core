import type { BigQueryTokenProvider } from '../bigquery-auth.js';
import type { LoaderLogger } from '../logger.js';

export interface BigQueryLoadJobResponse {
  status: { errors?: Array<{ message: string }> };
  statistics?: { load?: { outputRows?: string } };
}

export interface BigQueryTableLike {
  exists(): Promise<[boolean, ...unknown[]]>;
  load(
    source: string,
    metadata?: Record<string, unknown>
  ): Promise<[BigQueryLoadJobResponse, ...unknown[]]>;
  createLoadJob?(
    source: string,
    metadata?: Record<string, unknown>
  ): Promise<[BigQueryJobLike, ...unknown[]]>;
  getMetadata(): Promise<
    [
      {
        schema?: { fields?: Array<{ name: string; type: string; mode?: string }> };
        clustering?: { fields?: string[] };
        timePartitioning?: { field?: string };
        labels?: Record<string, string>;
        type?: string;
        externalDataConfiguration?: unknown;
      },
      ...unknown[],
    ]
  >;
  setMetadata(metadata: Record<string, unknown>): Promise<unknown>;
}

export interface BigQueryJobLike {
  cancel?(): Promise<unknown>;
  /** Operation completion promise supported by every real BigQuery Job. */
  promise?(): Promise<unknown>;
  getQueryResults(): Promise<[Record<string, unknown>[], ...unknown[]]>;
  /**
   * Snapshot from job creation. `getQueryResults()` does NOT refresh it, so
   * completion-only statistics are absent here; call getMetadata() afterward.
   */
  metadata?: {
    status?: { errors?: Array<{ message: string }> };
    statistics?: {
      query?: { numDmlAffectedRows?: string };
      load?: { outputRows?: string };
    };
  };
  getMetadata?(): Promise<
    [
      {
        status?: { errors?: Array<{ message: string }> };
        statistics?: {
          query?: { numDmlAffectedRows?: string };
          load?: { outputRows?: string };
        };
      },
      ...unknown[],
    ]
  >;
}

export interface BigQueryDatasetLike {
  exists(): Promise<[boolean, ...unknown[]]>;
  create(): Promise<unknown>;
  table(name: string): BigQueryTableLike;
  createQueryJob(options: {
    query: string;
    location?: string;
    labels?: Record<string, string>;
  }): Promise<[BigQueryJobLike, ...unknown[]]>;
}

export interface BigQueryClientLike {
  dataset(name: string): BigQueryDatasetLike;
  createQueryJob(options: {
    query: string;
    location?: string;
    labels?: Record<string, string>;
  }): Promise<[BigQueryJobLike, ...unknown[]]>;
}

export interface BigQueryDestinationOptions {
  projectId?: string;
  datasetId: string;
  location?: string;
  keyFilename?: string;
  credentials?: Record<string, unknown>;
  accessToken?: string;
  tokenProvider?: BigQueryTokenProvider;
  client?: BigQueryClientLike;
  stagingFormat?: 'parquet' | 'jsonl';
  tempDir?: string;
  gcsStagingBucket?: string;
  gcsStagingPrefix?: string;
  logger?: LoaderLogger;
}
