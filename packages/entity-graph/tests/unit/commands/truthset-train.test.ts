import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import { ResolutionSpecSchema } from '@bobsled-inc/model-spec';

import {
  applyFellegiSunterScoringPatch,
  buildTruthsetTrainResult,
  serializeFellegiSunterScoringPatch,
} from '../../../src/commands/truthset-train.js';
import { dedupeTruthsetLabels } from '../../../src/commands/truthset-train-support.js';

import type { FellegiSunterScoring } from '../../../src/compiler/identity/types.js';

const scoring: FellegiSunterScoring = {
  method: 'fellegi_sunter',
  prior: 0.002,
  comparisons: [
    {
      field: 'standardized_email',
      levels: [
        { op: 'exact', m: 0.8, u: 0.001 },
        { op: 'else', m: 0.2, u: 0.999 },
      ],
    },
  ],
};

function resolutionYaml(initialPrior: number): string {
  return [
    `spec_version: '0.2'`,
    `name: company_resolution`,
    `type: resolution`,
    `description: Company identity resolution.`,
    `inputs:`,
    `  - ref: crm_companies`,
    `    id_fields: [id]`,
    `standardize:`,
    `  - field: email`,
    `    transforms: [lowercase, trim]`,
    `deterministic_rules: []`,
    `scoring:`,
    `  method: fellegi_sunter`,
    `  prior: ${initialPrior}`,
    `  comparisons:`,
    `    - field: standardized_email`,
    `      levels:`,
    `        - { op: exact, m: 0.5, u: 0.5 }`,
    `        - { op: else, m: 0.5, u: 0.5 }`,
    `thresholds:`,
    `  auto_merge: 0.9`,
    `  review: 0.7`,
    `  auto_reject: 0.2`,
    ``,
  ].join('\n');
}

describe('truthset train YAML patching', () => {
  it('serializes a ready-to-paste scoring.fellegi_sunter block', () => {
    const patch = serializeFellegiSunterScoringPatch(scoring);

    expect(patch).toContain('scoring:');
    expect(patch).toContain('method: fellegi_sunter');
    expect(patch).toContain('prior: 0.002');
  });

  it('applies trained scoring and validates the resolution spec round-trip', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'truthset-train-'));
    const filePath = path.join(tmpDir, 'company_resolution.yml');
    fs.writeFileSync(filePath, resolutionYaml(0.01), 'utf-8');

    const result = applyFellegiSunterScoringPatch(filePath, scoring);
    const parsedYaml = YAML.parse(fs.readFileSync(filePath, 'utf-8'));
    const parsed = ResolutionSpecSchema.safeParse(parsedYaml);

    expect(result.file_path).toBe(filePath);
    expect(parsed.success).toBe(true);
    expect(parsedYaml.scoring.prior).toBe(0.002);
    expect(parsedYaml.scoring.comparisons[0].levels[0].m).toBe(0.8);
  });

  it('rejects oversized random u-sample requests before querying a runner', async () => {
    await expect(
      buildTruthsetTrainResult(
        ['truthset'],
        { runner: './runner.js', uSamplePairs: '5000001' },
        {},
        {
          buildTruthsetContext: () => {
            throw new Error('should not build context');
          },
          loadTruthsetLabels: () => [],
          scoreLabels: () => ({
            matched_label_count: 0,
            missing_pair_count: 0,
            auto_merge_precision: 0,
            auto_merge_recall: 0,
            review_recall: 0,
            auto_reject_precision: 0,
          }),
          tuneThresholds: () => ({ auto_merge: 0, review: 0, auto_reject: 0 }),
        }
      )
    ).rejects.toThrow(/--u-sample-pairs must not exceed 5000000/);
  });
});

describe('dedupeTruthsetLabels', () => {
  it('collapses duplicate pair labels to a single entry', () => {
    const deduped = dedupeTruthsetLabels([
      { pair_id: 'p1', label: 'merge' },
      { pair_id: 'p1', label: 'merge' },
      { pair_id: 'p2', label: 'not_match' },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((l) => l.pair_id).sort()).toEqual(['p1', 'p2']);
  });

  it('throws on conflicting labels for the same pair', () => {
    expect(() =>
      dedupeTruthsetLabels([
        { pair_id: 'p1', label: 'merge' },
        { pair_id: 'p1', label: 'not_match' },
      ])
    ).toThrow(/label conflict for pair p1/);
  });
});
