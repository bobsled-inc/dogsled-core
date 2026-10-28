/**
 * External reviewer transport (Option 2) — an `LlmClient` for `runAgentReview`
 * that ships review pairs to a bring-your-own agent and reads decisions back.
 *
 * Two transports, selected by `agent_policy.reviewer.kind`:
 *   - `http`: POST `entity_graph_review_request.v1` (cross-repo contract §3)
 *     with a bearer token; handles both sync `200 {decisions}` and async
 *     `202 {job_id}` + `GET {url}/{job_id}` polling.
 *   - `command`: spawn the configured command, request JSON on stdin,
 *     `{decisions}` on stdout, killed at `timeout_s`. The request travels on
 *     stdin only — untrusted values are never interpolated into the command
 *     line. The command string itself is user config and runs with the
 *     invoking user's local privileges (this is the BYO/no-API path).
 *
 * Like `createModelReviewLlmClient`, the client is deliberately NON-THROWING:
 * timeouts, transport failures, and malformed output degrade to NO decisions
 * for the affected batch (the pairs stay in the review queue for the next
 * run — deliberately not `defer`, which would route them to the human queue),
 * with warnings collected on {@link ExternalReviewerLlmClient.usage}. Each
 * `reviewPairs` batch gets its own `timeout_s` budget.
 */

import { spawn } from 'node:child_process';
import { reviewerCommandArgs, reviewerCommandEnv } from './reviewer-command.js';

import type { SecretResolver } from '@bobsled-inc/connections';
import { CommandError, parseEnvPlaceholder } from '@bobsled-inc/protocol';
import { z } from 'zod';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type {
  LlmClient,
  PairContext,
  PairDecision,
  ResolvedEntitySemantics,
  ReviewerConfig,
} from '../compiler/identity/types.js';
import type { ModelReviewUsage } from './model-review-client.js';

export const REVIEW_REQUEST_VERSION = 'entity_graph_review_request.v1';

const DEFAULT_TIMEOUT_S = 300;
const DEFAULT_POLL_INTERVAL_S = 5;

/** Cap on the stderr excerpt quoted in command-transport warnings. */
const STDERR_EXCERPT_CHARS = 300;

/** Caps on captured command output — a runaway reviewer must not exhaust memory. */
const MAX_COMMAND_STDOUT_CHARS = 8 * 1024 * 1024;
const MAX_COMMAND_STDERR_CHARS = 64 * 1024;

/** `job` block of the review request: what Dogsled is asking for, and how long it will wait. */
export interface ExternalReviewJobV1 {
  entity: string;
  max_pairs: number;
  timeout_s: number;
  /**
   * Optional hard cost ceiling for this review run (`agent_policy.max_cost_usd`).
   * Additive to the contract: absent unless the policy sets it. A reviewer that
   * reports `usage.cost_usd` can use this to stop early; Dogsled also stops
   * dispatching batches once the reported cost reaches it.
   */
  max_cost_usd?: number;
}

/** snake_case `entity_semantics` as external agents see it (contract §3). */
export interface ExternalReviewEntitySemanticsV1 {
  definition?: string;
  categories?: Array<{ name: string; description: string }>;
  positive_examples?: string[];
  negative_examples?: string[];
}

/** `context` block of the review request: prompt-shaping metadata for the reviewer. */
export interface ExternalReviewContextV1 {
  entity_semantics?: ExternalReviewEntitySemanticsV1;
  learning_context?: string;
  target_schema: string;
  dialect: string;
}

/**
 * Wire shape POSTed to the reviewer (contract §3). `pairs` is Dogsled's
 * camelCase `PairContext[]` verbatim; `context.entity_semantics` is the
 * snake_case YAML shape so external agents see the documented contract.
 */
export interface ExternalReviewRequestV1 {
  version: typeof REVIEW_REQUEST_VERSION;
  job: ExternalReviewJobV1;
  context: ExternalReviewContextV1;
  pairs: PairContext[];
}

/** An `LlmClient` that also reports real cost/token usage and fail-soft warnings via `usage()`. */
export interface ExternalReviewerLlmClient extends LlmClient {
  usage(): ModelReviewUsage;
}

