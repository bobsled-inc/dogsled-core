import { describe, expect, it } from 'vitest';
import { SUPPORTED_DIALECTS, quoteIdentifier } from '../../../src/compiler/dialect.js';
import {
  generateProcessedKeyReplacementSql,
  generateStageReplacementDml,
  generateUnprocessedRowsSql,
} from '../../../src/compiler/materializer.js';

describe('processed-key materialization SQL', () => {
  for (const dialect of SUPPORTED_DIALECTS) {
    it(`keeps unprocessed keys and all new output rows on ${dialect}`, () => {
      const target = quoteIdentifier('target', dialect);
      const processedKeys = quoteIdentifier('processed_keys', dialect);
      const acceptedRows = quoteIdentifier('accepted_rows', dialect);
      const id = quoteIdentifier('customer_id', dialect);
      const issue = quoteIdentifier('issue', dialect);
      const sql = generateProcessedKeyReplacementSql({
        target,
        processedKeys,
        acceptedRows,
        columns: ['customer_id', 'issue'],
        keys: ['customer_id'],
        dialect,
      });
      // The anti-join reads the processed-key table, not accepted rows. Thus a
      // processed B with zero output removes old B; an unprocessed C remains.
      expect(sql).toBe(
        `SELECT __old.${id}, __old.${issue} FROM ${target} AS __old WHERE NOT EXISTS (SELECT 1 FROM ${processedKeys} AS __processed WHERE __old.${id} = __processed.${id})\nUNION ALL\nSELECT ${id}, ${issue} FROM ${acceptedRows}`
      );
      expect(
        generateStageReplacementDml({
          target,
          stage: acceptedRows,
          columns: ['customer_id', 'issue'],
          dialect,
        })
      ).toEqual([
        `DELETE FROM ${target} WHERE TRUE`,
        `INSERT INTO ${target} (${id}, ${issue}) SELECT ${id}, ${issue} FROM ${acceptedRows}`,
      ]);
    });
  }

  it('matches composite keys together and escapes identifier punctuation', () => {
    const sql = generateUnprocessedRowsSql({
      target: '"target"',
      processedKeys: '"processed"',
      columns: ['tenant"id', 'customer id', 'select'],
      keys: ['tenant"id', 'customer id'],
      dialect: 'postgres',
    });
    expect(sql).toBe(
      'SELECT __old."tenant""id", __old."customer id", __old."select" FROM "target" AS __old WHERE NOT EXISTS (SELECT 1 FROM "processed" AS __processed WHERE __old."tenant""id" = __processed."tenant""id" AND __old."customer id" = __processed."customer id")'
    );
  });

  it('rejects empty keys rather than deleting every old row', () => {
    expect(() =>
      generateUnprocessedRowsSql({
        target: 't',
        processedKeys: 'p',
        columns: ['id'],
        keys: [],
        dialect: 'duckdb',
      })
    ).toThrow('Replacement keys');
  });

  it('rejects keys outside the output and column names that collide after case folding', () => {
    expect(() =>
      generateUnprocessedRowsSql({
        target: 't',
        processedKeys: 'p',
        columns: ['id'],
        keys: ['other'],
        dialect: 'duckdb',
      })
    ).toThrow('Replacement keys');
    expect(() =>
      generateStageReplacementDml({
        target: 't',
        stage: 's',
        columns: ['id', 'ID'],
        dialect: 'snowflake',
      })
    ).toThrow('Replacement columns');
    expect(() =>
      generateStageReplacementDml({ target: 't', stage: 's', columns: [], dialect: 'postgres' })
    ).toThrow('Replacement columns');
  });
});
