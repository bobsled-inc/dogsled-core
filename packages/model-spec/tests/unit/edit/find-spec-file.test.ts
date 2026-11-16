import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { indexProjectFiles, scanProject } from '@bobsled-inc/project-index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findMetadataFile, findModelFile, findSourceFile } from '../../../src/edit/index.js';
import { findEditTarget } from '../../../src/edit/find-spec-file.js';

vi.mock('@bobsled-inc/project-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bobsled-inc/project-index')>();
  return { ...actual, scanProject: vi.fn(actual.scanProject) };
});

describe('edit/find-spec-file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-model-spec-edit-find-'));
    fs.mkdirSync(path.join(tmpDir, 'sources', 'ecom'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'sources', 'crm'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'models', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'metrics'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'sources', 'ecom', 'raw_customers.yml'),
      "spec_version: '0.2'\nname: raw_customers\ntype: source\nconnection: ecom\n",
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'sources', 'crm', 'raw_customers.yml'),
      "spec_version: '0.2'\nname: raw_customers\ntype: source\nconnection: crm\n",
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'models', 'staging', 'stg_customers.yml'),
      "spec_version: '0.2'\nname: stg_customers\ntype: model\n",
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'metrics', 'customer_count.yml'),
      "spec_version: '0.2'\ntype: metric\nname: customer_count\n",
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a source by name and connection', () => {
    const found = findSourceFile(path.join(tmpDir, 'sources'), 'raw_customers', 'ecom');
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.data).toContain(path.join('sources', 'ecom', 'raw_customers.yml'));
  });

  it('returns an ambiguity error when connection is omitted for duplicate source names', () => {
    const found = findSourceFile(path.join(tmpDir, 'sources'), 'raw_customers');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error).toContain('Multiple source specs');
  });

  it('finds model specs in subdirectories', () => {
    const found = findModelFile(path.join(tmpDir, 'models'), 'stg_customers');
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.data).toContain(path.join('models', 'staging', 'stg_customers.yml'));
  });

  it('finds metadata specs and errors for missing specs', () => {
    expect(findMetadataFile(path.join(tmpDir, 'metrics'), 'customer_count', 'metric').ok).toBe(
      true
    );
    const missing = findModelFile(path.join(tmpDir, 'models'), 'missing_model');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('No model spec named "missing_model"');
  });

  it('finds edit targets by declared type anywhere in the project', () => {
    fs.mkdirSync(path.join(tmpDir, 'shop', 'orders'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'shop', 'orders', 'orders.yml'),
      "spec_version: '0.2'\nname: fct_orders\ntype: model\n",
      'utf-8'
    );
    fs.writeFileSync(path.join(tmpDir, 'shop', 'broken.yml'), '[', 'utf-8');

    const found = findEditTarget({ projectDir: tmpDir }, 'model', 'fct_orders');
    expect(found).toEqual({ ok: true, data: path.join(tmpDir, 'shop', 'orders', 'orders.yml') });

    const source = findEditTarget(
      { projectDir: tmpDir },
      'source',
      'raw_customers',
      (record) => record.connection === 'crm'
    );
    expect(source).toEqual({
      ok: true,
      data: path.join(tmpDir, 'sources', 'crm', 'raw_customers.yml'),
    });
  });

  it('reports a scan that stopped at a limit instead of a missing spec', () => {
    vi.mocked(scanProject).mockReturnValueOnce(
      indexProjectFiles(
        [
          { path: 'a/model.yml', content: "spec_version: '0.2'\nname: a\ntype: model\n" },
          { path: 'b/model.yml', content: "spec_version: '0.2'\nname: b\ntype: model\n" },
        ],
        { maxFiles: 1 }
      )
    );

    const found = findEditTarget({ projectDir: tmpDir }, 'model', 'b');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error).toContain('more than 1 YAML, JSON, and Markdown files');
  });

  it('limits the search to an explicit folder override', () => {
    fs.mkdirSync(path.join(tmpDir, 'shop'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'shop', 'orders.yml'),
      "spec_version: '0.2'\nname: fct_orders\ntype: model\n",
      'utf-8'
    );

    const found = findEditTarget(
      { projectDir: tmpDir, modelsDir: 'models' },
      'model',
      'fct_orders'
    );
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error).toContain('No model spec named "fct_orders" found under');
  });
});
