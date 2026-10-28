import { describe, expect, it, vi } from 'vitest';
import { buildDestinationCliArgs } from '../../../../src/runner/commands/destination-args.js';
import { DestinationSchema } from '../../../../src/runner/config/schema.js';

describe('pipeline destination environment declarations', () => {
  it('rejects undeclared pipeline-generated loader options before resolution', () => {
    const destination = DestinationSchema.parse({
      type: 'postgres',
      host: 'example.com',
      database: 'test',
      username: 'test',
      password: '$PG_PASSWORD',
    });
    const valueResolver = vi.fn(() => 'must-not-read');
    expect(() => buildDestinationCliArgs(destination, { valueResolver })).toThrow(
      'Add PG_PASSWORD to auth_env_vars'
    );
    expect(valueResolver).not.toHaveBeenCalled();
    expect(() =>
      buildDestinationCliArgs({ ...destination, auth_env_vars: ['PG_PASSWORD'] }, { valueResolver })
    ).not.toThrow();
    expect(valueResolver).toHaveBeenCalledWith('$PG_PASSWORD');
  });
});
