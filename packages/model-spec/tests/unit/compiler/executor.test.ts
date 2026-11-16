import { describe, expect, it, vi, beforeEach } from 'vitest';

import { executeSqlStatements } from '../../../src/compiler/executor.js';

import type { SqlRunner, SqlStatement, ExecuteCallbacks } from '../../../src/compiler/executor.js';

describe('executeSqlStatements', () => {
  let runner: SqlRunner;

  beforeEach(() => {
    runner = vi.fn<SqlRunner>().mockResolvedValue({});
  });

  it('executes all statements successfully', async () => {
    const stmts: SqlStatement[] = [
      { modelName: 'model_a', sql: 'CREATE VIEW a AS ...' },
      { modelName: 'model_b', sql: 'CREATE VIEW b AS ...' },
    ];

    const results = await executeSqlStatements(stmts, runner);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('success');
    expect(results[1]!.status).toBe('success');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('marks model as failed on runner error', async () => {
    vi.mocked(runner).mockRejectedValueOnce(new Error('SQL syntax error'));

    const stmts: SqlStatement[] = [{ modelName: 'model_a', sql: 'BAD SQL' }];

    const results = await executeSqlStatements(stmts, runner);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toBe('SQL syntax error');
  });

  it('redacts the match-key secret from driver error messages and callbacks', async () => {
    vi.stubEnv('BOBSLED_CORE_MATCH_KEY_SECRET', 'super-secret-key');
    try {
      const onError = vi.fn();
      vi.mocked(runner).mockRejectedValueOnce(
        new Error("syntax error near INSERT ... 'super-secret-key' ...")
      );
      const stmts: SqlStatement[] = [{ modelName: 'model_a', sql: 'BAD SQL' }];
      const results = await executeSqlStatements(stmts, runner, { onError });

      expect(results[0]!.error).not.toContain('super-secret-key');
      expect(results[0]!.error).toContain('***');
      const emitted = onError.mock.calls.map((call) => String(call[0])).join('\n');
      expect(emitted).not.toContain('super-secret-key');
      expect(emitted).toContain('***');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('skips downstream dependents when upstream fails', async () => {
    vi.mocked(runner).mockRejectedValueOnce(new Error('failed'));

    const stmts: SqlStatement[] = [
      { modelName: 'model_a', sql: 'SQL_A' },
      { modelName: 'model_b', sql: 'SQL_B', deps: ['model_a'] },
    ];

    const results = await executeSqlStatements(stmts, runner);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('failed');
    expect(results[1]!.status).toBe('skipped');
    expect(results[1]!.error).toContain('model_a');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('cascades skip through multi-level deps (A→B→C)', async () => {
    vi.mocked(runner).mockRejectedValueOnce(new Error('failed'));

    const stmts: SqlStatement[] = [
      { modelName: 'model_a', sql: 'SQL_A' },
      { modelName: 'model_b', sql: 'SQL_B', deps: ['model_a'] },
      { modelName: 'model_c', sql: 'SQL_C', deps: ['model_b'] },
    ];

    const results = await executeSqlStatements(stmts, runner);
    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe('failed');
    expect(results[1]!.status).toBe('skipped');
    expect(results[2]!.status).toBe('skipped');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('allows independent models to succeed when sibling fails', async () => {
    vi.mocked(runner)
      .mockResolvedValueOnce({}) // model_a succeeds
      .mockRejectedValueOnce(new Error('failed')) // model_b fails
      .mockResolvedValueOnce({}); // model_c succeeds (no deps on b)

    const stmts: SqlStatement[] = [
      { modelName: 'model_a', sql: 'SQL_A' },
      { modelName: 'model_b', sql: 'SQL_B' },
      { modelName: 'model_c', sql: 'SQL_C' },
    ];

    const results = await executeSqlStatements(stmts, runner);
    expect(results[0]!.status).toBe('success');
    expect(results[1]!.status).toBe('failed');
    expect(results[2]!.status).toBe('success');
  });

  it('case-insensitive dependency matching', async () => {
    vi.mocked(runner).mockRejectedValueOnce(new Error('failed'));

    const stmts: SqlStatement[] = [
      { modelName: 'Model_A', sql: 'SQL_A' },
      { modelName: 'model_b', sql: 'SQL_B', deps: ['model_a'] },
    ];

    const results = await executeSqlStatements(stmts, runner);
    expect(results[1]!.status).toBe('skipped');
  });

  it('returns rowCount when runner provides it', async () => {
    vi.mocked(runner).mockResolvedValueOnce({ rowCount: 42 });

    const stmts: SqlStatement[] = [{ modelName: 'model_a', sql: 'INSERT ...' }];

    const results = await executeSqlStatements(stmts, runner);
    expect(results[0]!.status).toBe('success');
    expect(results[0]!.rowsAffected).toBe(42);
  });

  it('calls callbacks correctly', async () => {
    vi.mocked(runner).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));

    const callbacks: ExecuteCallbacks = {
      onInfo: vi.fn(),
      onError: vi.fn(),
      onSuccess: vi.fn(),
    };

    const stmts: SqlStatement[] = [
      { modelName: 'model_a', sql: 'SQL_A' },
      { modelName: 'model_b', sql: 'SQL_B' },
    ];

    await executeSqlStatements(stmts, runner, callbacks);
    expect(callbacks.onInfo).toHaveBeenCalledWith('Executing model_a...');
    expect(callbacks.onSuccess).toHaveBeenCalledWith('model_a: executed.');
    expect(callbacks.onInfo).toHaveBeenCalledWith('Executing model_b...');
    expect(callbacks.onError).toHaveBeenCalledWith('model_b: execution failed — boom');
  });

  it('treats configured idempotent errors as success', async () => {
    vi.mocked(runner).mockRejectedValueOnce(new Error('Duplicate column name'));

    const callbacks: ExecuteCallbacks = {
      onInfo: vi.fn(),
      onError: vi.fn(),
      onSuccess: vi.fn(),
    };

    const stmts: SqlStatement[] = [
      {
        modelName: 'model_a',
        sql: 'ALTER TABLE t ADD COLUMN c INT',
        ignoreErrorPatterns: ['duplicate column'],
      },
    ];

    const results = await executeSqlStatements(stmts, runner, callbacks);
    expect(results[0]!.status).toBe('success');
    expect(callbacks.onInfo).toHaveBeenCalledWith(
      'model_a: ignored idempotent error matching "duplicate column"'
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  describe('beforeModel guard', () => {
    const stmts: SqlStatement[] = [
      { modelName: 'upstream', sql: 'CREATE TABLE upstream AS ...' },
      { modelName: 'derived', sql: 'DROP VIEW IF EXISTS derived', deps: ['upstream'] },
      { modelName: 'derived', sql: 'CREATE TABLE derived AS ...', deps: ['upstream'] },
      { modelName: 'leaf', sql: 'CREATE VIEW leaf AS ...', deps: ['derived'] },
    ];

    it('runs once per model, after its upstream and before its first statement', async () => {
      const events: string[] = [];
      vi.mocked(runner).mockImplementation(async (sql) => {
        events.push(`run:${sql}`);
        return {};
      });
      const beforeModel = vi.fn(async (model: string) => {
        events.push(`guard:${model}`);
        return undefined;
      });

      const results = await executeSqlStatements(stmts, runner, { beforeModel });

      expect(results.every((result) => result.status === 'success')).toBe(true);
      expect(beforeModel).toHaveBeenCalledTimes(3);
      expect(events).toEqual([
        'guard:upstream',
        'run:CREATE TABLE upstream AS ...',
        'guard:derived',
        'run:DROP VIEW IF EXISTS derived',
        'run:CREATE TABLE derived AS ...',
        'guard:leaf',
        'run:CREATE VIEW leaf AS ...',
      ]);
    });

    it('fails a model without dispatching its statements and skips dependents', async () => {
      const onError = vi.fn();
      const beforeModel = vi.fn(async (model: string) =>
        model === 'derived' ? { error: 'dry run rejected derived', exitCode: 2 } : undefined
      );

      const results = await executeSqlStatements(stmts, runner, { beforeModel, onError });

      expect(vi.mocked(runner).mock.calls.map((call) => call[0])).toEqual([
        'CREATE TABLE upstream AS ...',
      ]);
      expect(results).toEqual([
        { modelName: 'upstream', status: 'success', rowsAffected: undefined },
        { modelName: 'derived', status: 'failed', error: 'dry run rejected derived', exitCode: 2 },
        { modelName: 'leaf', status: 'skipped', error: 'Skipped: upstream "derived" failed' },
      ]);
      expect(beforeModel).not.toHaveBeenCalledWith('leaf');
      expect(onError).toHaveBeenCalledWith('derived: dry run rejected derived');
    });

    it('treats a thrown guard error as a model failure', async () => {
      const beforeModel = vi.fn(async (model: string) => {
        if (model === 'leaf') throw new Error('guard exploded');
        return undefined;
      });

      const results = await executeSqlStatements(stmts, runner, { beforeModel });

      expect(results.at(-1)).toEqual({
        modelName: 'leaf',
        status: 'failed',
        error: 'guard exploded',
      });
      expect(runner).toHaveBeenCalledTimes(3);
    });

    it('reports every remaining statement cancelled when the guard is cancelled', async () => {
      const controller = new AbortController();
      const beforeModel = vi.fn(async (model: string) => {
        if (model === 'derived') {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        return undefined;
      });

      const results = await executeSqlStatements(stmts, runner, {
        beforeModel,
        signal: controller.signal,
      });

      expect(runner).toHaveBeenCalledTimes(1);
      expect(results.map((result) => `${result.modelName}:${result.status}`)).toEqual([
        'upstream:success',
        'derived:cancelled',
        'derived:cancelled',
        'leaf:cancelled',
      ]);
    });
  });
});
