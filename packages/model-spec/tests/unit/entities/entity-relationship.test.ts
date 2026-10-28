import { describe, expect, it } from 'vitest';

import { EntityRelationshipSpecSchema } from '../../../src/entities/entity-relationship.js';

describe('EntityRelationshipSpecSchema', () => {
  const base = {
    spec_version: '0.2' as const,
    type: 'entity_relationship' as const,
    name: 'works_at',
    left_entity: 'contact',
    right_entity: 'company',
    join_columns: [{ left: 'email_domain', right: 'domain' }],
    relationship_type: 'many_to_one' as const,
    review: {
      thresholds: {
        auto_confirm: 0.92,
        review: 0.65,
        auto_reject: 0.4,
      },
    },
  };

  it('accepts a minimal entity relationship and defaults join_type', () => {
    const parsed = EntityRelationshipSpecSchema.parse(base);

    expect(parsed.join_type).toBe('inner');
    expect(parsed.join_columns).toEqual([{ left: 'email_domain', right: 'domain' }]);
  });

  it('accepts dotted profile attribute paths', () => {
    const parsed = EntityRelationshipSpecSchema.parse({
      ...base,
      join_columns: [{ left: 'employment.domain', right: 'profile.domain' }],
    });

    expect(parsed.join_columns[0]?.left).toBe('employment.domain');
  });

  it('accepts confidence, temporal, and review extensions', () => {
    const parsed = EntityRelationshipSpecSchema.parse({
      ...base,
      confidence_scoring: {
        features: [{ field: 'email_domain', algorithm: 'exact', weight: 1 }],
      },
      temporal: {
        validity_field_left: 'employment_started_at',
      },
      review: {
        thresholds: {
          auto_confirm: 0.92,
          review: 0.65,
          auto_reject: 0.4,
        },
      },
      tags: ['b2b'],
    });

    expect(parsed.confidence_scoring?.features).toHaveLength(1);
    expect(parsed.review?.thresholds.review).toBe(0.65);
  });

  it('rejects confidence algorithms unsupported by the relationship compiler', () => {
    expect(() =>
      EntityRelationshipSpecSchema.parse({
        ...base,
        confidence_scoring: {
          features: [{ field: 'email_domain', algorithm: 'semantic_similarity', weight: 1 }],
        },
      })
    ).toThrow();
  });

  it('rejects invalid join_type values shared with Model Spec relationships', () => {
    expect(() => EntityRelationshipSpecSchema.parse({ ...base, join_type: 'right' })).toThrow();
    expect(() => EntityRelationshipSpecSchema.parse({ ...base, join_type: 'full' })).toThrow();
  });

  it('accepts all four relationship_type cardinalities', () => {
    for (const cardinality of [
      'one_to_one',
      'one_to_many',
      'many_to_one',
      'many_to_many',
    ] as const) {
      expect(
        EntityRelationshipSpecSchema.parse({ ...base, relationship_type: cardinality })
          .relationship_type
      ).toBe(cardinality);
    }
  });

  it('rejects Model Spec-only relationship fields', () => {
    expect(() =>
      EntityRelationshipSpecSchema.parse({
        ...base,
        left_model: 'stg_contacts',
        right_model: 'stg_companies',
      })
    ).toThrow();
  });

  it('allows non-tautological same-entity relationships', () => {
    const parsed = EntityRelationshipSpecSchema.parse({
      ...base,
      name: 'subsidiary_of',
      left_entity: 'company',
      right_entity: 'company',
      join_columns: [{ left: 'parent_domain', right: 'domain' }],
      relationship_type: 'many_to_one',
    });

    expect(parsed.left_entity).toBe(parsed.right_entity);
  });

  it('rejects tautological same-entity relationships', () => {
    expect(() =>
      EntityRelationshipSpecSchema.parse({
        ...base,
        name: 'company_self',
        left_entity: 'company',
        right_entity: 'company',
        join_columns: [{ left: 'domain', right: 'domain' }],
      })
    ).toThrow(/Self entity relationships/);
  });

  it('rejects unknown top-level fields', () => {
    expect(() => EntityRelationshipSpecSchema.parse({ ...base, unknown: 'x' })).toThrow();
  });
});
