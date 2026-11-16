import { describe, expect, it, vi } from 'vitest';

import { renameLegacyMetadataColumns } from '../../../src/agentic/metadata-columns.js';
import {
  AGENTIC_METADATA_NAMES,
  agenticMetadataSpellings,
} from '../../../src/agentic/metadata-names.js';

// Uses the real spellings list, so it holds before and after the rename flips the current names.
const reason = AGENTIC_METADATA_NAMES.reason;
const earlier = agenticMetadataSpellings('reason').find((name) => name !== reason)!;

describe('an agentic target with both generations of a metadata column', () => {
  it('stops with an error naming both columns, and renames nothing', async () => {
    const rename = vi.fn();
    const columns = [{ column_name: 'pair_id' }, { column_name: earlier }, { column_name: reason }];
    await expect(
      renameLegacyMetadataColumns(
        columns,
        [{ name: 'pair_id' }, { name: reason }],
        (name) => name,
        rename,
        'main.pairs'
      )
    ).rejects.toThrow(
      `Agentic target main.pairs has both \`${earlier}\` and \`${reason}\`; keep the one with your data and drop the other.`
    );
    expect(rename).not.toHaveBeenCalled();
    expect(columns.map((column) => column.column_name)).toEqual(['pair_id', earlier, reason]);
  });

  it('matches the two spellings whatever case the warehouse reports', async () => {
    const columns = [{ column_name: earlier.toUpperCase() }, { column_name: reason.toUpperCase() }];
    await expect(
      renameLegacyMetadataColumns(
        columns,
        [{ name: reason }],
        (name) => name.toUpperCase(),
        vi.fn(),
        'T'
      )
    ).rejects.toThrow(/has both/);
  });

  it('still renames a target that has only the earlier column', async () => {
    const rename = vi.fn();
    const columns = [{ column_name: earlier }];
    await renameLegacyMetadataColumns(columns, [{ name: reason }], (name) => name, rename, 'T');
    expect(rename).toHaveBeenCalledWith(earlier, reason);
  });
});
