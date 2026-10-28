import { describe, expect, it } from 'vitest';

import {
  buildSurfaceProposalPrompt,
  proposeSurfaces,
} from '../../src/runtime/mention/surface-proposer.js';
import type { SurfaceProposalInput } from '../../src/runtime/mention/surface-proposer.js';

const input: SurfaceProposalInput = {
  chunk_id: 'chunk_1',
  chunk_text: 'Globex has deployed MCP to production.',
  document_id: 'doc_1',
  document_version_id: 'doc_1@v1',
  allowed_entity_types: ['Customer', 'Product'],
  entity_semantics: [
    {
      entity_type: 'Customer',
      definition: 'A business account or design partner.',
      positive_examples: ['Globex requested product support.'],
      negative_examples: ['MCP is a product surface.'],
    },
    {
      entity_type: 'Product',
      definition: 'A Dogsled product, product area, or rollout surface.',
      positive_examples: ['MCP is deployed in production.'],
      negative_examples: ['Globex is a customer.'],
    },
  ],
};

describe('proposeSurfaces', () => {
  it('returns typed ProposedSurface[] with entity_type in allowed_entity_types', async () => {
    const result = await proposeSurfaces(input, async () => ({
      ok: true,
      tokenUsage: 17,
      costUsd: 0.01,
      value: {
        surfaces: [
          {
            surface_text: 'Globex',
            entity_type: 'Customer',
            span_start: 0,
            span_end: 6,
            source_confidence: 0.91,
          },
          {
            surface_text: 'MCP',
            entity_type: 'Product',
            span_start: 20,
            span_end: 23,
            source_confidence: 0.93,
          },
        ],
      },
    }));

    expect(result).toEqual({
      ok: true,
      tokenUsage: 17,
      costUsd: 0.01,
      surfaces: [
        {
          surface_text: 'Globex',
          entity_type: 'Customer',
          span_start: 0,
          span_end: 6,
          source_confidence: 0.91,
        },
        {
          surface_text: 'MCP',
          entity_type: 'Product',
          span_start: 20,
          span_end: 23,
          source_confidence: 0.93,
        },
      ],
    });
  });

  it('rejects proposals with entity_type not in allowed_entity_types via schema_violation', async () => {
    const result = await proposeSurfaces(input, async () => ({
      ok: true,
      tokenUsage: 17,
      costUsd: 0.01,
      value: {
        surfaces: [
          {
            surface_text: 'MCP',
            entity_type: 'CustomerLikeThing',
            span_start: 20,
            span_end: 23,
            source_confidence: 0.93,
          },
        ],
      },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('schema_violation');
      expect(result.message).toContain('outside allowed_entity_types');
    }
  });

  it('rejects non-empty proposals when allowed_entity_types is empty', async () => {
    const result = await proposeSurfaces({ ...input, allowed_entity_types: [] }, async () => ({
      ok: true,
      tokenUsage: 17,
      costUsd: 0.01,
      value: {
        surfaces: [
          {
            surface_text: 'MCP',
            entity_type: 'Product',
            span_start: 20,
            span_end: 23,
            source_confidence: 0.93,
          },
        ],
      },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('schema_violation');
      expect(result.message).toContain('allowed_entity_type');
    }
  });

  it('rejects proposals with invalid confidence', async () => {
    const result = await proposeSurfaces(input, async () => ({
      ok: true,
      tokenUsage: 17,
      costUsd: 0.01,
      value: {
        surfaces: [
          {
            surface_text: 'MCP',
            entity_type: 'Product',
            span_start: 20,
            span_end: 23,
            source_confidence: 1.2,
          },
        ],
      },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('schema_violation');
      expect(result.message).toContain('source_confidence');
    }
  });

  it('surfaces budget_exceeded unchanged', async () => {
    const result = await proposeSurfaces(input, async () => ({
      ok: false,
      error: 'budget_exceeded',
      message: 'daily budget exceeded',
      attempts: 1,
    }));

    expect(result).toEqual({
      ok: false,
      error: 'budget_exceeded',
      message: 'daily budget exceeded',
      attempts: 1,
    });
  });

  it('renders entity_semantics into the prompt', () => {
    const prompt = buildSurfaceProposalPrompt(input);

    expect(prompt.user).toContain('<entity_type name="Customer">');
    expect(prompt.user).toContain('<definition>A business account or design partner.</definition>');
    expect(prompt.user).toContain('<positive_examples>');
    expect(prompt.user).toContain('<negative_examples>');
    expect(prompt.user).toContain('<entity_type name="Product"/>');
  });
});
