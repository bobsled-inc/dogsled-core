import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bobsled-inc/ai', () => ({
  generateStructured: vi.fn(),
  resolveModelConnection: vi.fn(() => ({
    provider: 'anthropic',
    model: 'claude-test',
    api_key: '$ANTHROPIC_API_KEY',
  })),
}));

import { generateStructured } from '@bobsled-inc/ai';

import {
  buildModelReviewPrompt,
  createModelReviewLlmClient,
} from '../../../src/api/model-review-client.js';
import type { AgentReviewOptions, PairContext } from '../../../src/compiler/identity/types.js';

const generateStructuredMock = vi.mocked(generateStructured);

let tmpDir: string;

const REVIEW_OPTIONS: AgentReviewOptions = { batchSize: 10 };

function writeDogsledYml(models = true): void {
  const platform = models
    ? [
        `platform:`,
        `  models:`,
        `    reviewer:`,
        `      provider: anthropic`,
        `      model: claude-test`,
        `      api_key: $ANTHROPIC_API_KEY`,
      ]
    : [`platform: {}`];
  fs.writeFileSync(path.join(tmpDir, 'dogsled.yml'), [`version: 1`, ...platform, ``].join('\n'));
}

function makePair(pairId: string): PairContext {
  return {
    pairId,
    recordAId: `${pairId}-a`,
    recordBId: `${pairId}-b`,
    sourceA: 'shopify',
    sourceB: 'hubspot',
    compositeScore: 0.7,
    fields: { name: { a: 'acme', b: 'acme inc', score: 0.9 } },
  };
}

