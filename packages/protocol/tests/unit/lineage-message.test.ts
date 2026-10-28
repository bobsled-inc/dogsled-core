import { describe, expect, it } from 'vitest';

import {
  LINEAGE_SOURCE_TYPES,
  LINEAGE_SOURCE_TYPE_SET,
  isLineageSourceType,
  parseStdoutMessage,
  parseRequiredStdoutMessage,
  PROTOCOL_VERSION,
} from '../../src/index.js';

import type { LineageMessage } from '../../src/index.js';

const VALID_LINEAGE: unknown = {
  _v: PROTOCOL_VERSION,
  type: 'LINEAGE',
  stream: 'company__entity_profile',
  lineage: {
    output: { table: 'entity_graph.lineage', column: 'name' },
    upstream: [
      {
        source_type: 'model',
        table: 'salesforce.accounts',
        column: 'name',
      },
    ],
    transform_ref: 'normalize_company,fingerprint',
    transform_step: 'standardize',
    is_complete: true,
    generated_at: '2026-04-30T00:00:00Z',
  },
};

describe('LINEAGE_SOURCE_TYPES', () => {
  it('contains all expected source types', () => {
    expect(LINEAGE_SOURCE_TYPES).toContain('api');
    expect(LINEAGE_SOURCE_TYPES).toContain('warehouse');
    expect(LINEAGE_SOURCE_TYPES).toContain('model');
    expect(LINEAGE_SOURCE_TYPES).toContain('clean');
    expect(LINEAGE_SOURCE_TYPES).toContain('entity_graph');
  });

  it('LINEAGE_SOURCE_TYPE_SET matches LINEAGE_SOURCE_TYPES', () => {
    expect(LINEAGE_SOURCE_TYPE_SET.size).toBe(LINEAGE_SOURCE_TYPES.length);
    for (const t of LINEAGE_SOURCE_TYPES) {
      expect(LINEAGE_SOURCE_TYPE_SET.has(t)).toBe(true);
    }
  });

  it('isLineageSourceType narrows valid types', () => {
    for (const t of LINEAGE_SOURCE_TYPES) {
      expect(isLineageSourceType(t)).toBe(true);
    }
    expect(isLineageSourceType('unknown')).toBe(false);
    expect(isLineageSourceType('')).toBe(false);
  });
});

describe('parseStdoutMessage — LINEAGE', () => {
  it('parses a valid LINEAGE message', () => {
    const result = parseStdoutMessage(VALID_LINEAGE);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('LINEAGE');
    const msg = result as LineageMessage;
    expect(msg.stream).toBe('company__entity_profile');
    expect(msg.lineage.output.table).toBe('entity_graph.lineage');
    expect(msg.lineage.output.column).toBe('name');
    expect(msg.lineage.upstream).toHaveLength(1);
    expect(msg.lineage.upstream[0]?.source_type).toBe('model');
    expect(msg.lineage.upstream[0]?.table).toBe('salesforce.accounts');
    expect(msg.lineage.upstream[0]?.column).toBe('name');
    expect(msg.lineage.transform_ref).toBe('normalize_company,fingerprint');
    expect(msg.lineage.transform_step).toBe('standardize');
    expect(msg.lineage.is_complete).toBe(true);
    expect(msg.lineage.generated_at).toBe('2026-04-30T00:00:00Z');
  });

  it('parses LINEAGE with is_complete=false and no optional fields', () => {
    const msg = parseStdoutMessage({
      _v: PROTOCOL_VERSION,
      type: 'LINEAGE',
      stream: 'company__entity_profile',
      lineage: {
        output: { table: 'entity_graph.lineage', column: 'website' },
        upstream: [],
        is_complete: false,
        generated_at: '2026-04-30T12:00:00.000Z',
      },
    }) as LineageMessage;

    expect(msg.type).toBe('LINEAGE');
    expect(msg.lineage.is_complete).toBe(false);
    expect(msg.lineage.upstream).toHaveLength(0);
    expect(msg.lineage.transform_ref).toBeUndefined();
    expect(msg.lineage.transform_step).toBeUndefined();
  });

  it('parses upstream entries with optional field_path', () => {
    const msg = parseStdoutMessage({
      _v: PROTOCOL_VERSION,
      type: 'LINEAGE',
      stream: 'contact__entity_profile',
      lineage: {
        output: { table: 'entity_graph.lineage', column: 'email' },
        upstream: [
          {
            source_type: 'api',
            table: 'hubspot.contacts',
            column: 'properties',
            field_path: 'email',
          },
        ],
        is_complete: true,
        generated_at: '2026-04-30T00:00:00Z',
      },
    }) as LineageMessage;

    expect(msg.lineage.upstream[0]?.field_path).toBe('email');
  });

  it('returns null for unknown message type (non-LINEAGE)', () => {
    const result = parseStdoutMessage({
      _v: PROTOCOL_VERSION,
      type: 'UNKNOWN_TYPE',
      stream: 'x',
    });
    expect(result).toBeNull();
  });

  it('throws for missing lineage object', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
      })
    ).toThrow('LINEAGE message must include a lineage object');
  });

  it('throws for missing output object', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('LINEAGE message lineage.output must be an object');
  });

  it('throws for empty output.table', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: '', column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('LINEAGE message lineage.output.table must be a non-empty string');
  });

  it('throws for invalid upstream entry source_type', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [{ source_type: 'invalid_type', table: 'foo', column: 'bar' }],
          is_complete: false,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('source_type must be one of');
  });

  it('throws for missing is_complete', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [],
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('LINEAGE message lineage.is_complete must be a boolean');
  });

  it('throws for invalid generated_at timestamp', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: 'not-a-timestamp',
        },
      })
    ).toThrow('ISO 8601 timestamp');
  });

  it('throws for non-string transform_ref', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
          transform_ref: 123,
        },
      })
    ).toThrow('transform_ref must be a string');
  });

  it('throws for oversized output.table', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'x'.repeat(301), column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('lineage.output.table exceeds');
  });

  it('throws for oversized output.column', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'x'.repeat(301) },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('lineage.output.column exceeds');
  });

  it('throws for oversized upstream table', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [{ source_type: 'warehouse', table: 'x'.repeat(301), column: 'id' }],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('upstream[0].table exceeds');
  });

  it('throws for oversized upstream column', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [{ source_type: 'warehouse', table: 'raw.accounts', column: 'x'.repeat(301) }],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('upstream[0].column exceeds');
  });

  it('throws for oversized upstream field_path', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [
            {
              source_type: 'warehouse',
              table: 'raw.accounts',
              column: 'data',
              field_path: 'x'.repeat(301),
            },
          ],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
        },
      })
    ).toThrow('upstream[0].field_path exceeds');
  });

  it('throws for oversized transform_ref', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
          transform_ref: 'x'.repeat(301),
        },
      })
    ).toThrow('transform_ref exceeds');
  });

  it('throws for oversized transform_step', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LINEAGE',
        stream: 'company__entity_profile',
        lineage: {
          output: { table: 'entity_graph.lineage', column: 'name' },
          upstream: [],
          is_complete: true,
          generated_at: '2026-04-30T00:00:00Z',
          transform_step: 'x'.repeat(301),
        },
      })
    ).toThrow('transform_step exceeds');
  });
});
