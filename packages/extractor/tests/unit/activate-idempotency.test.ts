import { describe, expect, it } from 'vitest';
import { computeIdempotencyKey } from '../../src/runtime/activate/idempotency.js';

describe('computeIdempotencyKey', () => {
  it('returns a 64-character hex string', () => {
    const key = computeIdempotencyKey({
      action: 'upsert_contact',
      targetRecordKey: 'ent-123',
      projectionRef: 'mydb.people__salesforce__projection_1',
    });
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for same inputs', () => {
    const input = {
      action: 'upsert_contact',
      targetRecordKey: 'ent-123',
      projectionRef: 'mydb.people__salesforce__projection_1',
      namespace: 'prod',
    };
    expect(computeIdempotencyKey(input)).toBe(computeIdempotencyKey(input));
  });

  it('differs for different entity IDs', () => {
    const base = {
      action: 'upsert_contact',
      projectionRef: 'mydb.people__salesforce__projection_1',
    };
    const key1 = computeIdempotencyKey({ ...base, targetRecordKey: 'ent-1' });
    const key2 = computeIdempotencyKey({ ...base, targetRecordKey: 'ent-2' });
    expect(key1).not.toBe(key2);
  });

  it('differs for different actions', () => {
    const base = {
      targetRecordKey: 'ent-123',
      projectionRef: 'mydb.people__salesforce__projection_1',
    };
    const key1 = computeIdempotencyKey({ ...base, action: 'upsert_contact' });
    const key2 = computeIdempotencyKey({ ...base, action: 'create_contact' });
    expect(key1).not.toBe(key2);
  });

  it('differs for different projection refs', () => {
    const base = { action: 'upsert_contact', targetRecordKey: 'ent-123' };
    const key1 = computeIdempotencyKey({ ...base, projectionRef: 'db.people__v1' });
    const key2 = computeIdempotencyKey({ ...base, projectionRef: 'db.people__v2' });
    expect(key1).not.toBe(key2);
  });

  it('differs when namespace changes', () => {
    const base = {
      action: 'upsert_contact',
      targetRecordKey: 'ent-123',
      projectionRef: 'mydb.people__salesforce__projection_1',
    };
    const key1 = computeIdempotencyKey({ ...base, namespace: 'prod' });
    const key2 = computeIdempotencyKey({ ...base, namespace: 'staging' });
    expect(key1).not.toBe(key2);
  });

  it('treats missing namespace same as empty string', () => {
    const base = {
      action: 'upsert_contact',
      targetRecordKey: 'ent-123',
      projectionRef: 'mydb.people__salesforce__projection_1',
    };
    const keyNoNs = computeIdempotencyKey(base);
    const keyEmptyNs = computeIdempotencyKey({ ...base, namespace: '' });
    expect(keyNoNs).toBe(keyEmptyNs);
  });

  it('handles embedded null bytes without collisions', () => {
    const key1 = computeIdempotencyKey({
      action: 'upsert_contact',
      targetRecordKey: 'ent-123\0segment',
      projectionRef: 'db.people__v1',
    });
    const key2 = computeIdempotencyKey({
      action: 'upsert_contact\0ent-123',
      targetRecordKey: 'segment',
      projectionRef: 'db.people__v1',
    });

    expect(key1).not.toBe(key2);
    expect(
      computeIdempotencyKey({
        action: 'upsert_contact',
        targetRecordKey: 'ent-123\0segment',
        projectionRef: 'db.people__v1',
      })
    ).toBe(key1);
    expect(key1).toHaveLength(64);
    expect(key1).toMatch(/^[0-9a-f]+$/);
    expect(key2).toHaveLength(64);
    expect(key2).toMatch(/^[0-9a-f]+$/);
  });
});
