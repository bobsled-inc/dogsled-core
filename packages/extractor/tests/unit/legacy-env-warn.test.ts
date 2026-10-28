import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetLegacyEnvWarnings,
  warnLegacyEnvField,
} from '../../src/framework/core/legacy-env-warn.js';

describe('warnLegacyEnvField', () => {
  afterEach(() => {
    resetLegacyEnvWarnings();
    vi.restoreAllMocks();
  });

  it('points Snowflake and BigQuery fields at their unsuffixed replacement', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnLegacyEnvField('warehouse_env');
    expect(write).toHaveBeenCalledWith(expect.stringContaining('use "warehouse"'));
  });

  it('stays silent for database fields that have no replacement', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const field of ['host_env', 'username_env', 'password_env']) {
      warnLegacyEnvField(field);
    }
    expect(write).not.toHaveBeenCalled();
  });
});
