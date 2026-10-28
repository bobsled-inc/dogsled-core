import { pathToFileURL } from 'node:url';

import { CommandError } from '@bobsled-inc/protocol';
import type { FieldCoverage } from '@bobsled-inc/protocol';

import { DEFAULT_BATCH_MAX_RECORDS } from '../constants.js';
import { BatchWriter, type FinalizedBatch } from '../runtime/batch-writer.js';
import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import {
  type CursorKind,
  compareCursors,
  maxCursor,
  resolveCursorKind,
} from '../runtime/cursor.js';
import { Emitter } from '../runtime/emitter.js';
import {
  buildFilterWindows,
  compileServerFilterMcpWindowParams,
  compileServerFilterWindowParams,
  getFilterIncrementalConfig,
  getIncrementalCursorField,
  getIncrementalCursorType,
  getResourceIncrementalConfig,
  inferCursorKindFromOutput,
} from '../runtime/filter-incremental.js';
import { emitLintAndDriftWarnings } from '../runtime/lint-report.js';
import { McpExtractorClient } from '../runtime/mcp-client.js';
import { paginateMcpTool } from '../runtime/mcp-pagination.js';
import { paginate } from '../runtime/pagination.js';
import { RecordFilterTracker } from '../runtime/record-filters.js';
import {
  extractJsonPath,
  extractRecords,
  mapOutput,
  withOutputContext,
} from '../runtime/response-mapper.js';
import type { FieldMatchCollector } from '../runtime/response-mapper.js';
import { buildSchemaColumns } from '../runtime/schema-message.js';
import {
  type StateStore,
  type StreamBookmark,
  getStreamBookmark,
  mergeDurableBookmark,
  setStreamBookmark,
} from '../runtime/state.js';
import { StopWhenTracker } from '../runtime/stop-when.js';
import { WhereTracker } from '../runtime/where-tracker.js';
import type { FanOutContext } from '../runtime/for-each.js';

import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  ExtractorState,
  HttpApiResourceSpec,
} from '../types/index.js';

import type { ExtractOptions } from './extract.js';

export interface ExtractResourceResult {
  recordCount: number;
  apiCalls: number;
  batchFiles?: number;
  batchBytes?: number;
  bookmark: StreamBookmark;
  durableBookmark?: StreamBookmark;
  /** Per-output-field match telemetry — see `FieldCoverage`. */
  fieldCoverage?: Record<string, FieldCoverage>;
}

export interface ExtractResourceParams {
  integration: ApiIntegrationSpec;
  integrationName?: string;
  resource: ApiResourceSpec;
  client: ExtractorClient | McpExtractorClient;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  batchDir: string;
  opts: ExtractOptions;
  onRecord?: (record: Record<string, unknown>) => void;
  inputOverrides?: Record<string, unknown>;
  inputContext?: Record<string, unknown>;
  /** Mapped outputs of proven fan-out ancestors for contextual output fields. */
  fanOutContext?: FanOutContext;
  /** Bookmark sub-key — see `buildBookmarkPartition` for the format. */
  partition?: string;
  skipSchema?: boolean;
  skipState?: boolean;
  /**
   * Suppress the STATE protocol message while still advancing durable state.
   * The caller emits STATE later from the returned `bookmark`. Used by
   * for_each loops: a STATE per iteration forces streaming loaders to flush
   * and durably load a micro-batch per parent record, which serializes the
   * whole pipeline behind one destination load job per iteration.
   */
  deferStateEmission?: boolean;
}

export function shouldAdvanceDurableState(opts: ExtractOptions): boolean {
  const stateWriteDisabled = opts.noStateWrite === true || opts.stateWrite === false;
  return !stateWriteDisabled && opts.advanceState === true && opts.limit == null;
}

