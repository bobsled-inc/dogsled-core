import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverTruthsetSpecs,
  loadTruthsetLabels,
  resolveTruthsetSpec,
} from '../../../../src/compiler/truthset/parser.js';

const EXAMPLE_ENTITY_GRAPH_DIR = path.resolve(
  import.meta.dirname,
  '../../../fixtures/specs/entity-graph'
);

describe('truthset parser', () => {
  it('resolves the example truthset and loads labels', () => {
    const specs = discoverTruthsetSpecs(EXAMPLE_ENTITY_GRAPH_DIR);
    const parsed = specs.find((spec) => spec.name === 'company_truthset');

    expect(parsed).toBeDefined();
    if (!parsed) {
      throw new Error('Expected truthset fixture "company_truthset" to exist');
    }
    const resolved = resolveTruthsetSpec(parsed, EXAMPLE_ENTITY_GRAPH_DIR);
    const labels = loadTruthsetLabels(resolved);

    expect(resolved.resolutionEntity).toBe('company');
    expect(labels).toHaveLength(2);
    expect(labels[0]?.label).toBe('merge');
  });

  it('rejects malformed truthset labels', async () => {
    const badSpec = resolveTruthsetSpec(
      {
        name: 'company_truthset',
        filePath: path.join(EXAMPLE_ENTITY_GRAPH_DIR, 'company_truthset.yml'),
        csvPath: path.join(EXAMPLE_ENTITY_GRAPH_DIR, 'data', 'company_truthset.csv'),
        raw: {
          spec_version: '0.2',
          name: 'company_truthset',
          type: 'truthset',
          description: 'Regression labels for company matching thresholds.',
          resolution_ref: 'company_resolution',
          labels: {
            format: 'csv',
            path: 'data/company_truthset.csv',
            delimiter: ',',
          },
          targets: {
            min_auto_merge_precision: 0.98,
          },
        },
      },
      EXAMPLE_ENTITY_GRAPH_DIR
    );

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'truthset-'));
    const malformed = {
      ...badSpec,
      csvPath: path.join(tmpDir, 'company_truthset_invalid.csv'),
    };
    try {
      await fs.writeFile(malformed.csvPath, 'pair_id,label\nbad,\n', 'utf-8');
      expect(() => loadTruthsetLabels(malformed)).toThrow(/invalid row/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
