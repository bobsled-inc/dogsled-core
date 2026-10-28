import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPiiScanPatches } from '../../../src/commands/pii.js';

describe('applyPiiScanPatches', () => {
  let projectDir: string;
  let sourcePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-pii-scan-'));
    fs.mkdirSync(path.join(projectDir, 'sources', 'crm'), { recursive: true });
    sourcePath = path.join(projectDir, 'sources', 'crm', 'contacts.yml');
    fs.writeFileSync(sourcePath, sourceYaml(), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes Model Spec pii patches through the edit API and is idempotent', () => {
    const verdicts = [
      {
        source_ref: 'crm.contacts',
        field: 'email',
        pii: true,
        classification: 'email',
        confidence: 0.98,
        detector: 'regex' as const,
        reasons: ['sample matched email pattern'],
        suggested_masking: 'hash' as const,
      },
    ];

    expect(applyPiiScanPatches(projectDir, verdicts)).toEqual([
      expect.objectContaining({ status: 'applied', field: 'email' }),
    ]);
    const once = fs.readFileSync(sourcePath, 'utf-8');
    expect(once).toContain('pii: true');

    expect(applyPiiScanPatches(projectDir, verdicts)).toEqual([
      expect.objectContaining({ status: 'applied', field: 'email' }),
    ]);
    const twice = fs.readFileSync(sourcePath, 'utf-8');
    expect(twice).toBe(once);
  });
});

function sourceYaml(): string {
  return [
    "spec_version: '0.2'",
    'name: contacts',
    'type: source',
    'source_type: warehouse_table',
    'connection: crm',
    'table: RAW.CONTACTS',
    'schema:',
    '  columns:',
    '    - name: id',
    '      type: NUMBER',
    '    - name: email',
    '      type: VARCHAR',
    '',
  ].join('\n');
}