export interface ExternalReviewerClientDeps {
  /** Resolves the `auth_token` env placeholder to its plaintext value. */
  secretResolver: SecretResolver;
  /** Entity name, sent as `job.entity`. */
  entity: string;
  dialect: SupportedDialect;
  targetSchema: string;
  /** Working directory for `kind: command` (usually the project dir). */
  cwd?: string;
  entitySemantics?: ResolvedEntitySemantics;
  /** Precedent text sent as `context.learning_context`. */
  learningContext?: string;
  /**
   * Hard cost ceiling across all batches this client reviews
   * (`agent_policy.max_cost_usd`). Sent as `job.max_cost_usd`; once the
   * reviewer's reported `usage.cost_usd` accumulates to it, remaining batches
   * are skipped (undecided pairs stay in the queue) — mirrors the model judge.
   */
  maxCostUsd?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Optional `usage` block a reviewer may attach to a decisions response
 * (contract §3, additive). Both fields are optional; an absent block is a
 * no-op. Accumulated across batches into {@link ExternalReviewerLlmClient.usage}.
 */
export interface ExternalReviewUsageV1 {
  tokens_used?: number;
  cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Wire schemas — lenient (`z.object` strips unknown keys) toward external
// agents; only the fields Dogsled consumes are validated.
// ---------------------------------------------------------------------------

// Lenient (`.optional()`, unknown keys stripped): an absent or partial `usage`
// block never fails parsing — the reviewer opts in when it can report.
const UsageSchema = z.object({
  tokens_used: z.number().optional(),
  cost_usd: z.number().optional(),
});

// `.catch(undefined)`: a present-but-malformed `usage` (e.g. a stringified
// number) must NOT fail the whole envelope — that would discard a batch's
// valid decisions. It's treated as absent, matching the contract's "malformed
// usage is treated as absent" fail-soft guarantee.
const OptionalUsageSchema = UsageSchema.optional().catch(undefined);

const DecisionsEnvelopeSchema = z.object({
  decisions: z.array(z.unknown()).default([]),
  usage: OptionalUsageSchema,
});

const AsyncAcceptedSchema = z.object({ job_id: z.string().min(1) });

const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({
    status: z.literal('done'),
    decisions: z.array(z.unknown()).default([]),
    usage: OptionalUsageSchema,
  }),
  z.object({ status: z.literal('failed'), error: z.string().optional() }),
]);

const ExternalPairDecisionSchema = z.object({
  pairId: z.string().min(1),
  decision: z.enum(['merge', 'not_match', 'defer']),
  confidence: z.number(),
  reasoning: z.string(),
});

