import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CommandError,
  COLUMN_TYPES,
  COLUMN_TYPE_SET,
  LOAD_STRATEGIES,
  LOAD_STRATEGY_SET,
  isColumnType,
  isLoadStrategy,
  isObject,
  parsePositiveInt,
  parseStderrMessage,
  parseRequiredStdoutMessage,
} from '../../src/index.js';

import type {
  StdoutMessage,
  SchemaMessage,
  RecordMessage,
  StateMessage,
  BatchMessage,
  MetricMessage,
  ScalarSchemaColumn,
  SchemaColumn,
  VectorSchemaColumn,
} from '../../src/index.js';

describe('CommandError', () => {
  it('has the correct name property', () => {
    const error = new CommandError('test error');
    expect(error.name).toBe('CommandError');
  });

  it('defaults exitCode to 2', () => {
    const error = new CommandError('test error');
    expect(error.exitCode).toBe(2);
  });

  it('accepts a custom exitCode', () => {
    const error = new CommandError('test error', 1);
    expect(error.exitCode).toBe(1);
  });

  it('extends Error', () => {
    const error = new CommandError('test error');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('test error');
  });
});

describe('COLUMN_TYPES and COLUMN_TYPE_SET consistency', () => {
  it('COLUMN_TYPE_SET contains exactly the same entries as COLUMN_TYPES', () => {
    expect(COLUMN_TYPE_SET.size).toBe(COLUMN_TYPES.length);
    for (const type of COLUMN_TYPES) {
      expect(COLUMN_TYPE_SET.has(type)).toBe(true);
    }
  });

  it('COLUMN_TYPES contains expected types', () => {
    expect(COLUMN_TYPES).toContain('string');
    expect(COLUMN_TYPES).toContain('integer');
    expect(COLUMN_TYPES).toContain('number');
    expect(COLUMN_TYPES).toContain('boolean');
    expect(COLUMN_TYPES).toContain('timestamp');
    expect(COLUMN_TYPES).toContain('array');
    expect(COLUMN_TYPES).toContain('object');
    expect(COLUMN_TYPES).toContain('vector');
  });

  it('COLUMN_TYPE_SET rejects unknown types', () => {
    expect(COLUMN_TYPE_SET.has('varchar')).toBe(false);
    expect(COLUMN_TYPE_SET.has('date')).toBe(false);
    expect(COLUMN_TYPE_SET.has('')).toBe(false);
  });

  it('isColumnType narrows valid types', () => {
    expect(isColumnType('string')).toBe(true);
    expect(isColumnType('integer')).toBe(true);
    expect(isColumnType('unknown')).toBe(false);
    expect(isColumnType('')).toBe(false);
  });
});

