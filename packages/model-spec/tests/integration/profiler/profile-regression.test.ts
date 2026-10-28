import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildProfileReport } from '../../../src/profiler/profile.js';

import type { ProfileSampleRow } from '../../../src/profiler/types.js';

interface Fixture {
  table: string;
  rows: ProfileSampleRow[];
  foreignKeyTargets: Array<{ table: string; column: string; values: unknown[] }>;
  expected: {
    primaryKey: string[];
    foreignKey: { from: string; toTable: string; toColumn: string };
    cleaningColumn: string;
  };
}

describe('profiler regression fixture', () => {
  it('scores PK/FK and cleaning precision against ground truth', () => {
    const fixturePath = path.join(import.meta.dirname, 'ground-truth.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as Fixture;

    const report = buildProfileReport({
      table: fixture.table,
      rowCount: fixture.rows.length,
      rows: fixture.rows,
      foreignKeyTargets: fixture.foreignKeyTargets,
    });

    const pkHit = report.pkCandidates.some(
      (candidate) =>
        candidate.confidence >= 0.9 &&
        candidate.columns.join(',') === fixture.expected.primaryKey.join(',')
    );
    const fkHit = report.fkCandidates.some(
      (candidate) =>
        candidate.confidence >= 0.9 &&
        candidate.from === fixture.expected.foreignKey.from &&
        candidate.toTable === fixture.expected.foreignKey.toTable &&
        candidate.toColumn === fixture.expected.foreignKey.toColumn
    );
    const cleaningHit = report.cleaningSuggestions.some(
      (suggestion) =>
        suggestion.confidence >= 0.9 && suggestion.column === fixture.expected.cleaningColumn
    );

    expect({
      pkHit,
      fkHit,
      cleaningHit,
      pkCandidates: report.pkCandidates,
      fkCandidates: report.fkCandidates,
      cleaningSuggestions: report.cleaningSuggestions,
    }).toMatchObject({
      pkHit: true,
      fkHit: true,
      cleaningHit: true,
    });
  });
});