/** Build the `entity_graph_review_request.v1` payload for one batch. */
export function buildReviewRequest(input: {
  entity: string;
  pairs: PairContext[];
  timeoutS: number;
  dialect: SupportedDialect;
  targetSchema: string;
  entitySemantics?: ResolvedEntitySemantics;
  learningContext?: string;
  maxCostUsd?: number;
}): ExternalReviewRequestV1 {
  const { entitySemantics, learningContext, maxCostUsd } = input;
  return {
    version: REVIEW_REQUEST_VERSION,
    job: {
      entity: input.entity,
      max_pairs: input.pairs.length,
      timeout_s: input.timeoutS,
      ...(maxCostUsd !== undefined ? { max_cost_usd: maxCostUsd } : {}),
    },
    context: {
      ...(entitySemantics
        ? {
            entity_semantics: {
              ...(entitySemantics.definition ? { definition: entitySemantics.definition } : {}),
              ...(entitySemantics.categories
                ? { categories: entitySemantics.categories.map((c) => ({ ...c })) }
                : {}),
              ...(entitySemantics.positiveExamples
                ? { positive_examples: [...entitySemantics.positiveExamples] }
                : {}),
              ...(entitySemantics.negativeExamples
                ? { negative_examples: [...entitySemantics.negativeExamples] }
                : {}),
            },
          }
        : {}),
      ...(learningContext ? { learning_context: learningContext } : {}),
      target_schema: input.targetSchema,
      dialect: input.dialect,
    },
    pairs: input.pairs,
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Validate raw reviewer decisions and align them to the batch: invalid
 * entries, unknown pairIds, and duplicates are dropped with warnings;
 * undecided pairs get NO decision (they stay in the review queue). Returned
 * decisions follow the batch's pair order for determinism.
 */
function collectDecisions(
  rawDecisions: unknown[],
  pairs: PairContext[],
  warn: (message: string) => void
): PairDecision[] {
  const knownPairIds = new Set(pairs.map((pair) => pair.pairId));
  const byPairId = new Map<string, PairDecision>();
  let invalidCount = 0;

  for (const raw of rawDecisions) {
    const parsed = ExternalPairDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      invalidCount += 1;
      continue;
    }
    const decision = parsed.data;
    if (!knownPairIds.has(decision.pairId)) {
      warn(`decision for unknown pair '${decision.pairId}' dropped.`);
      continue;
    }
    if (byPairId.has(decision.pairId)) {
      warn(`duplicate decisions for pair '${decision.pairId}'; kept the first.`);
      continue;
    }
    byPairId.set(decision.pairId, {
      pairId: decision.pairId,
      decision: decision.decision,
      confidence: clampConfidence(decision.confidence),
      reasoning: decision.reasoning,
    });
  }

  if (invalidCount > 0) {
    warn(`${invalidCount} malformed decision(s) dropped.`);
  }
  const undecided = pairs.length - byPairId.size;
  if (undecided > 0) {
    warn(`${undecided} pair(s) left undecided; they stay in the review queue.`);
  }

  return pairs.flatMap((pair) => {
    const decision = byPairId.get(pair.pairId);
    return decision ? [decision] : [];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// http transport
// ---------------------------------------------------------------------------

interface HttpTransportContext {
  url: string;
  authToken?: string;
  timeoutS: number;
  pollIntervalS: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
  /** Accumulate a reviewer-reported `usage` block into the client's totals. */
  recordUsage: (usage: ExternalReviewUsageV1 | undefined) => void;
}

async function fetchWithDeadline(
  ctx: HttpTransportContext,
  url: string,
  init: RequestInit,
  deadlineMs: number
): Promise<Response> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error(`timed out after ${ctx.timeoutS}s`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await ctx.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(ctx.authToken ? { authorization: `Bearer ${ctx.authToken}` } : {}),
      },
      // A reviewer endpoint has no legitimate reason to redirect; refusing
      // outright means the bearer token can never be forwarded elsewhere.
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${ctx.timeoutS}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new Error(`response was not valid JSON (${errorMessage(error)})`);
  }
}

async function pollForDecisions(
  ctx: HttpTransportContext,
  jobId: string,
  deadlineMs: number
): Promise<unknown[] | undefined> {
  const pollUrl = `${ctx.url.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}`;
  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      ctx.warn(`poll for job '${jobId}' timed out after ${ctx.timeoutS}s.`);
      return undefined;
    }
    await ctx.sleep(Math.min(ctx.pollIntervalS * 1000, remaining));
    if (Date.now() >= deadlineMs) {
      ctx.warn(`poll for job '${jobId}' timed out after ${ctx.timeoutS}s.`);
      return undefined;
    }

    const response = await fetchWithDeadline(ctx, pollUrl, { method: 'GET' }, deadlineMs);
    if (!response.ok) {
      ctx.warn(`poll for job '${jobId}' returned HTTP ${response.status}.`);
      return undefined;
    }
    const parsed = PollResponseSchema.safeParse(await readJsonBody(response));
    if (!parsed.success) {
      ctx.warn(`poll for job '${jobId}' returned an unrecognized payload.`);
      return undefined;
    }
    if (parsed.data.status === 'running') continue;
    if (parsed.data.status === 'failed') {
      ctx.warn(`job '${jobId}' failed${parsed.data.error ? `: ${parsed.data.error}` : '.'}`);
      return undefined;
    }
    ctx.recordUsage(parsed.data.usage);
    return parsed.data.decisions;
  }
}

async function reviewViaHttp(
  ctx: HttpTransportContext,
  request: ExternalReviewRequestV1,
  pairs: PairContext[]
): Promise<PairDecision[]> {
  try {
    const deadlineMs = Date.now() + ctx.timeoutS * 1000;
    const response = await fetchWithDeadline(
      ctx,
      ctx.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      deadlineMs
    );

    if (response.status === 200) {
      const parsed = DecisionsEnvelopeSchema.safeParse(await readJsonBody(response));
      if (!parsed.success) {
        ctx.warn(`200 response did not contain a decisions array.`);
        return [];
      }
      ctx.recordUsage(parsed.data.usage);
      return collectDecisions(parsed.data.decisions, pairs, ctx.warn);
    }

    if (response.status === 202) {
      const parsed = AsyncAcceptedSchema.safeParse(await readJsonBody(response));
      if (!parsed.success) {
        ctx.warn(`202 response did not contain a job_id.`);
        return [];
      }
      const decisions = await pollForDecisions(ctx, parsed.data.job_id, deadlineMs);
      return decisions ? collectDecisions(decisions, pairs, ctx.warn) : [];
    }

    ctx.warn(`request returned HTTP ${response.status}.`);
    return [];
  } catch (error) {
    ctx.warn(errorMessage(error));
    return [];
  }
}

