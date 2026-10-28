import { describe, expect, it } from 'vitest';

import { resolveSourceMaterializerFlags } from '../../../src/runtime/source-materializer/feature-flags.js';

describe('feature flags', () => {
  it('defaults incrementalRefresh to false', () => {
    expect(resolveSourceMaterializerFlags({}, {}).incrementalRefresh).toBe(false);
  });

  it('enables incrementalRefresh via env=1', () => {
    expect(
      resolveSourceMaterializerFlags({}, { DOGSLED_QUERY_INCREMENTAL_REFRESH: '1' })
        .incrementalRefresh
    ).toBe(true);
  });

  it('defaults partialMaterialization to false', () => {
    expect(resolveSourceMaterializerFlags({}, {}).partialMaterialization).toBe(false);
  });

  it('enables partialMaterialization via env=true', () => {
    expect(
      resolveSourceMaterializerFlags({}, { DOGSLED_QUERY_PARTIAL_MATERIALIZATION: 'true' })
        .partialMaterialization
    ).toBe(true);
  });
});
