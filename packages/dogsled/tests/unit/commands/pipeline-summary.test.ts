import { afterEach, describe, expect, it, vi } from 'vitest';

import { PIPELINE_SUMMARY_VERSION } from '@bobsled-inc/protocol';
import {
  buildPipelineSummaryMessage,
  createChunkProcessor,
  createPipelineSummary,
  mergeSummary,
  shouldDisplayPipelineLogLine,
} from '../../../src/commands/pipeline-summary.js';

describe('buildPipelineSummaryMessage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a versioned pipeline summary from aggregate stream stats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:00:01.500Z'));

    const summary: Parameters<typeof buildPipelineSummaryMessage>[0] = {
      startTime: new Date('2026-04-15T16:00:00.000Z').getTime(),
      streams: new Map([
        [
          'issues',
          {
            records_emitted: 5,
            rows_loaded: 5,
            api_calls: 2,
            extract_ms: 120,
            load_ms: 40,
          },
        ],
        [
          'pull_requests',
          {
            records_emitted: 2,
            rows_loaded: 0,
            api_calls: 1,
            extract_ms: 80,
            load_ms: 0,
            error: 'boom',
          },
        ],
      ]),
    };

    expect(buildPipelineSummaryMessage(summary, 'github')).toEqual({
      _v: PIPELINE_SUMMARY_VERSION,
      type: 'PIPELINE_SUMMARY',
      integration: 'github',
      elapsed_seconds: 1.5,
      total_streams: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      total_records_extracted: 7,
      total_rows_loaded: 5,
      total_api_calls: 3,
      streams: {
        issues: {
          status: 'success',
          records_extracted: 5,
          records_emitted: 5,
          rows_loaded: 5,
          api_calls: 2,
          extract_ms: 120,
          load_ms: 40,
          duration_ms: 160,
        },
        pull_requests: {
          status: 'failure',
          records_extracted: 2,
          records_emitted: 2,
          rows_loaded: 0,
          api_calls: 1,
          extract_ms: 80,
          load_ms: 0,
          duration_ms: 80,
          error: 'boom',
        },
      },
    });

    vi.useRealTimers();
  });

  it('reports an all-failure summary when every stream records an error', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:00:02.000Z'));

    const summary: Parameters<typeof buildPipelineSummaryMessage>[0] = {
      startTime: new Date('2026-04-15T16:00:00.000Z').getTime(),
      streams: new Map([
        [
          'issues',
          {
            records_emitted: 0,
            rows_loaded: 0,
            api_calls: 1,
            extract_ms: 80,
            load_ms: 0,
            error: 'extract failed',
          },
        ],
      ]),
    };

    expect(buildPipelineSummaryMessage(summary, 'github')).toMatchObject({
      _v: PIPELINE_SUMMARY_VERSION,
      type: 'PIPELINE_SUMMARY',
      integration: 'github',
      total_streams: 1,
      succeeded: 0,
      failed: 1,
      total_records_extracted: 0,
      total_rows_loaded: 0,
      total_api_calls: 1,
      streams: {
        issues: {
          status: 'failure',
          error: 'extract failed',
        },
      },
    });

    vi.useRealTimers();
  });

  it('keeps a structured resource error cause out of the public summary message', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, 'hubspot_');

    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          _v: 1,
          type: 'LOG',
          level: 'error',
          message: 'resource_error tickets',
          time: '2026-08-19T00:00:00.000Z',
          event: 'progress.resource_error',
          attributes: {
            progress_event: 'resource_error',
            resource: 'tickets',
            error: 'The provider could not complete the operation.',
            cause: {
              name: 'Error',
              message: 'HubSpot property hs_example does not exist',
              status: 400,
            },
          },
        })}\n`
      )
    );
    processor.flush();

    expect(summary.streams.get('tickets')).toMatchObject({
      error: 'The provider could not complete the operation.',
      cause: {
        name: 'Error',
        message: 'HubSpot property hs_example does not exist',
        status: 400,
      },
    });
    expect(buildPipelineSummaryMessage(summary, 'hubspot').streams.tickets).not.toHaveProperty(
      'cause'
    );
  });

  it('records a skipped resource as first-class from a resource_skip PROGRESS event', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, 'vantage_');

    // A for_each child whose parent emitted zero rows: the extractor emits a
    // resource_skip PROGRESS event and NO METRIC / loader-row line.
    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          _v: 1,
          type: 'PROGRESS',
          event: 'resource_skip',
          resource: 'costs',
          timestamp: '2026-04-24T00:00:00.000Z',
          data: {
            resource: 'costs',
            status: 'skipped',
            reason: 'for_each_parent_empty',
            for_each_parent: 'cost_reports',
          },
        })}\n`
      )
    );
    processor.flush();

    expect(summary.streams.get('costs')).toMatchObject({
      skipped: true,
      skipped_reason: 'for_each_parent_empty',
    });

    const message = buildPipelineSummaryMessage(summary, 'vantage');
    expect(message.total_streams).toBe(1);
    expect(message.succeeded).toBe(0);
    expect(message.failed).toBe(0);
    expect(message.skipped).toBe(1);
    expect(message.streams['costs']).toMatchObject({
      status: 'skipped',
      skipped_reason: 'for_each_parent_empty',
    });
  });

  it('ignores an unknown skip reason but still records the skip', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, 'acme_');

    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          _v: 1,
          type: 'PROGRESS',
          event: 'resource_skip',
          resource: 'widgets',
          timestamp: '2026-04-24T00:00:00.000Z',
          data: { resource: 'widgets', status: 'skipped', reason: 'totally_made_up' },
        })}\n`
      )
    );
    processor.flush();

    const stream = summary.streams.get('widgets');
    expect(stream?.skipped).toBe(true);
    expect(stream?.skipped_reason).toBeUndefined();
    expect(buildPipelineSummaryMessage(summary, 'acme').streams['widgets']).toMatchObject({
      status: 'skipped',
    });
  });

  it('includes embedder metrics when parsing structured stderr lines', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, 'github_');

    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          _v: 1,
          type: 'METRIC',
          stream: 'issues',
          metrics: {
            records_emitted: 3,
            embedding_api_calls: 2,
            embedding_duration_ms: 45,
          },
          time: '2026-04-24T00:00:00.000Z',
        })}\n`
      )
    );
    processor.flush();

    expect(summary.streams.get('issues')).toMatchObject({
      records_emitted: 3,
      api_calls: 2,
      extract_ms: 45,
    });
  });

  it('attributes loader rows to the structured source stream when the table is overridden', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, 'github__');

    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          level: 'info',
          event: 'raw_issues: loaded 7 rows',
          stream: 'issues',
          rowsAffected: 7,
          loadMs: 11,
        })}\n`
      )
    );
    processor.flush();

    expect(summary.streams.get('issues')).toMatchObject({
      rows_loaded: 7,
      load_ms: 11,
    });
    expect(summary.streams.has('raw_issues')).toBe(false);
  });

  it('preserves the complete generic loader error on its stream', () => {
    const summary = createPipelineSummary();
    const processor = createChunkProcessor(summary, '');
    const providerError =
      'Failed to load stream "issues" to snowflake: SQL compilation error:\n' +
      'error line 1 at position 56\n' +
      'invalid identifier "TOKEN". Run `dogsled load check --dest snowflake` to diagnose connectivity issues.';

    processor.handle(
      Buffer.from(
        `${JSON.stringify({
          level: 'error',
          event: providerError,
          ts: '2026-08-19T00:00:00.000Z',
        })}\n`
      )
    );
    processor.flush();

    expect(summary.streams.get('issues')).toMatchObject({ error: providerError });
  });

  it('preserves downstream loader errors when merging summaries', () => {
    const target = createPipelineSummary();
    target.streams.set('issues', {
      records_emitted: 5,
      rows_loaded: 5,
      api_calls: 1,
      extract_ms: 20,
      load_ms: 10,
    });

    const source = createPipelineSummary();
    source.streams.set('issues', {
      records_emitted: 0,
      rows_loaded: 0,
      api_calls: 0,
      extract_ms: 0,
      load_ms: 30,
      error: 'destination failed',
    });

    mergeSummary(target, source);

    expect(target.streams.get('issues')).toMatchObject({
      rows_loaded: 5,
      load_ms: 40,
      error: 'destination failed',
    });
  });
});

describe('shouldDisplayPipelineLogLine', () => {
  const metric =
    '{"_v":1,"type":"METRIC","stream":"orders","metrics":{"records_emitted":5},"time":"2026-04-15T16:00:00.000Z"}';
  const info =
    '{"_v":1,"type":"LOG","level":"info","message":"Completed","time":"2026-04-15T16:00:00.000Z"}';
  const error =
    '{"_v":1,"type":"LOG","level":"error","message":"Failed","time":"2026-04-15T16:00:00.000Z"}';

  it('shows every line outside quiet mode', () => {
    for (const line of [metric, info, error, 'plain text']) {
      expect(shouldDisplayPipelineLogLine(line, false)).toBe(true);
    }
  });

  it('shows only errors and unstructured lines in quiet mode', () => {
    expect(shouldDisplayPipelineLogLine(metric, true)).toBe(false);
    expect(shouldDisplayPipelineLogLine(info, true)).toBe(false);
    expect(shouldDisplayPipelineLogLine(error, true)).toBe(true);
    expect(shouldDisplayPipelineLogLine('plain text', true)).toBe(true);
  });

  it('still counts metrics that quiet mode hides', () => {
    const summary = createPipelineSummary();
    const shown: string[] = [];
    const processor = createChunkProcessor(summary, '', (line) => {
      if (shouldDisplayPipelineLogLine(line, true)) shown.push(line);
    });

    processor.handle(Buffer.from(`${metric}\n`));
    processor.flush();

    expect(shown).toEqual([]);
    expect(buildPipelineSummaryMessage(summary, 'local_files').total_records_extracted).toBe(5);
  });
});
