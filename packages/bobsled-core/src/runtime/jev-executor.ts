import { z } from 'zod';
import type { SecretResolver } from '@bobsled-inc/connections';
import { CommandError, parseEnvPlaceholder } from '@bobsled-inc/protocol';
import {
  AgentAssignmentSchema,
  AgenticUsageSchema,
  parseAgentAssignmentOutcome,
  type ExecuteAgent,
  type AgenticUsage,
} from '@bobsled-inc/model-spec/agentic';

const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  answers: z.object({
    classification: z.object({
      type: z.literal('choice'),
      choice: z.string(),
      confidence: probability,
      probabilities: z.record(z.string(), probability),
    }),
  }),
});

/**
 * Trusted callers supply secret resolution and may inject transport; neither enters saved
 * assignments. The resolver is required: Dogsled never reads model keys from the environment
 * implicitly.
 */
export function createJevExecutor(options: {
  secretResolver: SecretResolver;
  fetch?: typeof fetch;
}): ExecuteAgent {
  const resolver: unknown = (options as { secretResolver?: unknown } | undefined)?.secretResolver;
  if (typeof (resolver as Partial<SecretResolver> | null | undefined)?.resolve !== 'function') {
    throw new CommandError(
      'createJevExecutor requires an explicit secretResolver; Dogsled never reads model keys from the environment implicitly.',
      2
    );
  }
  const secretResolver = resolver as SecretResolver;
  return async (request) => {
    const assignment = AgentAssignmentSchema.parse(request.assignment);
    const connection = assignment.profile.connection;
    if (!assignment.classification || connection.provider !== 'typesafe' || request.sources) {
      throw new Error('Jev requires a classification assignment');
    }
    request.signal.throwIfAborted();
    const remaining =
      (assignment.limits.deadline_at === null
        ? Infinity
        : Date.parse(assignment.limits.deadline_at)) - Date.now();
    if (remaining <= 0) throw new Error('Assignment deadline passed');
    const signal = AbortSignal.any([
      request.signal,
      ...(Number.isFinite(remaining) ? [AbortSignal.timeout(Math.min(remaining, 2147483647))] : []),
    ]);
    const placeholder = parseEnvPlaceholder(connection.api_key);
    if (!placeholder) throw new Error('Jev requires an environment key reference');
    let key: string;
    try {
      key = await secretResolver.resolve(placeholder);
      if (!key.trim() || /[\r\n]/.test(key)) throw new Error();
    } catch {
      throw new Error('Jev credential is unavailable or invalid');
    }
    const body = JSON.stringify({
      model: connection.model,
      state: JSON.stringify(assignment.input.rows[0]),
      questions: {
        classification: {
          type: 'choice',
          instructions: assignment.instructions,
          criteria: assignment.classification.choices,
        },
      },
    });
    if (
      assignment.limits.tokens !== null &&
      Buffer.byteLength(body) + 1024 > assignment.limits.tokens
    ) {
      throw new Error('Jev request exceeds the assignment token allowance');
    }
    signal.throwIfAborted();
    const reservation = await request.budget.reserve(assignment.limits.tokens);
    let usage: AgenticUsage = { status: 'unknown', reason: 'unavailable' };
    let value: unknown;
    let code = 'jev_call_failed';
    let retryable = true;
    try {
      const response = await (options.fetch ?? fetch)('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!response.ok) {
        retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        await response.body?.cancel();
        throw new Error();
      }
      const { readResponseTextWithLimit } = await import('@bobsled-inc/extractor/core');
      value = JSON.parse(await readResponseTextWithLimit(response, 1024 * 1024, 'Jev response'));
      const rawUsage = z
        .object({
          usage: z.object({
            input_tokens: z.number(),
            output_tokens: z.number(),
          }),
        })
        .safeParse(value);
      if (rawUsage.success) {
        const raw = rawUsage.data.usage;
        const measured = AgenticUsageSchema.safeParse({
          status: 'measured',
          ...raw,
          total_tokens: raw.input_tokens + raw.output_tokens,
        });
        if (measured.success) usage = measured.data;
      }
      code = 'jev_invalid_output';
      const result = responseSchema.parse(value).answers.classification;
      const choices = Object.keys(assignment.classification.choices);
      if (
        !choices.includes(result.choice) ||
        Object.keys(result.probabilities).length !== choices.length ||
        choices.some((choice) => !Object.hasOwn(result.probabilities, choice)) ||
        Math.abs(Object.values(result.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.000001 ||
        Object.values(result.probabilities).some(
          (p) => p > result.probabilities[result.choice]! + 0.000001
        )
      ) {
        throw new Error();
      }
      signal.throwIfAborted();
      const outcome = parseAgentAssignmentOutcome(assignment, {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage,
        rows: [
          {
            ...assignment.group_key,
            choice: result.choice,
            confidence: result.confidence,
            _bobsled_evidence: null,
            _bobsled_confidence: result.confidence,
            _bobsled_reason: null,
          },
        ],
      });
      return outcome;
    } catch {
      if (signal.aborted && usage.status === 'unknown') {
        usage = { status: 'unknown', reason: 'interrupted' };
      }
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'failed',
        usage,
        error: {
          kind: signal.aborted
            ? 'cancellation'
            : code === 'jev_invalid_output'
              ? 'validation'
              : 'provider',
          code: signal.aborted ? 'jev_cancelled' : code,
          retryable: !signal.aborted && retryable,
        },
      };
    } finally {
      await request.budget.settle(reservation, usage);
    }
  };
}
