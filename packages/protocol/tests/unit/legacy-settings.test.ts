import { describe, expect, it, vi } from 'vitest';

import {
  CORE_SETTING_PREFIX,
  LEGACY_CORE_SETTING_PREFIX,
  LEGACY_CORE_SETTINGS,
  unmatchedLegacySettings,
  warnLegacySettings,
} from '../../src/index.js';

const old = (name: string) => `${LEGACY_CORE_SETTING_PREFIX}${name}`;
const current = (name: string) => `${CORE_SETTING_PREFIX}${name}`;

describe('earlier Core settings', () => {
  it('reports an old setting set without its current twin, and never its value', () => {
    const env = { [old('STATE_BACKEND')]: 's3://secret-bucket' };
    expect(unmatchedLegacySettings(env)).toEqual([
      [old('STATE_BACKEND'), current('STATE_BACKEND')],
    ]);
    const warn = vi.fn();
    warnLegacySettings(warn, env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain('secret-bucket');
  });

  it('says nothing when both names are set, or only the current one', () => {
    expect(
      unmatchedLegacySettings({
        [old('OUTPUT_FORMAT')]: 'json',
        [current('OUTPUT_FORMAT')]: 'json',
      })
    ).toEqual([]);
    expect(unmatchedLegacySettings({ [current('OUTPUT_FORMAT')]: 'json' })).toEqual([]);
  });

  it('warns once per process for each name', () => {
    const env = { [old('CLI')]: 'x' };
    const warn = vi.fn();
    warnLegacySettings(warn, env);
    warnLegacySettings(warn, env);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('checks an explicit list, never any variable with the old prefix', () => {
    expect(unmatchedLegacySettings({ [old('MY_OWN_SECRET')]: 'x' })).toEqual([]);
    expect(LEGACY_CORE_SETTINGS).toContain('EXTRACTOR_ALLOW_PRIVATE_HOSTS');
  });
});