// ---------------------------------------------------------------------------
// command transport
// ---------------------------------------------------------------------------

async function reviewViaCommand(
  config: { command: string | string[]; timeoutS: number; cwd?: string },
  request: ExternalReviewRequestV1,
  pairs: PairContext[],
  warn: (message: string) => void,
  recordUsage: (usage: ExternalReviewUsageV1 | undefined) => void
): Promise<PairDecision[]> {
  let commandArgs: [string, ...string[]];
  try {
    commandArgs = reviewerCommandArgs(config.command);
  } catch {
    warn('command must be a local executable with arguments, without shell operators.');
    return [];
  }
  const result = await new Promise<{
    outcome: 'ok' | 'timeout' | 'spawn_error' | 'nonzero_exit' | 'oversized';
    stdout: string;
    stderr: string;
    detail?: string;
  }>((resolve) => {
    const [executable, ...args] = commandArgs;
    const child = spawn(executable, args, {
      shell: false,
      env: reviewerCommandEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const settle = (
      outcome: 'ok' | 'timeout' | 'spawn_error' | 'nonzero_exit' | 'oversized',
      detail?: string
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, stdout, stderr, ...(detail !== undefined ? { detail } : {}) });
    };

    const killTree = () => {
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          // No POSIX process groups on Windows — child.kill would only stop
          // the shell, leaving the reviewer running. taskkill reaps the tree.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
          return;
        }
        try {
          process.kill(-child.pid, 'SIGKILL'); // whole process group (detached)
          return;
        } catch {
          // Group already gone or not detached — fall back to the child.
        }
      }
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Settle now rather than on 'close': a killed shell can leave a
      // grandchild holding the stdio pipes, which would delay 'close'
      // indefinitely — and a timed-out reviewer's output is discarded anyway.
      settle('timeout');
    }, config.timeoutS * 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_COMMAND_STDOUT_CHARS) {
        // A runaway reviewer streaming output for the whole timeout window
        // would grow this string without bound — cap it and fail soft.
        killTree();
        settle('oversized');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_COMMAND_STDERR_CHARS) {
        stderr += chunk.toString('utf8');
      }
    });
    // A command that exits before reading stdin raises EPIPE — that surfaces
    // as its exit code / missing output, not as an unhandled error event.
    child.stdin.on('error', () => {});
    child.on('error', (error) => settle('spawn_error', errorMessage(error)));
    child.on('close', (code) => {
      if (timedOut) {
        settle('timeout');
      } else if (code !== 0) {
        settle('nonzero_exit', `exit code ${String(code)}`);
      } else {
        settle('ok');
      }
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });

  const stderrExcerpt = result.stderr.trim().slice(0, STDERR_EXCERPT_CHARS);
  const withStderr = (message: string) =>
    stderrExcerpt ? `${message} stderr: ${stderrExcerpt}` : message;

  if (result.outcome === 'timeout') {
    warn(withStderr(`command timed out after ${config.timeoutS}s and was killed.`));
    return [];
  }
  if (result.outcome === 'spawn_error') {
    warn(`command failed to start: ${result.detail ?? 'unknown error'}.`);
    return [];
  }
  if (result.outcome === 'nonzero_exit') {
    warn(withStderr(`command failed (${result.detail ?? 'nonzero exit'}).`));
    return [];
  }
  if (result.outcome === 'oversized') {
    warn(
      `command produced more than ${String(MAX_COMMAND_STDOUT_CHARS)} characters on stdout and was killed.`
    );
    return [];
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    warn(withStderr(`command stdout was not valid JSON.`));
    return [];
  }
  const parsed = DecisionsEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    warn(`command output did not contain a decisions array.`);
    return [];
  }
  recordUsage(parsed.data.usage);
  return collectDecisions(parsed.data.decisions, pairs, warn);
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create the external reviewer judge for one entity. Resolves the bearer
 * token up front (env placeholder via the project's secret resolver; a
 * non-placeholder value from a host-injected `reviewerOverride` is used
 * as-is). Config-shape problems throw `CommandError(2)`; everything after
 * construction is fail-soft.
 */
