import { describe, expect, it } from 'vitest';

import {
  buildLineageTableDdl,
  buildLineageInsertSql,
  buildLineageQuerySql,
} from '../../../../src/compiler/lineage/codegen.js';

import type { LineageRow } from '../../../../src/compiler/lineage/types.js';

const SAMPLE_ROWS: LineageRow[] = [
  {
    entity_type: 'company',
    entity_id: null,
    attribute: 'name',
    profile_table: 'company__entity_profile',
    profile_column: 'name',
    source_system: 'salesforce',
    source_table: 'salesforce.accounts',
    source_column: 'name',
    field_path: null,
    transform_ref: 'normalize_company,fingerprint',
    transform_step: 'standardize',
    is_complete: true,
  },
  {
    entity_type: 'company',
    entity_id: null,
    attribute: 'website',
    profile_table: 'company__entity_profile',
    profile_column: 'website',
    source_system: null,
    source_table: '',
    source_column: 'website',
    field_path: null,
    transform_ref: null,
    transform_step: null,
    is_complete: false,
  },
];

describe('buildLineageTableDdl', () => {
  it('generates CREATE TABLE IF NOT EXISTS for duckdb', () => {
    const stmts = buildLineageTableDdl('duckdb');
    expect(stmts).toHaveLength(1);
    const sql = stmts[0]?.sql ?? '';
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('"entity_graph"."lineage"');
    expect(sql).toContain('"entity_type"');
    expect(sql).toContain('"entity_id"');
    expect(sql).toContain('"attribute"');
    expect(sql).toContain('"is_complete"');
    expect(sql).toContain('"loaded_at"');
  });

  it('generates for snowflake with uppercase identifiers', () => {
    const stmts = buildLineageTableDdl('snowflake');
    const sql = stmts[0]?.sql ?? '';
    expect(sql).toContain('"ENTITY_GRAPH"."LINEAGE"');
    expect(sql).toContain('"ENTITY_TYPE"');
  });

  it('uses a custom contractSchema', () => {
    const stmts = buildLineageTableDdl('duckdb', 'my_schema');
    const sql = stmts[0]?.sql ?? '';
    expect(sql).toContain('"my_schema"."lineage"');
  });

  it('sets tableCreated metadata', () => {
    const stmts = buildLineageTableDdl('duckdb');
    expect(stmts[0]?.tableCreated).toBe('entity_graph.lineage');
  });
});

describe('buildLineageInsertSql', () => {
  it('generates DELETE + INSERT for non-empty rows', () => {
    const stmts = buildLineageInsertSql('company', SAMPLE_ROWS, 'duckdb');
    expect(stmts).toHaveLength(2);
    const [deleteStmt, insertStmt] = stmts;
    expect(deleteStmt?.sql).toContain('DELETE FROM');
    expect(deleteStmt?.sql).toContain("'company'");
    expect(deleteStmt?.sql).toContain('"entity_id" IS NULL');
    expect(insertStmt?.sql).toContain('INSERT INTO');
    expect(insertStmt?.sql).toContain("'name'");
    expect(insertStmt?.sql).toContain("'salesforce.accounts'");
    expect(insertStmt?.sql).toContain('TRUE');
    expect(insertStmt?.sql).toContain('FALSE');
  });

  it('generates only DELETE for empty rows', () => {
    const stmts = buildLineageInsertSql('company', [], 'duckdb');
    expect(stmts).toHaveLength(1);
    expect(stmts[0]?.sql).toContain('DELETE FROM');
  });

  it('emits NULL for null source_system', () => {
    const stmts = buildLineageInsertSql('company', [SAMPLE_ROWS[1]!], 'duckdb');
    const insertSql = stmts[1]?.sql ?? '';
    expect(insertSql).toContain('NULL,');
  });

  it('emits literal values for transform_ref', () => {
    const stmts = buildLineageInsertSql('company', [SAMPLE_ROWS[0]!], 'duckdb');
    const insertSql = stmts[1]?.sql ?? '';
    expect(insertSql).toContain("'normalize_company,fingerprint'");
    expect(insertSql).toContain("'standardize'");
  });

  it('applies snowflake quoting', () => {
    const stmts = buildLineageInsertSql('company', SAMPLE_ROWS, 'snowflake');
    const deleteSql = stmts[0]?.sql ?? '';
    expect(deleteSql).toContain('"ENTITY_GRAPH"."LINEAGE"');
    expect(deleteSql).toContain('"ENTITY_TYPE"');
  });
});

describe('buildLineageQuerySql', () => {
  it('generates SELECT for entity + attribute on duckdb', () => {
    const sql = buildLineageQuerySql({
      entityType: 'company',
      attribute: 'name',
      dialect: 'duckdb',
    });
    expect(sql).toContain('SELECT');
    expect(sql).toContain('"entity_graph"."lineage"');
    expect(sql).toContain('"entity_type"');
    expect(sql).toContain('"attribute"');
    expect(sql).toContain("'company'");
    expect(sql).toContain("'name'");
    expect(sql).toContain('ORDER BY');
  });

  it('includes entity_id filter when provided', () => {
    const sql = buildLineageQuerySql({
      entityType: 'company',
      attribute: 'name',
      entityId: 'e-123',
      dialect: 'duckdb',
    });
    expect(sql).toContain("'e-123'");
    expect(sql).toContain('"entity_id" IS NULL');
  });

  it('does not include entity_id filter when absent', () => {
    const sql = buildLineageQuerySql({
      entityType: 'company',
      attribute: 'name',
      dialect: 'duckdb',
    });
    expect(sql).not.toContain('e-123');
  });

  it('uses custom contractSchema', () => {
    const sql = buildLineageQuerySql({
      entityType: 'company',
      attribute: 'name',
      dialect: 'duckdb',
      contractSchema: 'my_schema',
    });
    expect(sql).toContain('"my_schema"."lineage"');
  });

  it('applies bigquery backtick quoting', () => {
    const sql = buildLineageQuerySql({
      entityType: 'company',
      attribute: 'name',
      dialect: 'bigquery',
    });
    expect(sql).toContain('`entity_graph`.`lineage`');
    expect(sql).toContain('`entity_type`');
  });
});
