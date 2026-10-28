import { describe, expect, it } from 'vitest';
import {
  generateActivationDispatchAuditSql,
  generateActivationReceiptAuditSql,
  generatePolicyBlockAuditSql,
} from '../../../../src/compiler/audit/subscribe-activation.js';

const baseInput = {
  entityId: 'ent-abc',
  clusterId: 'cluster-1',
  syncName: 'salesforce_sync',
  projectionRef: 'mydb.people__salesforce__projection_1',
  status: 'succeeded' as const,
  idempotencyKey: 'abc123',
  action: 'upsert_contact',
  durationMs: 250,
  dialect: 'duckdb' as const,
  contractSchema: 'entity_graph',
};

describe('generateActivationDispatchAuditSql', () => {
  it('returns a SqlStatement with INSERT SQL', () => {
    const stmt = generateActivationDispatchAuditSql(baseInput);
    expect(stmt.sql).toContain('INSERT INTO');
    expect(stmt.sql).toContain('entity_graph');
    expect(stmt.sql).toContain('audit_log');
    expect(stmt.sql).toContain('activation_dispatch');
  });

  it('uses a deterministic name based on entityId', () => {
    const stmt = generateActivationDispatchAuditSql(baseInput);
    expect(stmt.name).toContain('ent-abc');
  });

  it('includes sync_name in payload', () => {
    const stmt = generateActivationDispatchAuditSql(baseInput);
    expect(stmt.sql).toContain('salesforce_sync');
  });

  it('includes failed status when dispatch fails', () => {
    const stmt = generateActivationDispatchAuditSql({
      ...baseInput,
      status: 'failed',
      errorCode: 'server_error',
      errorMessage: 'Internal Server Error',
    });
    expect(stmt.sql).toContain('failed');
  });
});

describe('generateActivationReceiptAuditSql', () => {
  it('returns a SqlStatement with INSERT SQL for receipt', () => {
    const stmt = generateActivationReceiptAuditSql(baseInput);
    expect(stmt.sql).toContain('INSERT INTO');
    expect(stmt.sql).toContain('activation_receipt');
    expect(stmt.sql).toContain('upsert_contact');
  });

  it('uses a different name prefix from dispatch', () => {
    const dispatch = generateActivationDispatchAuditSql(baseInput);
    const receipt = generateActivationReceiptAuditSql(baseInput);
    expect(dispatch.name).not.toBe(receipt.name);
  });
});

describe('generatePolicyBlockAuditSql', () => {
  it('returns a SqlStatement with policy_block payload', () => {
    const stmt = generatePolicyBlockAuditSql({
      entityId: 'ent-abc',
      clusterId: 'cluster-1',
      policyName: 'my-policy',
      reason: 'trust score 0.3 < threshold 0.7',
      dialect: 'duckdb',
      contractSchema: 'entity_graph',
    });
    expect(stmt.sql).toContain('INSERT INTO');
    expect(stmt.sql).toContain('policy_block');
    expect(stmt.sql).toContain('my-policy');
  });

  it('defaults to entity_graph schema when contractSchema is omitted', () => {
    const stmt = generatePolicyBlockAuditSql({
      entityId: 'ent-abc',
      policyName: 'test',
      reason: 'blocked',
      dialect: 'duckdb',
    });
    expect(stmt.sql).toContain('entity_graph');
  });
});
