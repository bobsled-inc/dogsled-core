import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';
import { handleRunError } from '../../../src/commands/run-errors.js';

describe('handleRunError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('emits a multiline failure as one valid JSONL error event', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    handleRunError(
      new Error(
        'Failed to load stream "issues" to snowflake: SQL compilation error:\n' +
          'error line 1 at position 56\n' +
          'invalid identifier "TOKEN". Run `bobsled load check --dest snowflake` to diagnose connectivity issues.'
      ),
      'json'
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? '')).toMatchObject({
      level: 'error',
      event:
        'Failed to load stream "issues" to snowflake: SQL compilation error:\n' +
        'error line 1 at position 56\n' +
        'invalid identifier "TOKEN". Run `bobsled load check --dest snowflake` to diagnose connectivity issues.',
    });
    expect(process.exitCode).toBe(1);
  });

  it('preserves controlled validation exit codes in JSON mode', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    handleRunError(new CommandError('invalid schema', 2), 'json');

    expect(process.exitCode).toBe(2);
  });
});
