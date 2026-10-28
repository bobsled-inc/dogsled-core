import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addSourceColumn,
  removeSourceColumn,
  updateSource,
  updateSourceColumn,
} from '../../../src/edit/index.js';

describe('edit/source-editor', () => {
  let projectDir: string;
  let sourcePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-model-spec-edit-source-'));
    fs.mkdirSync(path.join(projectDir, 'sources', 'ecom'), { recursive: true });
    sourcePath = path.join(projectDir, 'sources', 'ecom', 'raw_customers.yml');
    fs.writeFileSync(sourcePath, sourceYaml(), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('updates a source column and preserves comments', () => {
    const result = updateSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      columnName: 'EMAIL',
      patch: { description: 'Primary email address', pii: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filePath).toBe(sourcePath);
    expect(result.data.content).toContain('# customer email');
    expect(fs.readFileSync(sourcePath, 'utf-8')).toContain('description: Primary email address');
    expect(fs.readFileSync(sourcePath, 'utf-8')).toContain('pii: true');
  });

  it('removes optional fields when patch values are undefined', () => {
    const result = updateSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      columnName: 'EMAIL',
      patch: { description: undefined },
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf-8')).not.toContain('description: Old email');
  });

  it('adds and removes source columns', () => {
    const added = addSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      column: { name: 'PHONE', type: 'VARCHAR', description: 'Customer phone' },
    });
    expect(added.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf-8')).toContain('name: PHONE');

    const removed = removeSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      columnName: 'PHONE',
    });
    expect(removed.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf-8')).not.toContain('name: PHONE');
  });

  it('does not write when dryRun is set', () => {
    const before = fs.readFileSync(sourcePath, 'utf-8');
    const result = updateSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      columnName: 'STATUS',
      patch: { enum_values: ['active', 'inactive'] },
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.content).toContain('enum_values');
    expect(fs.readFileSync(sourcePath, 'utf-8')).toBe(before);
  });

  it('returns validation errors without touching the file', () => {
    const before = fs.readFileSync(sourcePath, 'utf-8');
    const result = updateSource({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      patch: { trust_tier: 'diamond' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Validation failed');
    expect(fs.readFileSync(sourcePath, 'utf-8')).toBe(before);
  });

  it('refuses to remove the last source column', () => {
    fs.writeFileSync(sourcePath, sourceYaml(['ID']), 'utf-8');
    const result = removeSourceColumn({
      projectDir,
      sourceName: 'raw_customers',
      connection: 'ecom',
      columnName: 'ID',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('last column');
  });
});

function sourceYaml(columns = ['ID', 'EMAIL', 'STATUS']): string {
  const columnYaml = columns
    .map((name) => {
      if (name === 'EMAIL') {
        return [
          '    # customer email',
          '    - name: EMAIL',
          '      type: VARCHAR',
          '      description: Old email',
        ].join('\n');
      }
      return [
        `    - name: ${name}`,
        name === 'ID' ? '      type: NUMBER' : '      type: VARCHAR',
      ].join('\n');
    })
    .join('\n');
  return [
    "spec_version: '0.2'",
    'name: raw_customers',
    'type: source',
    'source_type: warehouse_table',
    'connection: ecom',
    'table: RAW.CUSTOMERS',
    'schema:',
    '  columns:',
    columnYaml,
    '',
  ].join('\n');
}
