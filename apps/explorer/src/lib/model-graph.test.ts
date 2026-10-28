import { describe, expect, it } from 'vitest';

import { buildModelGraph } from './model-graph';

describe('buildModelGraph', () => {
  it('matches file paths by exact basename instead of substring overlap', () => {
    const { nodes } = buildModelGraph({
      files: [{ path: 'models/preorder.sql' }, { path: 'models/order.sql' }],
      marts: [],
      sources: [{ name: 'order' }],
      staging: [],
    });

    expect(nodes).toEqual([
      {
        id: 'order',
        label: 'order',
        layer: 'source',
        filePath: 'models/order.sql',
      },
    ]);
  });
});
