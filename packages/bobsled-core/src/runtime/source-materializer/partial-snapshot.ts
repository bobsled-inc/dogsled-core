import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import type {
  QueryFilterInput,
  QueryRateLimitInfo,
  QueryResourceResult,
} from '@bobsled-inc/extractor';

export interface MaterializePartialQueryOptions {
  integration: unknown;
  resource: unknown;
  filter?: QueryFilterInput;
  limit: number;
}

export type MaterializePartialRecord = Record<string, unknown>;

export interface MaterializePartialArgs {
  integration: unknown;
  resource: unknown;
  limit: number;
  filter?: QueryFilterInput;
  queryResourceImpl: (
    opts: MaterializePartialQueryOptions
  ) => Promise<QueryResourceResult<MaterializePartialRecord>>;
  writePartialImpl: (records: MaterializePartialRecord[]) => Promise<void>;
}

export interface MaterializePartialResult {
  recordCount: number;
  requestCount: number;
  limitReached: boolean;
  etag?: string;
  notModified: boolean;
  rateLimit?: QueryRateLimitInfo;
}

export function partialTableName(canonicalTable: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new CommandError(
      `partialTableName: limit must be a positive integer, got ${limit}`,
      EXIT_VALIDATION
    );
  }
  return `${canonicalTable}__limit_${limit}`;
}

export async function materializePartial(
  args: MaterializePartialArgs
): Promise<MaterializePartialResult> {
  const result = await args.queryResourceImpl({
    integration: args.integration,
    resource: args.resource,
    ...(args.filter !== undefined ? { filter: args.filter } : {}),
    limit: args.limit,
  });
  const records = result.records.slice(0, args.limit);
  await args.writePartialImpl(records);
  return {
    recordCount: records.length,
    requestCount: result.requestCount,
    limitReached: result.limitReached || result.records.length > args.limit,
    ...(result.etag !== undefined ? { etag: result.etag } : {}),
    notModified: result.notModified === true,
    ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
  };
}
