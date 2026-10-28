import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addModelColumn,
  removeModelColumn,
  updateModel,
  updateModelColumn,
} from '../../../src/edit/index.js';

describe('edit/model-editor', () => {
  let projectDir: string;
  let modelPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-model-spec-edit-model-'));
    fs.mkdirSync(path.join(projectDir, 'models'), { recursive: true });
    modelPath = path.join(projectDir, 'models', 'stg_orders.yml');
    fs.writeFileSync(modelPath, modelYaml(), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('updates model column metadata and expressions', () => {
    const result = updateModelColumn({
      projectDir,
      modelName: 'stg_orders',
      columnName: 'ORDER_DATE',
      patch: {
        expr: "DATE_TRUNC('day', ORDERED_AT)",
        description: 'Order date at day grain',
      },
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(modelPath, 'utf-8')).toContain("expr: DATE_TRUNC('day', ORDERED_AT)");
    expect(fs.readFileSync(modelPath, 'utf-8')).toContain('description: Order date at day grain');
  });

  it('adds and removes model columns while preserving comments', () => {
    const added = addModelColumn({
      projectDir,
      modelName: 'stg_orders',
      column: {
        name: 'ORDER_YEAR',
        expr: "DATE_PART('year', ORDER_DATE)",
        description: 'Year the order was placed',
      },
    });
    expect(added.ok).toBe(true);
    expect(fs.readFileSync(modelPath, 'utf-8')).toContain('name: ORDER_YEAR');

    const removed = removeModelColumn({
      projectDir,
      modelName: 'stg_orders',
      columnName: 'ORDER_YEAR',
    });
    expect(removed.ok).toBe(true);
    expect(fs.readFileSync(modelPath, 'utf-8')).toContain('# primary order key');
    expect(fs.readFileSync(modelPath, 'utf-8')).not.toContain('name: ORDER_YEAR');
  });

  it('returns a clear error when removing the last model column', () => {
    const singleColumnPath = path.join(projectDir, 'models', 'single_column.yml');
    fs.writeFileSync(
      singleColumnPath,
      [
        "spec_version: '0.2'",
        'name: single_column',
        'type: model',
        'source:',
        '  ref: ecom.raw_orders',
        'columns:',
        '  - name: ORDER_ID',
        '    expr: ID',
        'materialization:',
        '  type: view',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = removeModelColumn({
      projectDir,
      modelName: 'single_column',
      columnName: 'ORDER_ID',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Cannot remove the last column from model "single_column"',
    });
    expect(fs.readFileSync(singleColumnPath, 'utf-8')).toContain('name: ORDER_ID');
  });

  it('allows removing the last explicit column when include_all_columns is true', () => {
    const includeAllPath = path.join(projectDir, 'models', 'include_all.yml');
    fs.writeFileSync(
      includeAllPath,
      [
        "spec_version: '0.2'",
        'name: include_all',
        'type: model',
        'description: Include all source columns',
        'grain: ORDER_ID',
        'source:',
        '  ref: ecom.raw_orders',
        'include_all_columns: true',
        'columns:',
        '  - name: ORDER_ID',
        '    expr: ID',
        'materialization:',
        '  type: view',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = removeModelColumn({
      projectDir,
      modelName: 'include_all',
      columnName: 'ORDER_ID',
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(includeAllPath, 'utf-8');
    expect(content).toContain('include_all_columns: true');
    expect(content).not.toContain('name: ORDER_ID');
  });

  it('updates model-level metadata', () => {
    const result = updateModel({
      projectDir,
      modelName: 'stg_orders',
      patch: {
        description: 'Staged order facts',
        grain: ['ORDER_ID', 'ORDER_DATE'],
        tags: ['finance'],
        owner: 'data-eng',
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(modelPath, 'utf-8');
    expect(content).toContain('description: Staged order facts');
    expect(content).toContain('grain:');
    expect(content).toContain('- ORDER_ID');
    expect(content).toContain('owner: data-eng');
  });
});

function modelYaml(): string {
  return [
    "spec_version: '0.2'",
    'name: stg_orders',
    'type: model',
    'description: Staged orders',
    'grain: ORDER_ID',
    'source:',
    '  ref: ecom.raw_orders',
    'columns:',
    '  # primary order key',
    '  - name: ORDER_ID',
    '    expr: ID',
    '    primary_key: true',
    '  - name: ORDER_DATE',
    '    expr: ORDERED_AT',
    'materialization:',
    '  type: view',
    '',
  ].join('\n');
}