describe('SchemaColumn: discriminated union', () => {
  it('vector columns require dimension at the type level', () => {
    const column: VectorSchemaColumn = { name: 'embedding', type: 'vector', dimension: 1536 };
    expect(column.dimension).toBe(1536);
  });

  it('scalar columns do not carry dimension', () => {
    const column: ScalarSchemaColumn = { name: 'id', type: 'integer', primary_key: true };
    expect((column as { dimension?: number }).dimension).toBeUndefined();
  });

  it('narrows on the type discriminator', () => {
    const column: SchemaColumn = { name: 'embedding', type: 'vector', dimension: 768 };
    if (column.type === 'vector') {
      expectTypeOf(column.dimension).toEqualTypeOf<number>();
    }
  });

  it('parses vector dimensions from SCHEMA messages', () => {
    const message = parseRequiredStdoutMessage({
      _v: 1,
      type: 'SCHEMA',
      stream: 'docs',
      schema: {
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'embedding', type: 'vector', dimension: 1536 },
        ],
      },
      key_properties: ['id'],
      load_strategy: 'append',
    });

    expect(message.type).toBe('SCHEMA');
    if (message.type !== 'SCHEMA') {
      return;
    }

    expect(message.schema.columns).toContainEqual({
      name: 'embedding',
      type: 'vector',
      dimension: 1536,
    });
  });

  it('rejects vector columns without dimensions', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: 1,
        type: 'SCHEMA',
        stream: 'docs',
        schema: {
          columns: [{ name: 'embedding', type: 'vector' }],
        },
        key_properties: [],
        load_strategy: 'append',
      })
    ).toThrow(/dimension/);
  });

  describe('embedded_from on vector columns', () => {
    it('parses embedded_from on a vector column', () => {
      const message = parseRequiredStdoutMessage({
        _v: 1,
        type: 'SCHEMA',
        stream: 'docs',
        schema: {
          columns: [
            { name: 'id', type: 'integer', primary_key: true },
            { name: 'description', type: 'string' },
            {
              name: 'description_embedding',
              type: 'vector',
              dimension: 1536,
              embedded_from: {
                column: 'description',
                provider: 'openai',
                model: 'text-embedding-3-small',
              },
            },
          ],
        },
        key_properties: ['id'],
        load_strategy: 'append',
      }) as SchemaMessage;

      const vectorCol = message.schema.columns.find(
        (c) => c.name === 'description_embedding'
      ) as VectorSchemaColumn;
      expect(vectorCol.embedded_from).toEqual({
        column: 'description',
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
    });

    it('parses embedded_from with distance_metric', () => {
      const message = parseRequiredStdoutMessage({
        _v: 1,
        type: 'SCHEMA',
        stream: 'docs',
        schema: {
          columns: [
            { name: 'description', type: 'string' },
            {
              name: 'description_embedding',
              type: 'vector',
              dimension: 1536,
              embedded_from: {
                column: 'description',
                provider: 'openai',
                model: 'text-embedding-3-small',
                distance_metric: 'cosine',
              },
            },
          ],
        },
        key_properties: [],
        load_strategy: 'append',
      }) as SchemaMessage;

      const col = message.schema.columns[1] as VectorSchemaColumn;
      expect(col.embedded_from?.distance_metric).toBe('cosine');
    });

    it('rejects embedded_from referencing an undeclared column', () => {
      expect(() =>
        parseRequiredStdoutMessage({
          _v: 1,
          type: 'SCHEMA',
          stream: 'docs',
          schema: {
            columns: [
              {
                name: 'description_embedding',
                type: 'vector',
                dimension: 1536,
                embedded_from: {
                  column: 'descriptoin', // typo
                  provider: 'openai',
                  model: 'text-embedding-3-small',
                },
              },
            ],
          },
          key_properties: [],
          load_strategy: 'append',
        })
      ).toThrow(/embedded_from\.column/);
    });

    it('rejects embedded_from on a non-vector column', () => {
      expect(() =>
        parseRequiredStdoutMessage({
          _v: 1,
          type: 'SCHEMA',
          stream: 'docs',
          schema: {
            columns: [
              {
                name: 'description',
                type: 'string',
                embedded_from: {
                  column: 'description',
                  provider: 'openai',
                  model: 'text-embedding-3-small',
                },
              },
            ],
          },
          key_properties: [],
          load_strategy: 'append',
        })
      ).toThrow(/embedded_from/);
    });

    it('rejects embedded_from missing required fields', () => {
      expect(() =>
        parseRequiredStdoutMessage({
          _v: 1,
          type: 'SCHEMA',
          stream: 'docs',
          schema: {
            columns: [
              {
                name: 'description_embedding',
                type: 'vector',
                dimension: 1536,
                embedded_from: { column: 'description', provider: 'openai' },
              },
            ],
          },
          key_properties: [],
          load_strategy: 'append',
        })
      ).toThrow();
    });

    it('rejects an unknown distance_metric', () => {
      expect(() =>
        parseRequiredStdoutMessage({
          _v: 1,
          type: 'SCHEMA',
          stream: 'docs',
          schema: {
            columns: [
              {
                name: 'description_embedding',
                type: 'vector',
                dimension: 1536,
                embedded_from: {
                  column: 'description',
                  provider: 'openai',
                  model: 'text-embedding-3-small',
                  distance_metric: 'hamming',
                },
              },
            ],
          },
          key_properties: [],
          load_strategy: 'append',
        })
      ).toThrow(/distance_metric/);
    });
  });
});

describe('LOAD_STRATEGIES and isLoadStrategy', () => {
  it('LOAD_STRATEGY_SET contains exactly the same entries as LOAD_STRATEGIES', () => {
    expect(LOAD_STRATEGY_SET.size).toBe(LOAD_STRATEGIES.length);
    for (const strategy of LOAD_STRATEGIES) {
      expect(LOAD_STRATEGY_SET.has(strategy)).toBe(true);
    }
  });

  it('isLoadStrategy narrows valid strategies', () => {
    expect(isLoadStrategy('append')).toBe(true);
    expect(isLoadStrategy('merge')).toBe(true);
    expect(isLoadStrategy('full_refresh')).toBe(true);
    expect(isLoadStrategy('unknown')).toBe(false);
    expect(isLoadStrategy('')).toBe(false);
  });
});

