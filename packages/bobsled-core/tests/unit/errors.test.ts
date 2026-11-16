import { describe, expect, it } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';

describe('CommandError', () => {
  it('stores message and exit code', () => {
    const error = new CommandError('not found', 127);

    expect(error.message).toBe('not found');
    expect(error.exitCode).toBe(127);
    expect(error.name).toBe('CommandError');
  });

  it('defaults exit code to 2', () => {
    const error = new CommandError('failed');

    expect(error.exitCode).toBe(2);
  });

  it('is an instance of Error', () => {
    const error = new CommandError('test');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CommandError);
  });
});