export async function extractResource({
  integration: integrationSpec,
  integrationName,
  resource,
  client,
  emitter,
  logger,
  state,
  stateStore,
  batchDir,
  opts,
  onRecord,
  inputOverrides,
  inputContext,
  fanOutContext,
  partition,
  skipSchema,
  skipState,
  deferStateEmission,
}: ExtractResourceParams): Promise<ExtractResourceResult> {
  const resolvedIntegrationName = integrationName ?? resource.integration ?? integrationSpec.name;
  if (!skipSchema) {
    await emitter.emitSchema(resource, { fullRefresh: opts.fullRefresh });
  }

  const existingBookmark = getStreamBookmark(
    state,
    resolvedIntegrationName,
    resource.name,
    partition
  );
  const incrementalConfig = getResourceIncrementalConfig(resource);
  const incrementalCursorField = getIncrementalCursorField(resource);
  const resolvedCursorKind =
    resolveCursorKind({
      explicit: opts.cursorKind,
      specCursorType: getIncrementalCursorType(resource) ?? existingBookmark?.cursor_type,
      hintValue: opts.sinceOverride ?? opts.untilValue ?? existingBookmark?.cursor_value,
    }) ?? inferCursorKindFromOutput(resource, incrementalCursorField);

  const bookmark = opts.sinceOverride
    ? {
        cursor_field: incrementalCursorField,
        cursor_value: opts.sinceOverride,
        last_run_at: new Date().toISOString(),
        record_count: 0,
      }
    : opts.fullRefresh
      ? undefined
      : existingBookmark;

  const batchWriter = opts.batch
    ? new BatchWriter({
        batchDir,
        stream: resource.name,
        maxRecords: opts.batchSize ?? DEFAULT_BATCH_MAX_RECORDS,
        compression: 'none',
        format: opts.batchFormat,
        columns: buildSchemaColumns(resource),
      })
    : null;

  let recordCount = 0;
  let apiCalls = 0;
  let batchFiles = 0;
  let batchBytes = 0;
  let bookmarkCursorValue: string | undefined;
  let firstPageRawRecords: unknown[] | undefined;

  // Per-output-field match telemetry. Records whether each top-level output
  // field's JSONPath resolved against every mapped record, so the run summary
  // can report "matched N of M" and surface a path that silently matches zero.
  const fieldCoverage = new Map<string, FieldCoverage>();
  const coverageCollector: FieldMatchCollector = {
    record(field, matched) {
      const entry = fieldCoverage.get(field) ?? { matched: 0, total: 0 };
      entry.total += 1;
      if (matched) entry.matched += 1;
      fieldCoverage.set(field, entry);
    },
  };
  let firstPageData: unknown;

  async function emitFinalizedBatch(finalized: FinalizedBatch): Promise<void> {
    await emitter.emitBatch(resource.name, finalized.encoding, [
      pathToFileURL(finalized.filePath).href,
    ]);
    batchFiles += 1;
    batchBytes += finalized.byteSize;
  }

  const isMcp = client instanceof McpExtractorClient;

  function buildMcpPageIterator(
    initialArgs?: Record<string, unknown>,
    requestInputs = inputOverrides
  ) {
    const mcpClient = client as McpExtractorClient;
    const mcpFetcher = async (argumentOverrides?: Record<string, unknown>) => {
      apiCalls += 1;
      return mcpClient.callTool({
        operation: resource as {
          input: ApiResourceSpec['input'];
          tool: NonNullable<ApiResourceSpec['tool']>;
        },
        argumentOverrides: {
          ...(initialArgs ?? {}),
          ...(argumentOverrides ?? {}),
        },
        input: requestInputs,
      });
    };
    return paginateMcpTool(resource, mcpFetcher, (message) => logger.warn(message));
  }

  async function* buildHttpPageIterator(
    initialParams?: Record<string, string | number | boolean>,
    requestInputs = inputOverrides
  ) {
    if (!resource.api) {
      throw new CommandError(
        `Resource "${resource.name}" does not define an "api" block — required for HTTP extraction.`
      );
    }
    const httpClient = client as ExtractorClient;
    const resourceApi = resource.api;
    let resolvedInputs: Readonly<Record<string, unknown>> | undefined;
    let isFirstRequest = true;
    const cursorIncremental =
      incrementalConfig?.strategy === undefined || incrementalConfig.strategy === 'cursor'
        ? incrementalConfig
        : undefined;
    const fetcher = async (
      queryParams?: Record<string, string | number | boolean>,
      url?: string
    ) => {
      const nextQueryParams: Record<string, string | number | boolean> = {
        ...(initialParams ?? {}),
        ...(queryParams ?? {}),
      };

      if (
        isFirstRequest &&
        bookmark?.cursor_value &&
        cursorIncremental?.cursor_param &&
        !opts.fullRefresh &&
        !getFilterIncrementalConfig(resource)
      ) {
        nextQueryParams[cursorIncremental.cursor_param] = bookmark.cursor_value;
      }
      isFirstRequest = false;

      apiCalls += 1;
      return httpClient.request({
        operation: { api: resourceApi, input: resource.input },
        queryParams: nextQueryParams,
        url,
        input: requestInputs,
        onResolvedInput: (input) => {
          resolvedInputs = input;
        },
      });
    };
    const pages = paginate(
      integrationSpec,
      resource as HttpApiResourceSpec,
      fetcher,
      (message) => logger.warn(message),
      { baseUrl: httpClient.getBaseUrl() }
    );
    for await (const page of pages) {
      yield { ...page, input: resolvedInputs };
    }
  }

  const cursorField = incrementalCursorField;
  const cursorPath = cursorField ? resource.output[cursorField]?.path : undefined;
  const hasUntilFilter = Boolean(opts.untilValue && cursorField && resolvedCursorKind);
  const filterConfig = getFilterIncrementalConfig(resource);

  const recordFilters = RecordFilterTracker.from(
    resource.extract.record_filters,
    inputContext ?? inputOverrides ?? {}
  );

  // Pin `now` once per run so relative-duration predicate values (e.g. "-6mo")
  // resolve consistently across pushdown params, the client-side remainder,
  // and stop_when — they all consult the same instant.
  const runStartedAtForPredicates = new Date();
  const whereTracker = WhereTracker.from(
    resource.extract.where,
    resource.query,
    runStartedAtForPredicates
  );
  const stopWhenTracker = StopWhenTracker.from(
    resource.extract.stop_when,
    runStartedAtForPredicates
  );

  function mergeBookmarkCursor(
    current: string | undefined,
    candidate: string | undefined
  ): string | undefined {
    if (!candidate) return current;
    if (!current || !resolvedCursorKind) return candidate;
    return maxCursor(current, candidate, resolvedCursorKind);
  }

  async function consumePageIterator(
    pageIterator: AsyncGenerator<{
      data: unknown;
      headers: Headers;
      records?: unknown[];
      input?: Readonly<Record<string, unknown>>;
    }>,
    requestInputs = inputOverrides
  ): Promise<{ limitReached: boolean; observedCursorValue?: string; halted?: boolean }> {
    let observedCursorValue: string | undefined;
    let pageCount = 0;
    let sourceRecordOrdinal = 0;

    for await (const page of pageIterator) {
      const resolvedInputs =
        page.input ??
        (isMcp ? (client as McpExtractorClient).resolveInput(resource.input, requestInputs) : {});
      const rawRecords = page.records ?? extractRecords(page.data, resource);
      const pageTime = new Date().toISOString();
      pageCount += 1;
      const recordsBeforePage = recordCount;
      // stop_when evaluates against records that survived mapResponse but
      // BEFORE record_filters / extract.where / opts.recordFilter run. The
      // halt decision is a property of the API stream ("the source has paged
      // past our window"), not the post-filter stream — otherwise a strict
      // `where` that drops every record on late pages hides the signal that
      // would have halted pagination, and the two primitives don't compose.
      const stopWhenSeenThisPage: Record<string, unknown>[] = [];

      if (opts.lint && !firstPageRawRecords) {
        firstPageRawRecords = rawRecords;
        firstPageData = page.data;
      }

      for (const raw of rawRecords) {
        if (opts.limit && recordCount >= opts.limit) {
          return { limitReached: true, observedCursorValue };
        }

        // The ordinal is stable within this bounded retrieval and gives
        // snapshot resources (such as Vercel's JSONL billing feed) a
        // collision-safe audit key without inventing a provider charge ID.
        const recordOrdinal = sourceRecordOrdinal;
        sourceRecordOrdinal += 1;

        const rawCursorValue = cursorPath ? extractJsonPath(raw, cursorPath) : undefined;
        const cursorValue = rawCursorValue != null ? String(rawCursorValue) : undefined;

        if (
          hasUntilFilter &&
          cursorValue &&
          compareCursors(cursorValue, opts.untilValue!, resolvedCursorKind!) > 0
        ) {
          continue;
        }

        const record = mapOutput(
          withOutputContext(raw, {
            ...(inputContext ?? {}),
            ...resolvedInputs,
            __record_ordinal__: recordOrdinal,
          }),
          resource.output,
          coverageCollector,
          fanOutContext
        );
        stopWhenSeenThisPage.push(record);
        if (!recordFilters.matches(record)) continue;
        if (!whereTracker.matches(record)) continue;
        if (opts.recordFilter && !opts.recordFilter(record)) continue;

        if (batchWriter) {
          const finalized = await batchWriter.addRecord(record);
          if (finalized) await emitFinalizedBatch(finalized);
        } else {
          await emitter.emitRecord(resource.name, record, pageTime);
        }

        onRecord?.(record);
        recordCount += 1;

        if (cursorValue) {
          observedCursorValue =
            !observedCursorValue || !resolvedCursorKind
              ? cursorValue
              : maxCursor(observedCursorValue, cursorValue, resolvedCursorKind);
        }
      }

      await logger.log(
        'info',
        `Fetched page ${pageCount}: ${resource.name}`,
        'progress.resource_page',
        {
          progress_event: 'resource_page',
          resource: resource.name,
          page: pageCount,
          records_seen: rawRecords.length,
          records_emitted: recordCount - recordsBeforePage,
          total_records_emitted: recordCount,
          api_calls: apiCalls,
          configured_limit: opts.limit ?? null,
        }
      );

      if (opts.limit && recordCount >= opts.limit) {
        return { limitReached: true, observedCursorValue };
      }

      if (stopWhenTracker?.shouldHalt(stopWhenSeenThisPage)) {
        await logger.info(
          `stop_when triggered on ${resource.name} after page ${pageCount}: ` +
            `no records on the page matched the predicate, halting pagination.`
        );
        return { limitReached: false, observedCursorValue, halted: true };
      }
    }

    return { limitReached: false, observedCursorValue };
  }

  try {
    if (filterConfig) {
      if (!cursorField || !resolvedCursorKind || resolvedCursorKind === 'lsn') {
        throw new Error(
          `filter incremental strategy requires a non-LSN typed cursor_field on resource "${resource.name}"`
        );
      }

      let effectiveSinceOverride = opts.sinceOverride;
      if (!effectiveSinceOverride && opts.fullRefresh) {
        const sinceArg = filterConfig.since_argument ?? filterConfig.filter_argument;
        if (sinceArg) {
          const inputValue = inputOverrides?.[sinceArg];
          if (
            inputValue !== undefined &&
            inputValue !== null &&
            (typeof inputValue === 'string' || typeof inputValue === 'number')
          ) {
            effectiveSinceOverride = String(inputValue);
          }
        }
      }

      const windows = buildFilterWindows({
        config: filterConfig,
        cursorKind: resolvedCursorKind,
        existingBookmarkValue: bookmark?.cursor_value,
        sinceOverride: effectiveSinceOverride,
        untilOverride: opts.untilValue,
        now: new Date(),
      });

      for (const window of windows) {
        const requestInputs = { ...inputOverrides };
        for (const [name, value] of Object.entries(window.params)) {
          if (Object.hasOwn(resource.input, name)) requestInputs[name] = value;
        }
        const pageIterator = isMcp
          ? buildMcpPageIterator(
              {
                ...whereTracker.pushedParams,
                ...compileServerFilterMcpWindowParams(resource, filterConfig, window.params),
              },
              requestInputs
            )
          : buildHttpPageIterator(
              {
                ...whereTracker.pushedParams,
                ...compileServerFilterWindowParams(resource, filterConfig, window.params),
              },
              requestInputs
            );
        const result = await consumePageIterator(pageIterator, requestInputs);
        bookmarkCursorValue = mergeBookmarkCursor(bookmarkCursorValue, result.observedCursorValue);
        if (result.limitReached || result.halted) break;
        bookmarkCursorValue = mergeBookmarkCursor(
          bookmarkCursorValue,
          window.upperBoundCursorValue
        );
      }
    } else {
      const pushed = whereTracker.pushedParams;
      const hasPushed = Object.keys(pushed).length > 0;
      const result = await consumePageIterator(
        isMcp
          ? buildMcpPageIterator(hasPushed ? { ...pushed } : undefined)
          : buildHttpPageIterator(hasPushed ? { ...pushed } : undefined)
      );
      bookmarkCursorValue = mergeBookmarkCursor(bookmarkCursorValue, result.observedCursorValue);
    }
  } finally {
    if (batchWriter) {
      const finalized = await batchWriter.flush();
      if (finalized) await emitFinalizedBatch(finalized);
      await batchWriter.close();
    }
  }

  if (opts.lint && firstPageRawRecords) {
    await emitLintAndDriftWarnings({
      resource,
      rawRecords: firstPageRawRecords,
      pageData: firstPageData,
      logger,
    });
  }

  const filterWarning = recordFilters.emptyResultWarning(resource.name, apiCalls, recordCount);
  if (filterWarning) await logger.warn(filterWarning);
  const whereWarning = whereTracker.emptyResultWarning(resource.name, apiCalls, recordCount);
  if (whereWarning) await logger.warn(whereWarning);

  const runAt = new Date().toISOString();
  const bookmarkData: StreamBookmark = {
    cursor_field: cursorField,
    cursor_type: resolvedCursorKind,
    cursor_value: bookmarkCursorValue,
    last_run_at: runAt,
    record_count: recordCount,
  };

  let durableBookmark: StreamBookmark | undefined;

  if (!skipState) {
    if (!deferStateEmission) {
      await emitter.emitState(resource.name, bookmarkData, partition);
    }
    const shouldAdvanceState = shouldAdvanceDurableState(opts);
    if (incrementalConfig && incrementalConfig.strategy !== 'full_refresh' && shouldAdvanceState) {
      durableBookmark = mergeDurableBookmark(
        existingBookmark,
        bookmarkData,
        resolvedCursorKind,
        runAt
      );
      if (durableBookmark) {
        setStreamBookmark(
          state,
          resolvedIntegrationName,
          resource.name,
          durableBookmark,
          partition
        );
        await stateStore.save(state);
      }
    } else if (
      incrementalConfig &&
      incrementalConfig.strategy !== 'full_refresh' &&
      !shouldAdvanceState &&
      opts.limit != null
    ) {
      await logger.warn(
        `Limited run (${opts.limit} records): skipping durable state advancement because --limit runs are preview-only.`
      );
    }
  }

  return {
    recordCount,
    apiCalls,
    ...(batchWriter ? { batchFiles, batchBytes } : {}),
    bookmark: bookmarkData,
    durableBookmark,
    ...(fieldCoverage.size > 0 ? { fieldCoverage: Object.fromEntries(fieldCoverage) } : {}),
  };
}

export type { CursorKind };
