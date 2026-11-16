import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileStateStore,
  buildBookmarkPartition,
  getStreamBookmark,
  loadState,
  mergeDurableBookmark,
  saveState,
  setStreamBookmark,
} from '../../src/runtime/state.js';

describe('state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty state when no file exists', async () => {
    await expect(loadState(tmpDir)).resolves.toEqual({ streams: {} });
  });

  it('round-trips state correctly', async () => {
    const state = {
      streams: {
        'github/issues': {
          cursor_field: 'updated_at',
          cursor_type: 'timestamp',
          cursor_value: '2026-01-01T00:00:00Z',
          last_run_at: '2026-03-21T10:00:00Z',
          record_count: 42,
        },
      },
    };

    await saveState(tmpDir, state);
    await expect(loadState(tmpDir)).resolves.toEqual(state);
  });

  it('round-trips a document file bookmark so the next incremental run can load it', async () => {
    const state = {
      streams: {
        'files/contracts': {
          last_run_at: '2026-03-21T10:00:00Z',
          record_count: 11,
          files: {
            'sftp://sftp.example.com/contract.pdf': {
              last_modified: '2026-03-21T09:59:00.000Z',
              etag: '1774087140-3596',
              size: 3596,
              document_version_id: 'a'.repeat(64),
            },
          },
        },
      },
    };
    await saveState(tmpDir, state);
    await expect(loadState(tmpDir)).resolves.toEqual(state);
  });

  it('throws on corrupted JSON file (fail closed)', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), 'not json', 'utf-8');
    await expect(loadState(tmpDir)).rejects.toThrow('Corrupted state file');
  });

  it('throws on invalid schema in state file', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state.json'), '{"streams": "bad"}', 'utf-8');
    await expect(loadState(tmpDir)).rejects.toThrow('Corrupted state file');
  });

  it('writes atomically via FileStateStore', async () => {
    const store = new FileStateStore(tmpDir);

    await store.save({
      streams: {
        'api/users': {
          cursor_field: 'id',
          cursor_type: 'integer',
          cursor_value: '100',
          last_run_at: '2026-03-21T12:00:00Z',
          record_count: 50,
        },
      },
    });

    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['state.json']);
  });

  it('getStreamBookmark returns bookmark when present', () => {
    const state = {
      streams: {
        'api/users': {
          cursor_field: 'id',
          cursor_type: 'integer',
          cursor_value: '100',
          last_run_at: '2026-03-21',
          record_count: 50,
        },
      },
    };

    expect(getStreamBookmark(state, 'api', 'users')?.cursor_value).toBe('100');
  });

  it('setStreamBookmark adds new bookmark', () => {
    const state = { streams: {} };

    setStreamBookmark(state, 'api', 'users', {
      cursor_field: 'id',
      cursor_type: 'integer',
      cursor_value: '50',
      last_run_at: '2026-03-21',
      record_count: 10,
    });

    expect(state.streams['api/users']?.record_count).toBe(10);
  });

  it('mergeDurableBookmark persists a newer candidate', () => {
    const existing = {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: '2026-03-20T00:00:00Z',
      last_run_at: '2026-03-20T01:00:00Z',
      record_count: 5,
    };
    const candidate = {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: '2026-03-21T00:00:00Z',
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 7,
    };

    expect(mergeDurableBookmark(existing, candidate, 'timestamp', candidate.last_run_at)).toEqual(
      candidate
    );
  });

  it('mergeDurableBookmark keeps an older candidate from regressing state', () => {
    const existing = {
      cursor_field: 'id',
      cursor_type: 'integer',
      cursor_value: '100',
      last_run_at: '2026-03-20T01:00:00Z',
      record_count: 12,
    };
    const candidate = {
      cursor_field: 'id',
      cursor_type: 'integer',
      cursor_value: '50',
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 3,
    };

    expect(mergeDurableBookmark(existing, candidate, 'integer', candidate.last_run_at)).toEqual({
      ...existing,
      last_run_at: candidate.last_run_at,
    });
  });

  it('mergeDurableBookmark preserves existing bookmark on empty windows', () => {
    const existing = {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: '2026-03-20T00:00:00Z',
      last_run_at: '2026-03-20T01:00:00Z',
      record_count: 5,
    };
    const candidate = {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: undefined,
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 0,
    };

    expect(mergeDurableBookmark(existing, candidate, 'timestamp', candidate.last_run_at)).toEqual({
      ...existing,
      last_run_at: candidate.last_run_at,
    });
  });

  it('mergeDurableBookmark skips first-run empty candidates', () => {
    const candidate = {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: undefined,
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 0,
    };

    expect(
      mergeDurableBookmark(undefined, candidate, 'timestamp', candidate.last_run_at)
    ).toBeUndefined();
  });

  it('buildBookmarkPartition sorts keys and URL-encodes values for determinism', () => {
    expect(buildBookmarkPartition(undefined)).toBeUndefined();
    expect(buildBookmarkPartition({})).toBeUndefined();
    expect(buildBookmarkPartition({ owner: undefined, repo: undefined })).toBeUndefined();
    expect(buildBookmarkPartition({ owner: 'bobsled-inc', repo: 'bobsled' })).toBe(
      'owner=bobsled-inc::repo=bobsled'
    );
    // Key order is normalized — input order must not affect the key
    expect(buildBookmarkPartition({ repo: 'bobsled', owner: 'bobsled-inc' })).toBe(
      'owner=bobsled-inc::repo=bobsled'
    );
    // Embedded delimiters in values must not collide with the format
    expect(buildBookmarkPartition({ repo: 'my=repo::weird' })).toBe('repo=my%3Drepo%3A%3Aweird');
  });

  it('partition-aware getStreamBookmark + setStreamBookmark store distinct slots per iteration', () => {
    const state = { streams: {} };

    setStreamBookmark(
      state,
      'github',
      'commits',
      {
        cursor_field: 'author_date',
        cursor_type: 'timestamp',
        cursor_value: '2026-03-20T00:00:00Z',
        last_run_at: '2026-03-20T01:00:00Z',
        record_count: 5,
      },
      'owner=bobsled-inc::repo=bobsled'
    );
    setStreamBookmark(
      state,
      'github',
      'commits',
      {
        cursor_field: 'author_date',
        cursor_type: 'timestamp',
        cursor_value: '2026-03-21T00:00:00Z',
        last_run_at: '2026-03-21T01:00:00Z',
        record_count: 11,
      },
      'owner=bobsled-inc::repo=demo-repo'
    );

    // The bug this guards against: iteration 2 reading iteration 1's cursor.
    expect(
      getStreamBookmark(state, 'github', 'commits', 'owner=bobsled-inc::repo=bobsled')?.cursor_value
    ).toBe('2026-03-20T00:00:00Z');
    expect(
      getStreamBookmark(state, 'github', 'commits', 'owner=bobsled-inc::repo=demo-repo')
        ?.cursor_value
    ).toBe('2026-03-21T00:00:00Z');
    // A bare lookup without partition must not return either partitioned bookmark
    expect(getStreamBookmark(state, 'github', 'commits')).toBeUndefined();
    expect(Object.keys(state.streams).sort()).toEqual([
      'github/commits#owner=bobsled-inc::repo=bobsled',
      'github/commits#owner=bobsled-inc::repo=demo-repo',
    ]);
  });

  it('non-partitioned bookmarks keep the v1 stream key shape for back-compat', () => {
    const state = { streams: {} };
    setStreamBookmark(state, 'github', 'repos', {
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: '2026-03-21T00:00:00Z',
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 9,
    });
    expect(Object.keys(state.streams)).toEqual(['github/repos']);
    expect(getStreamBookmark(state, 'github', 'repos')?.cursor_value).toBe('2026-03-21T00:00:00Z');
  });

  it('mergeDurableBookmark persists LSN cursor type for logical replication state', () => {
    const existing = {
      cursor_field: '_commit_lsn',
      cursor_type: 'lsn' as const,
      cursor_value: '16/B374D848',
      last_run_at: '2026-03-20T01:00:00Z',
      record_count: 5,
    };
    const candidate = {
      cursor_field: '_commit_lsn',
      cursor_type: 'lsn' as const,
      cursor_value: '16/B374D849',
      last_run_at: '2026-03-21T01:00:00Z',
      record_count: 7,
    };

    expect(mergeDurableBookmark(existing, candidate, 'lsn', candidate.last_run_at)).toEqual(
      candidate
    );
  });
});