describe('isObject', () => {
  it('returns true for plain objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ key: 'value' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isObject(null)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2, 3])).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isObject('string')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe('parsePositiveInt', () => {
  it('parses valid positive integers', () => {
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt('42')).toBe(42);
    expect(parsePositiveInt('10000')).toBe(10000);
  });

  it('rejects zero', () => {
    expect(() => parsePositiveInt('0')).toThrow(CommandError);
  });

  it('rejects negative numbers', () => {
    expect(() => parsePositiveInt('-1')).toThrow(CommandError);
  });

  it('rejects non-numeric strings', () => {
    expect(() => parsePositiveInt('abc')).toThrow(CommandError);
    expect(() => parsePositiveInt('')).toThrow(CommandError);
  });

  it('rejects floats', () => {
    expect(() => parsePositiveInt('1.5')).toThrow(CommandError);
  });

  it('rejects leading zeros', () => {
    expect(() => parsePositiveInt('01')).toThrow(CommandError);
  });
});

describe('StdoutMessage type discrimination', () => {
  it('discriminates SCHEMA messages', () => {
    const message: StdoutMessage = {
      _v: 1,
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: ['id'],
      load_strategy: 'merge',
    };
    expect(message.type).toBe('SCHEMA');
    if (message.type === 'SCHEMA') {
      const schema: SchemaMessage = message;
      expect(schema.schema.columns).toHaveLength(1);
      expect(schema.load_strategy).toBe('merge');
    }
  });

  it('discriminates RECORD messages', () => {
    const message: StdoutMessage = {
      _v: 1,
      type: 'RECORD',
      stream: 'issues',
      record: { id: 1, title: 'test' },
      time_extracted: '2026-03-23T00:00:00.000Z',
    };
    expect(message.type).toBe('RECORD');
    if (message.type === 'RECORD') {
      const record: RecordMessage = message;
      expect(record.record).toEqual({ id: 1, title: 'test' });
    }
  });

  it('discriminates STATE messages', () => {
    const message: StdoutMessage = {
      _v: 1,
      type: 'STATE',
      stream: 'issues',
      value: { record_count: 5 },
    };
    expect(message.type).toBe('STATE');
    if (message.type === 'STATE') {
      const state: StateMessage = message;
      expect(state.value.record_count).toBe(5);
    }
  });

  it('discriminates BATCH messages', () => {
    const message: StdoutMessage = {
      _v: 1,
      type: 'BATCH',
      stream: 'issues',
      encoding: { format: 'parquet' },
      manifest: ['file:///tmp/batch-0.parquet'],
    };
    expect(message.type).toBe('BATCH');
    if (message.type === 'BATCH') {
      const batch: BatchMessage = message;
      expect(batch.manifest).toHaveLength(1);
      expect(batch.encoding).toEqual({ format: 'parquet' });
    }
  });
});

describe('MetricMessage embedding fields', () => {
  it('accepts embedding metrics at the type level', () => {
    const message: MetricMessage = {
      _v: 1,
      type: 'METRIC',
      stream: 'docs',
      time: '2026-04-23T00:00:00Z',
      metrics: {
        embedding_api_calls: 5,
        embedding_tokens_processed: 12000,
        embedding_tokens_truncated: 3,
        embedding_duration_ms: 1800,
        embedding_records_processed: 240,
      },
    };

    expect(message.metrics.embedding_api_calls).toBe(5);
  });

  it('parses embedding metrics from stderr messages', () => {
    const message = parseStderrMessage({
      _v: 1,
      type: 'METRIC',
      stream: 'docs',
      time: '2026-04-23T00:00:00Z',
      metrics: {
        embedding_api_calls: 5,
        embedding_tokens_processed: 12000,
        embedding_tokens_truncated: 3,
        embedding_duration_ms: 1800,
        embedding_records_processed: 240,
        embedding_inputs_rejected: 2,
      },
    });

    expect(message).toMatchObject({
      metrics: {
        embedding_api_calls: 5,
        embedding_tokens_processed: 12000,
        embedding_tokens_truncated: 3,
        embedding_duration_ms: 1800,
        embedding_records_processed: 240,
        embedding_inputs_rejected: 2,
      },
    });
  });

  it('retains existing metrics unchanged', () => {
    const message: MetricMessage = {
      _v: 1,
      type: 'METRIC',
      stream: 'docs',
      time: '2026-04-23T00:00:00Z',
      metrics: {
        records_emitted: 10,
      },
    };

    expect(message.metrics.records_emitted).toBe(10);
  });
});
