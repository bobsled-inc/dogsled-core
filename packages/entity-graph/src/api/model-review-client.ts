/**
 * Model-backed review judge (Option 1) — an `LlmClient` for `runAgentReview`
 * built on `@bobsled-inc/ai`.
 *
 * Resolves `agent_policy.model` as a role against `platform.models` in
 * dogsled.yml (exactly like `createAiMentionLlmCall`), then makes one
 * structured, temperature-0 call per batch of pairs. Per-call and daily
 * budgets from `@bobsled-inc/ai` apply through `generateStructured`.
 *
 * The client is deliberately NON-THROWING: schema violations, provider
 * errors, and budget stops degrade to `defer` decisions for the affected
 * batch, with warnings collected on {@link ModelReviewLlmClient.usage}.
 * `runAgentReview` propagates client throws, so fail-soft lives here.
 */

import { z } from 'zod';

import { generateStructured, resolveModelConnection } from '@bobsled-inc/ai';

import type {
  AgentReviewOptions,
  LlmClient,
  PairContext,
  PairDecision,
  ResolvedEntitySemantics,
} from '../compiler/identity/types.js';
import { loadPlatformResolution } from './extract-project-utils.js';

const PairReviewResponseSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            pairId: z.string(),
            decision: z.enum(['merge', 'not_match', 'defer']),
            confidence: z.number(),
            reasoning: z.string(),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

export interface ModelReviewUsage {
  costUsd: number;
  tokensUsed: number;
  /** Fail-soft diagnostics accumulated across batches. */
  warnings: string[];
  /** True once `maxCostUsd` (or the provider's daily budget) stops the judge. */
  costCeilingReached: boolean;
}

/** An `LlmClient` that also reports real cost/token usage and warnings. */
export interface ModelReviewLlmClient extends LlmClient {
  usage(): ModelReviewUsage;
}

export interface CreateModelReviewLlmClientOptions {
  /** Model role name — a key in dogsled.yml's `platform.models`. */
  role: string;
  /** Project directory; dogsled.yml is discovered upward from here. */
  cwd: string;
  /** Entity name, used in the prompt. */
  entity: string;
  entitySemantics?: ResolvedEntitySemantics;
  /** Precedent text folded into the prompt (e.g. extracted learnings). */
  learningContext?: string;
  /**
   * Hard cost ceiling across all batches this client reviews. Once actual
   * accumulated cost reaches it, remaining batches defer without a model call.
   */
  maxCostUsd?: number;
}

export interface ModelReviewPromptInput {
  entity: string;
  pairs: PairContext[];
  entitySemantics?: ResolvedEntitySemantics;
  learningContext?: string;
  /** `agent_policy.prompt_template` — replaces the default instruction preamble. */
  promptTemplate?: string;
}

const DEFAULT_INSTRUCTIONS = (entity: string): string =>
  [
    `You are an entity-resolution review judge. Candidate pairs of '${entity}' records scored inside the uncertain band; adjudicate each pair.`,
    ``,
    `For every pair decide:`,
    `- "merge" — the two records refer to the same real-world entity.`,
    `- "not_match" — they refer to different entities.`,
    `- "defer" — the evidence is genuinely insufficient to tell. Use defer honestly rather than guessing.`,
    ``,
    `Rules:`,
    `- Judge ONLY from the evidence provided (field values, per-field similarity scores, composite score). Do not assume unseen data.`,
    `- Report an honest confidence in [0, 1] for each decision. Do not inflate confidence.`,
    `- Keep reasoning to one or two sentences citing the decisive fields.`,
  ].join('\n');

/** Build the system + user prompt for one batch of pairs. Exported for tests. */
export function buildModelReviewPrompt(input: ModelReviewPromptInput): {
  system: string;
  user: string;
} {
  const { entity, pairs, entitySemantics, learningContext, promptTemplate } = input;
  const sections: string[] = [promptTemplate?.trim() || DEFAULT_INSTRUCTIONS(entity)];

  if (entitySemantics) {
    const semantics: string[] = [`<entity_semantics>`];
    if (entitySemantics.definition) {
      semantics.push(`Definition: ${entitySemantics.definition}`);
    }
    for (const category of entitySemantics.categories ?? []) {
      semantics.push(`Category ${category.name}: ${category.description}`);
    }
    for (const example of entitySemantics.positiveExamples ?? []) {
      semantics.push(`Same entity example: ${example}`);
    }
    for (const example of entitySemantics.negativeExamples ?? []) {
      semantics.push(`Different entity example: ${example}`);
    }
    semantics.push(`</entity_semantics>`);
    sections.push(semantics.join('\n'));
  }

  if (learningContext?.trim()) {
    sections.push(`<precedents>\n${learningContext.trim()}\n</precedents>`);
  }

  sections.push(
    `Return one decision per pair, keyed by its pairId. Every listed pair must appear exactly once.`
  );

  const user = JSON.stringify(
    {
      pairs: pairs.map((pair) => ({
        pairId: pair.pairId,
        sourceA: pair.sourceA,
        sourceB: pair.sourceB,
        compositeScore: pair.compositeScore,
        fields: pair.fields,
      })),
    },
    null,
    2
  );

  return { system: sections.join('\n\n'), user };
}

