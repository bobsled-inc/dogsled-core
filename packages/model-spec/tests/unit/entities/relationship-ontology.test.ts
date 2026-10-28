import { describe, expect, it } from 'vitest';

import {
  MentionExtractionSpecSchema,
  RelationshipExtractionSpecSchema,
  RelationshipOntologySpecSchema,
} from '../../../src/entities/index.js';

const thresholds = {
  auto_confirm: 0.92,
  review: 0.55,
  auto_reject: 0.3,
};

describe('RelationshipOntologySpecSchema', () => {
  it('accepts a closed ontology with symmetric exclusivity', () => {
    const parsed = RelationshipOntologySpecSchema.parse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'competes_with',
          description: 'Companies selling into the same market.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          aliases: ['rivals'],
          exclusive_with: ['partners_with'],
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
        {
          relation_type: 'partners_with',
          description: 'Companies partnering on deals.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          exclusive_with: ['competes_with'],
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
      ],
    });

    expect(parsed.relations[0]?.relation_type).toBe('competes_with');
  });

  it('accepts a relation with full relationship_semantics block', () => {
    const parsed = RelationshipOntologySpecSchema.parse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'customer_uses_product',
          description: 'Customer uses product.',
          left_entity: 'Customer',
          right_entity: 'Product',
          direction: 'directed',
          cardinality: 'many_to_many',
          temporal: 'stateful',
          review_thresholds: thresholds,
          relationship_semantics: {
            definition: 'The customer actively runs the product in production.',
            positive_examples: ['Globex has deployed MCP to production.'],
            negative_examples: ['Globex is evaluating MCP.'],
            signal_phrases: ['deployed', 'running'],
          },
        },
      ],
    });

    expect(parsed.relations[0]?.relationship_semantics?.signal_phrases).toEqual([
      'deployed',
      'running',
    ]);
  });

  it('rejects relationship_semantics definition with empty string', () => {
    const parsed = RelationshipOntologySpecSchema.safeParse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'customer_uses_product',
          description: 'Customer uses product.',
          left_entity: 'Customer',
          right_entity: 'Product',
          direction: 'directed',
          cardinality: 'many_to_many',
          temporal: 'stateful',
          review_thresholds: thresholds,
          relationship_semantics: {
            definition: '',
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('defaults relationship_semantics examples and signal phrases to []', () => {
    const parsed = RelationshipOntologySpecSchema.parse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'customer_uses_product',
          description: 'Customer uses product.',
          left_entity: 'Customer',
          right_entity: 'Product',
          direction: 'directed',
          cardinality: 'many_to_many',
          temporal: 'stateful',
          review_thresholds: thresholds,
          relationship_semantics: {
            definition: 'The customer actively runs the product in production.',
          },
        },
      ],
    });

    expect(parsed.relations[0]?.relationship_semantics).toEqual({
      definition: 'The customer actively runs the product in production.',
      positive_examples: [],
      negative_examples: [],
      signal_phrases: [],
    });
  });

  it('rejects aliases that collide with canonical relation types', () => {
    const parsed = RelationshipOntologySpecSchema.safeParse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'competes_with',
          description: 'Competitors.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          aliases: ['partners_with'],
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
        {
          relation_type: 'partners_with',
          description: 'Partners.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects asymmetric exclusive_with rules', () => {
    const parsed = RelationshipOntologySpecSchema.safeParse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'competes_with',
          description: 'Competitors.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          exclusive_with: ['partners_with'],
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
        {
          relation_type: 'partners_with',
          description: 'Partners.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects relations that mark themselves exclusive', () => {
    const parsed = RelationshipOntologySpecSchema.safeParse({
      spec_version: '0.2',
      type: 'relationship_ontology',
      name: 'default',
      relations: [
        {
          relation_type: 'competes_with',
          description: 'Competitors.',
          left_entity: 'customer',
          right_entity: 'customer',
          direction: 'symmetric',
          cardinality: 'many_to_many',
          exclusive_with: ['competes_with'],
          temporal: 'stateful',
          review_thresholds: thresholds,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('RelationshipExtractionSpecSchema', () => {
  it('applies production defaults while keeping ontology_ref required', () => {
    const parsed = RelationshipExtractionSpecSchema.parse({
      spec_version: '0.2',
      type: 'relationship_extraction',
      name: 'business_relations',
      ontology_ref: 'default',
      extraction: {
        role: 'relationship_extraction_v1',
        prompt_version: 'v1',
      },
    });

    expect(parsed.chunk_filter.has_resolved_mentions_min).toBe(2);
    expect(parsed.candidate_pair_rules.max_pairs_per_chunk).toBe(8);
    expect(parsed.candidate_pair_rules.max_pair_span_distance_chars).toBe(500);
    expect(parsed.extraction.constrained_decoding).toBe(true);
  });
});

describe('MentionExtractionSpecSchema', () => {
  it('accepts optional ontology_ref for ontology-aware filtering', () => {
    const parsed = MentionExtractionSpecSchema.parse({
      spec_version: '0.2',
      type: 'mention_extraction',
      name: 'mentions',
      entity_types: ['customer', 'person'],
      ontology_ref: 'default',
    });

    expect(parsed.ontology_ref).toBe('default');
    expect(parsed.candidate_retrieval.strategy).toBe('hybrid');
  });

  it('accepts production surface filters and rejects invalid regex filters', () => {
    const parsed = MentionExtractionSpecSchema.parse({
      spec_version: '0.2',
      type: 'mention_extraction',
      name: 'mentions',
      entity_types: ['customer'],
      surface_filters: {
        stopwords: ['cloud run service'],
        exclude_regex: ['^User & Group$'],
        min_chars: 3,
        max_words: 5,
      },
    });

    expect(parsed.surface_filters?.min_chars).toBe(3);
    expect(
      MentionExtractionSpecSchema.safeParse({
        spec_version: '0.2',
        type: 'mention_extraction',
        name: 'mentions',
        entity_types: ['customer'],
        surface_filters: { exclude_regex: ['['] },
      }).success
    ).toBe(false);
  });
});