export async function createExternalReviewerClient(
  config: ReviewerConfig,
  deps: ExternalReviewerClientDeps
): Promise<ExternalReviewerLlmClient> {
  const warnings: string[] = [];
  const timeoutS = config.timeoutS ?? DEFAULT_TIMEOUT_S;
  const { maxCostUsd } = deps;

  // Real usage, accumulated across batches from the reviewer's optional
  // `usage` block. `costCeilingReached` flips once the reported cost reaches
  // `maxCostUsd`; remaining batches are then skipped (undecided pairs stay in
  // the queue) — the same ceiling semantics as the in-Dogsled model judge.
  let costUsd = 0;
  let tokensUsed = 0;
  let costCeilingReached = false;
  const recordUsage = (usage: ExternalReviewUsageV1 | undefined): void => {
    if (!usage) return;
    // Only accumulate non-negative reports: a buggy reviewer sending a negative
    // cost/token count would otherwise shrink the running total and delay the
    // maxCostUsd ceiling flip.
    if (
      typeof usage.cost_usd === 'number' &&
      Number.isFinite(usage.cost_usd) &&
      usage.cost_usd >= 0
    ) {
      costUsd += usage.cost_usd;
    }
    if (
      typeof usage.tokens_used === 'number' &&
      Number.isFinite(usage.tokens_used) &&
      usage.tokens_used >= 0
    ) {
      tokensUsed += usage.tokens_used;
    }
    if (maxCostUsd !== undefined && costUsd >= maxCostUsd) {
      costCeilingReached = true;
    }
  };

  const makeRequest = (pairs: PairContext[]): ExternalReviewRequestV1 =>
    buildReviewRequest({
      entity: deps.entity,
      pairs,
      timeoutS,
      dialect: deps.dialect,
      targetSchema: deps.targetSchema,
      ...(deps.entitySemantics ? { entitySemantics: deps.entitySemantics } : {}),
      ...(deps.learningContext ? { learningContext: deps.learningContext } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    });

  let reviewBatch: (pairs: PairContext[]) => Promise<PairDecision[]>;
  if (config.kind === 'http') {
    const { url } = config;
    if (!url) {
      throw new CommandError(`agent_policy.reviewer: kind 'http' requires a url.`, 2);
    }
    let authToken: string | undefined;
    if (config.authToken !== undefined) {
      const envVarName = parseEnvPlaceholder(config.authToken);
      authToken =
        envVarName === null ? config.authToken : await deps.secretResolver.resolve(envVarName);
    }
    const ctx: HttpTransportContext = {
      url,
      ...(authToken !== undefined ? { authToken } : {}),
      timeoutS,
      pollIntervalS: config.pollIntervalS ?? DEFAULT_POLL_INTERVAL_S,
      fetchImpl: deps.fetchImpl ?? fetch,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      warn: (message) => warnings.push(`External reviewer (http): ${message}`),
      recordUsage,
    };
    reviewBatch = (pairs) => reviewViaHttp(ctx, makeRequest(pairs), pairs);
  } else {
    const { command } = config;
    if (!command) {
      throw new CommandError(`agent_policy.reviewer: kind 'command' requires a command.`, 2);
    }
    const warn = (message: string) => warnings.push(`External reviewer (command): ${message}`);
    reviewBatch = (pairs) =>
      reviewViaCommand(
        { command, timeoutS, ...(deps.cwd ? { cwd: deps.cwd } : {}) },
        makeRequest(pairs),
        pairs,
        warn,
        recordUsage
      );
  }

  return {
    // Once the cost ceiling is hit, skip the batch: undecided pairs stay in the
    // agent queue for the next run rather than being persisted as `defer`.
    reviewPairs: async (pairs) => {
      if (pairs.length === 0 || costCeilingReached) return [];
      return reviewBatch(pairs);
    },
    usage: () => ({ costUsd, tokensUsed, warnings: [...warnings], costCeilingReached }),
  };
}
