import { describe, expect, it } from 'vitest';

import {
  LEGACY_LOADED_AT_COLUMNS,
  LEGACY_OWNERSHIP_LABELS,
  LEGACY_UNIQUE_INDEX_PREFIXES,
  RESERVED_STAGING_TABLE_PREFIXES,
} from '../../src/runtime/legacy-names.js';
import { usesReservedTablePrefix } from '../../src/runtime/identifiers.js';

// Compatibility test: the rename never rewrites this file. These are the
// Dogsled-era warehouse names that existing tables carry and Core takes over.
describe('loader warehouse names Core keeps reading', () => {
  it('lists the Dogsled-era names', () => {
    expect(LEGACY_LOADED_AT_COLUMNS).toEqual(['_dogsled_loaded_at']);
    expect(LEGACY_UNIQUE_INDEX_PREFIXES).toEqual(['_dogsled_uq_']);
    expect(LEGACY_OWNERSHIP_LABELS).toEqual(['dogsled_temp_dataset']);
    expect(RESERVED_STAGING_TABLE_PREFIXES).toEqual(['_dogsled_stg_', '_bobsled_stg_']);
  });

  it.each(['_dogsled_stg_x', '_DOGSLED_STG_X', '_bobsled_stg_x', '_BOBSLED_STG_X'])(
    'reserves the staging prefix of %s',
    (name) => {
      expect(usesReservedTablePrefix(name)).toBe(true);
    }
  );

  it.each(['_source_bobsled_api', 'bobsled_api', '_bobsled_loaded_at_report'])(
    'leaves user names such as %s alone',
    (name) => {
      expect(usesReservedTablePrefix(name)).toBe(false);
    }
  );
});
