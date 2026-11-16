import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateMetric, updateRelationship, updateVq } from '../../../src/edit/index.js';

describe('edit/metadata-editor', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-model-spec-edit-metadata-'));
    fs.mkdirSync(path.join(projectDir, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'relationships'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'vqs'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'metrics', 'gross_revenue.yml'),
      [
        "spec_version: '0.2'",
        'type: metric',
        'name: gross_revenue',
        'description: Gross revenue',
        'model: fct_orders',
        'expression: SUM({fct_orders.TOTAL})',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'relationships', 'orders_customers.yml'),
      [
        "spec_version: '0.2'",
        'type: relationship',
        'name: orders_customers',
        'left_model: fct_orders',
        'right_model: dim_customers',
        'join_columns:',
        '  - left: CUSTOMER_ID',
        '    right: CUSTOMER_ID',
        'join_type: inner',
        'relationship_type: many_to_one',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'vqs', 'orders_by_month.yml'),
      [
        "spec_version: '0.2'",
        'type: vq',
        'name: orders_by_month',
        'nlq: How many orders were placed by month?',
        'sql: SELECT COUNT(*) FROM {fct_orders}',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('updates metric expression and synonyms', () => {
    const result = updateMetric({
      projectDir,
      metricName: 'gross_revenue',
      patch: {
        expression: 'SUM({fct_orders.NET_REVENUE})',
        synonyms: ['sales', 'revenue'],
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(path.join(projectDir, 'metrics', 'gross_revenue.yml'), 'utf-8');
    expect(content).toContain('SUM({fct_orders.NET_REVENUE})');
    expect(content).toContain('- sales');
    expect(content).toContain('- revenue');
  });

  it('updates relationship join metadata', () => {
    const result = updateRelationship({
      projectDir,
      relationshipName: 'orders_customers',
      patch: { join_type: 'left', relationship_type: 'many_to_one' },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(
      path.join(projectDir, 'relationships', 'orders_customers.yml'),
      'utf-8'
    );
    expect(content).toContain('join_type: left');
  });

  it('updates verified query SQL', () => {
    const result = updateVq({
      projectDir,
      vqName: 'orders_by_month',
      patch: {
        description: 'Monthly order count',
        sql: "SELECT DATE_TRUNC('month', ORDER_DATE), COUNT(*) FROM {fct_orders} GROUP BY 1",
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(path.join(projectDir, 'vqs', 'orders_by_month.yml'), 'utf-8');
    expect(content).toContain('description: Monthly order count');
    expect(content).toContain("DATE_TRUNC('month', ORDER_DATE)");
  });
});
