/**
 * FQN_IN_RESOURCE_TABLE / BQ_USES_DATASET — fix-suggesting messages for the
 * two most common shape mistakes on the warehouse SourceConfig.
 */

import { describe, expect, it } from 'vitest';

import { SourceConfigSchema } from '../../src/framework/core/warehouse.js';

describe('SourceConfigSchema fix-suggesting errors', () => {
  describe('FQN_IN_RESOURCE_TABLE', () => {
    it('rejects 3-part FQN in table:', () => {
      const result = SourceConfigSchema.safeParse({
        table: 'PROJ.DATASET.ORDERS',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map((i) => i.message).join(' ');
        expect(msg).toContain('[FQN_IN_RESOURCE_TABLE]');
        expect(msg).toContain('dataset:');
        expect(msg).toContain('schema:');
        expect(msg).toContain('database:');
      }
    });

    it('rejects 2-part qualified name in table:', () => {
      const result = SourceConfigSchema.safeParse({ table: 'SCHEMA.ORDERS' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map((i) => i.message).join(' ');
        expect(msg).toContain('[FQN_IN_RESOURCE_TABLE]');
      }
    });

    it('accepts a plain table name', () => {
      const result = SourceConfigSchema.safeParse({ table: 'ORDERS' });
      expect(result.success).toBe(true);
    });

    it('accepts table + dataset side-by-side', () => {
      const result = SourceConfigSchema.safeParse({
        table: 'ORDERS',
        dataset: 'analytics',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('BQ_USES_DATASET', () => {
    it('rejects setting both schema: and dataset: (contradiction)', () => {
      const result = SourceConfigSchema.safeParse({
        table: 'ORDERS',
        schema: 'analytics',
        dataset: 'analytics',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map((i) => i.message).join(' ');
        expect(msg).toContain('[BQ_USES_DATASET]');
        expect(msg).toContain('BigQuery');
      }
    });

    it('accepts schema: alone (Snowflake/Postgres/Redshift)', () => {
      const result = SourceConfigSchema.safeParse({
        table: 'ORDERS',
        schema: 'analytics',
      });
      expect(result.success).toBe(true);
    });

    it('accepts dataset: alone (BigQuery)', () => {
      const result = SourceConfigSchema.safeParse({
        table: 'orders',
        dataset: 'analytics',
      });
      expect(result.success).toBe(true);
    });
  });
});