async function makeClient(overrides: { maxCostUsd?: number } = {}) {
  const client = await createModelReviewLlmClient({
    role: 'reviewer',
    cwd: tmpDir,
    entity: 'company',
    entitySemantics: {
      definition: 'A business entity that transacts with us.',
      categories: [{ name: 'brand', description: 'Consumer-facing brand names' }],
      positiveExamples: ['Acme Ltd ↔ Acme Limited'],
      negativeExamples: ['Acme US ↔ Acme Japan'],
    },
    learningContext: 'Reviewers previously merged domain-equal companies.',
    ...overrides,
  });
  expect(client).toBeDefined();
  return client!;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-model-review-'));
  generateStructuredMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createModelReviewLlmClient', () => {
  it('returns undefined when the role is not configured under platform.models', async () => {
    writeDogsledYml(false);
    const client = await createModelReviewLlmClient({
      role: 'reviewer',
      cwd: tmpDir,
      entity: 'company',
    });
    expect(client).toBeUndefined();
  });

  it('maps a valid structured response to pair decisions at temperature 0', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: true,
      value: {
        decisions: [
          { pairId: 'p1', decision: 'merge', confidence: 0.92, reasoning: 'same domain' },
          { pairId: 'p2', decision: 'not_match', confidence: 1.7, reasoning: 'different org' },
        ],
      },
      tokenUsage: 1200,
      costUsd: 0.01,
    });

    const client = await makeClient();
    const decisions = await client.reviewPairs([makePair('p1'), makePair('p2')], REVIEW_OPTIONS);

    expect(decisions).toEqual([
      { pairId: 'p1', decision: 'merge', confidence: 0.92, reasoning: 'same domain' },
      // Out-of-range confidence is clamped into [0, 1].
      { pairId: 'p2', decision: 'not_match', confidence: 1, reasoning: 'different org' },
    ]);

    const call = generateStructuredMock.mock.calls[0]!;
    expect(call[1].temperature).toBe(0);
    expect(call[1].system).toContain('A business entity that transacts with us.');
    expect(call[1].system).toContain('domain-equal companies');
    expect(call[1].prompt).toContain('"pairId": "p1"');

    expect(client.usage()).toMatchObject({
      costUsd: 0.01,
      tokensUsed: 1200,
      costCeilingReached: false,
      warnings: [],
    });
  });

  it('defers the whole batch on a schema violation, with a warning (fail-soft)', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: false,
      error: 'schema_violation',
      message: 'model returned prose',
      attempts: 1,
    });

    const client = await makeClient();
    const decisions = await client.reviewPairs([makePair('p1'), makePair('p2')], REVIEW_OPTIONS);

    expect(decisions.map((d) => d.decision)).toEqual(['defer', 'defer']);
    expect(decisions.every((d) => d.confidence === 0)).toBe(true);
    expect(client.usage().warnings.some((w) => /schema_violation/.test(w))).toBe(true);
    expect(client.usage().costCeilingReached).toBe(false);
  });

  it('reports unknown pricing without deferring a successful model-review batch', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: true,
      value: {
        decisions: [{ pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'same org' }],
      },
      tokenUsage: 200,
      costUsd: 0,
      warnings: ['No pricing registered for anthropic:future-model; cost is unknown'],
    });

    const client = await makeClient();
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions[0]).toMatchObject({ pairId: 'p1', decision: 'merge' });
    expect(client.usage()).toMatchObject({ costUsd: 0, tokensUsed: 200 });
    expect(client.usage().warnings).toContain(
      'No pricing registered for anthropic:future-model; cost is unknown'
    );
  });

  it('treats budget_exceeded as a persistent stop for subsequent batches', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: false,
      error: 'budget_exceeded',
      message: 'daily AI budget reached',
      attempts: 1,
    });

    const client = await makeClient();
    const first = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    const second = await client.reviewPairs([makePair('p2')], REVIEW_OPTIONS);

    expect(first[0]!.decision).toBe('defer');
    // Batches after the stop return NO decisions — those pairs stay in the
    // agent queue for the next run instead of persisting as deferred.
    expect(second).toEqual([]);
    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(client.usage().costCeilingReached).toBe(true);
  });

  it('passes the remaining maxCostUsd ceiling and stops once it is reached', async () => {
    writeDogsledYml();
    generateStructuredMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          decisions: [{ pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'ok' }],
        },
        tokenUsage: 500,
        costUsd: 0.25,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          decisions: [{ pairId: 'p2', decision: 'merge', confidence: 0.9, reasoning: 'ok' }],
        },
        tokenUsage: 300,
        costUsd: 0.15,
      });

    const client = await makeClient({ maxCostUsd: 0.4 });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    await client.reviewPairs([makePair('p2')], REVIEW_OPTIONS);
    const third = await client.reviewPairs([makePair('p3')], REVIEW_OPTIONS);

    expect(third).toEqual([]);
    expect(generateStructuredMock).toHaveBeenCalledTimes(2);
    expect(generateStructuredMock.mock.calls[0]![1].costBudgetUsd).toBe(0.4);
    expect(generateStructuredMock.mock.calls[1]![1].costBudgetUsd).toBeCloseTo(0.15);
    expect(client.usage().costCeilingReached).toBe(true);
  });

  it('drops unknown pairIds and defers pairs the model omitted', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: true,
      value: {
        decisions: [
          { pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'ok' },
          { pairId: 'ghost', decision: 'merge', confidence: 0.9, reasoning: 'hallucinated' },
        ],
      },
      tokenUsage: 100,
      costUsd: 0.001,
    });

    const client = await makeClient();
    const decisions = await client.reviewPairs([makePair('p1'), makePair('p2')], REVIEW_OPTIONS);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]!).toMatchObject({ pairId: 'p1', decision: 'merge' });
    expect(decisions[1]!).toMatchObject({ pairId: 'p2', decision: 'defer' });
    const warnings = client.usage().warnings;
    expect(warnings.some((w) => /unknown pair 'ghost'/.test(w))).toBe(true);
    expect(warnings.some((w) => /omitted 1 pair/.test(w))).toBe(true);
  });

  it('lets agent_policy.prompt_template replace the default instruction preamble', async () => {
    writeDogsledYml();
    generateStructuredMock.mockResolvedValueOnce({
      ok: true,
      value: { decisions: [] },
      tokenUsage: 10,
      costUsd: 0.0001,
    });

    const client = await makeClient();
    await client.reviewPairs([makePair('p1')], {
      ...REVIEW_OPTIONS,
      promptTemplate: 'CUSTOM JUDGE INSTRUCTIONS',
    });

    const call = generateStructuredMock.mock.calls[0]!;
    expect(call[1].system).toContain('CUSTOM JUDGE INSTRUCTIONS');
    expect(call[1].system).not.toContain('entity-resolution review judge');
  });
});

describe('buildModelReviewPrompt', () => {
  it('renders semantics, precedents, and the pair payload', () => {
    const prompt = buildModelReviewPrompt({
      entity: 'company',
      pairs: [makePair('p1')],
      entitySemantics: { definition: 'def', negativeExamples: ['neg'] },
      learningContext: 'precedent text',
    });
    expect(prompt.system).toContain('def');
    expect(prompt.system).toContain('neg');
    expect(prompt.system).toContain('precedent text');
    expect(prompt.user).toContain('"compositeScore": 0.7');
  });
});
