import { describe, it, expect } from 'vitest';

import { SDK_IR_VERSION, emitPythonSdk, emitTypeScriptSdk, parseSdkIr } from '../../src/index.js';

const VECTOR_IR = {
  ir_version: SDK_IR_VERSION,
  entities: [
    {
      name: 'Document',
      primary_key: 'entity_id',
      branded_id_type: 'DocumentId',
      profile_attrs: [
        { name: 'title', type: 'string' as const, nullable: true },
        {
          name: 'description_embedding',
          type: 'vector' as const,
          nullable: true,
          dimension: 1536,
          embedded_from: {
            column: 'description',
            provider: 'openai',
            model: 'text-embedding-3-small',
          },
        },
      ],
      quality_columns: ['confidence'],
      relationships_as_left: [],
      relationships_as_right: [],
    },
  ],
  relationships: [],
  polymorphic_groups: [] as never[],
  dialect_capabilities: {
    supports_json_path: true,
    supports_full_text: true,
    supports_vector: true,
  },
};

describe('vector profile_attrs in SDK IR', () => {
  it('parses an IR with vector profile_attrs + embedded_from', () => {
    const ir = parseSdkIr(VECTOR_IR);
    const attr = ir.entities[0]?.profile_attrs[1];
    expect(attr?.type).toBe('vector');
    if (attr?.type === 'vector') {
      expect(attr.dimension).toBe(1536);
      expect(attr.embedded_from).toEqual({
        column: 'description',
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
    }
  });

  it.each([
    [1536, true],
    [1024, false],
    [0, false],
  ])('checks an embedded_from dimension of %i', (dimension, valid) => {
    const entity = VECTOR_IR.entities[0]!;
    const [title, vector] = entity.profile_attrs;
    const ir = {
      ...VECTOR_IR,
      entities: [
        {
          ...entity,
          profile_attrs: [
            title,
            { ...vector, embedded_from: { ...vector!.embedded_from, dimension } },
          ],
        },
      ],
    };
    if (!valid) {
      expect(() => parseSdkIr(ir)).toThrow();
      return;
    }
    const parsed = parseSdkIr(ir);
    expect(parsed.entities[0]?.profile_attrs[1]?.embedded_from?.dimension).toBe(dimension);
    expect(emitTypeScriptSdk(parsed).length).toBeGreaterThan(0);
    expect(emitPythonSdk(parsed).length).toBeGreaterThan(0);
  });

  it('accepts a reserved distance_metric', () => {
    const ir = parseSdkIr({
      ...VECTOR_IR,
      entities: [
        {
          ...VECTOR_IR.entities[0]!,
          profile_attrs: [
            VECTOR_IR.entities[0]!.profile_attrs[0]!,
            {
              ...VECTOR_IR.entities[0]!.profile_attrs[1]!,
              embedded_from: {
                column: 'description',
                provider: 'openai',
                model: 'text-embedding-3-small',
                distance_metric: 'cosine' as const,
              },
            },
          ],
        },
      ],
    });
    const attr = ir.entities[0]?.profile_attrs[1];
    if (attr?.type === 'vector') {
      expect(attr.embedded_from?.distance_metric).toBe('cosine');
    }
  });

  it('rejects unknown distance_metric values', () => {
    expect(() =>
      parseSdkIr({
        ...VECTOR_IR,
        entities: [
          {
            ...VECTOR_IR.entities[0]!,
            profile_attrs: [
              VECTOR_IR.entities[0]!.profile_attrs[0]!,
              {
                ...VECTOR_IR.entities[0]!.profile_attrs[1]!,
                embedded_from: {
                  column: 'description',
                  provider: 'openai',
                  model: 'text-embedding-3-small',
                  distance_metric: 'hamming',
                },
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  it('rejects scalar attrs that carry vector-only fields', () => {
    expect(() =>
      parseSdkIr({
        ...VECTOR_IR,
        entities: [
          {
            ...VECTOR_IR.entities[0]!,
            profile_attrs: [
              {
                name: 'title',
                type: 'string',
                nullable: true,
                dimension: 1536,
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  it('emits nullable number[] for vector attrs in TypeScript SDK', () => {
    const ir = parseSdkIr(VECTOR_IR);
    const files = emitTypeScriptSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const docFile = files.find((f) => f.path.toLowerCase().includes('document'));
    expect(docFile).toBeDefined();
    // Nullable vector attr → `number[] | null`. Drop the wrapper and we
    // silently regress the emitter contract.
    expect(docFile!.content).toMatch(/description_embedding[?:]*\s*number\[\]\s*\|\s*null/);
  });

  it('emits Optional[list[float]] for vector attrs in Python SDK', () => {
    const ir = parseSdkIr(VECTOR_IR);
    const files = emitPythonSdk(ir, { generatedAt: '2026-05-07T00:00:00Z' });
    const docFile = files.find((f) => f.path.toLowerCase().includes('document'));
    expect(docFile).toBeDefined();
    expect(docFile!.content).toContain('description_embedding: Optional[list[float]]');
  });
});