function deferAll(pairs: PairContext[], reasoning: string): PairDecision[] {
  return pairs.map((pair) => ({
    pairId: pair.pairId,
    decision: 'defer',
    confidence: 0,
    reasoning,
  }));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Create the in-Dogsled model judge for one entity, or `undefined` when the
 * role is not configured under `platform.models` (mirrors
 * `createAiMentionLlmCall` — the caller decides how to degrade).
 */
export async function createModelReviewLlmClient(
  options: CreateModelReviewLlmClientOptions
): Promise<ModelReviewLlmClient | undefined> {
  const resolution = loadPlatformResolution(options.cwd);
  if (!resolution.platform?.models?.[options.role]) return undefined;
  const connection = resolveModelConnection(options.role, { platform: resolution.platform });

  let costUsd = 0;
  let tokensUsed = 0;
  let costCeilingReached = false;
  const warnings: string[] = [];

  const reviewPairs = async (
    pairs: PairContext[],
    reviewOptions: AgentReviewOptions
  ): Promise<PairDecision[]> => {
    if (pairs.length === 0) return [];
    if (costCeilingReached) {
      // Mirror runAgentReview's ceiling semantics: undecided pairs get NO
      // decision (they stay in the agent queue for the next run) rather than
      // a persisted defer that would route them to the human queue.
      return [];
    }

    const prompt = buildModelReviewPrompt({
      entity: options.entity,
      pairs,
      ...(options.entitySemantics ? { entitySemantics: options.entitySemantics } : {}),
      ...((reviewOptions.learningContext ?? options.learningContext)
        ? { learningContext: reviewOptions.learningContext ?? options.learningContext }
        : {}),
      ...(reviewOptions.promptTemplate ? { promptTemplate: reviewOptions.promptTemplate } : {}),
    });

    const result = await generateStructured(
      connection,
      {
        schema: PairReviewResponseSchema,
        prompt: prompt.user,
        system: prompt.system,
        temperature: 0,
        ...(options.maxCostUsd !== undefined
          ? { costBudgetUsd: Math.max(options.maxCostUsd - costUsd, 0) }
          : {}),
      },
      {
        platform: resolution.platform,
        projectKey: resolution.projectKey,
      }
    );

    if (!result.ok) {
      warnings.push(
        `Model review batch failed (${result.error}): ${result.message}. Deferred ${pairs.length} pair(s).`
      );
      if (result.error === 'budget_exceeded') {
        // The daily/per-call budget is a persistent stop for this run — do not
        // keep hammering the provider on subsequent batches.
        costCeilingReached = true;
      }
      return deferAll(pairs, `Model review unavailable (${result.error}); deferred.`);
    }

    warnings.push(...(result.warnings ?? []));
    costUsd += result.costUsd;
    tokensUsed += result.tokenUsage;
    if (options.maxCostUsd !== undefined && costUsd >= options.maxCostUsd) {
      costCeilingReached = true;
    }

    const knownPairIds = new Set(pairs.map((pair) => pair.pairId));
    const byPairId = new Map<string, PairDecision>();
    for (const decision of result.value.decisions) {
      if (!knownPairIds.has(decision.pairId)) {
        warnings.push(`Model returned a decision for unknown pair '${decision.pairId}'; dropped.`);
        continue;
      }
      if (byPairId.has(decision.pairId)) {
        warnings.push(
          `Model returned duplicate decisions for pair '${decision.pairId}'; kept the first.`
        );
        continue;
      }
      byPairId.set(decision.pairId, {
        pairId: decision.pairId,
        decision: decision.decision,
        confidence: clampConfidence(decision.confidence),
        reasoning: decision.reasoning,
      });
    }

    const missing = pairs.filter((pair) => !byPairId.has(pair.pairId));
    if (missing.length > 0) {
      warnings.push(`Model omitted ${missing.length} pair(s) from its response; deferred them.`);
    }

    return pairs.map(
      (pair) =>
        byPairId.get(pair.pairId) ?? {
          pairId: pair.pairId,
          decision: 'defer' as const,
          confidence: 0,
          reasoning: 'Model omitted this pair from its response; deferred.',
        }
    );
  };

  return {
    reviewPairs,
    usage: () => ({ costUsd, tokensUsed, warnings: [...warnings], costCeilingReached }),
  };
}
