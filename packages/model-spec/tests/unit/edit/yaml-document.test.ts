import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyPatch,
  findNamedItemIndex,
  readYamlDocument,
  serializeDocument,
  writeYamlDocument,
} from '../../../src/edit/index.js';

describe('edit/yaml-document', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-model-spec-edit-yaml-'));
    filePath = path.join(tmpDir, 'raw_customers.yml');
    fs.writeFileSync(
      filePath,
      [
        "spec_version: '0.2'",
        'name: raw_customers',
        'type: source',
        'source_type: warehouse_table',
        'connection: ecom',
        'table: RAW.CUSTOMERS',
        'schema:',
        '  columns:',
        '    # customer email stays attached',
        '    - name: EMAIL',
        '      type: VARCHAR',
        '      description: Old description',
        '      pii: true',
        '    - name: ID',
        '      type: NUMBER',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads, patches, serializes, and preserves comments', () => {
    const read = readYamlDocument(filePath);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const index = findNamedItemIndex(read.data.doc, ['schema', 'columns'], 'email');
    expect(index).toBe(0);

    applyPatch(read.data.doc, ['schema', 'columns', index], {
      description: 'Primary email address',
      pii: undefined,
    });
    const content = serializeDocument(read.data.doc);

    expect(content).toContain('# customer email stays attached');
    expect(content).toContain('description: Primary email address');
    expect(content).not.toContain('pii: true');
  });

  it('returns -1 for missing named items', () => {
    const read = readYamlDocument(filePath);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(findNamedItemIndex(read.data.doc, ['schema', 'columns'], 'MISSING')).toBe(-1);
  });

  it('writes atomically through a temporary file and rename', () => {
    const result = writeYamlDocument(filePath, 'name: rewritten\n');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('name: rewritten\n');
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
