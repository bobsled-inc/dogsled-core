import { describe, expect, it } from 'vitest';

import {
  AGENTIC_METADATA_SPELLINGS,
  LEGACY_AGENTIC_TABLE_PREFIXES,
  LEGACY_CHECKPOINT_TABLE_PREFIXES,
  LEGACY_DUCKDB_PUBLICATION_SCHEMAS,
  LEGACY_PUBLICATION_TABLE_PREFIXES,
  LEGACY_WAREHOUSE_CURSOR_TABLES,
  RESERVED_AGENTIC_COLUMN_PREFIXES,
} from '../../../src/agentic/legacy-names.js';
import { canonicalAgenticNames, currentAgenticNames } from '../../../src/agentic/metadata-names.js';

// Compatibility test: the rename never rewrites this file. These are the Dogsled-era agentic
// names that saved runs, executors and warehouses carry, which Core keeps reading.
describe('agentic names Core keeps reading', () => {
  it('lists the Dogsled-era names', () => {
    expect(AGENTIC_METADATA_SPELLINGS).toEqual({
      run_id: ['_dogsled_run_id', '_bobsled_run_id'],
      evidence: ['_dogsled_evidence', '_bobsled_evidence'],
      confidence: ['_dogsled_confidence', '_bobsled_confidence'],
      reason: ['_dogsled_reason', '_bobsled_reason'],
    });
    expect(RESERVED_AGENTIC_COLUMN_PREFIXES).toEqual(['_dogsled_', '_bobsled_', '_track_']);
    expect(LEGACY_AGENTIC_TABLE_PREFIXES).toEqual(['__dogsled_agentic_']);
    expect(LEGACY_WAREHOUSE_CURSOR_TABLES).toEqual(['__dogsled_cursors']);
    expect(LEGACY_CHECKPOINT_TABLE_PREFIXES).toEqual(['__dogsled_cp_']);
    expect(LEGACY_PUBLICATION_TABLE_PREFIXES).toEqual(['_dogsled_pub_']);
    expect(LEGACY_DUCKDB_PUBLICATION_SCHEMAS).toEqual(['_dogsled_agentic_publication']);
  });

  it('keeps the Dogsled spelling as the canonical one inside digests', () => {
    const row = { _bobsled_run_id: 'r', _dogsled_reason: null, pair_id: 'p' };
    expect(canonicalAgenticNames(row)).toEqual({
      _dogsled_run_id: 'r',
      _dogsled_reason: null,
      pair_id: 'p',
    });
  });

  it('writes rows of either generation under the current names', () => {
    const current = currentAgenticNames({ _dogsled_evidence: null, _bobsled_confidence: 1 });
    expect(Object.keys(current)).toEqual(
      Object.keys(currentAgenticNames({ _bobsled_evidence: null, _dogsled_confidence: 1 }))
    );
  });
});
