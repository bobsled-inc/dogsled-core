/**
 * External reviewer transport tests (Phase T2).
 *
 * `http` runs against a real `node:http` server (sync 200, async 202 + poll,
 * poll failure, timeout, garbage, unknown pairIds); `command` runs the fixture
 * scripts under `tests/fixtures/reviewers/` (echo → decisions, hang → kill on
 * timeout). Both transports must be non-throwing: every failure degrades to
 * zero decisions plus warnings on `usage()`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandError, HOST_EMBEDDING_ENV_NAMES } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReviewRequest,
  createExternalReviewerClient,
  REVIEW_REQUEST_VERSION,
  type ExternalReviewerClientDeps,
} from '../../../src/api/external-reviewer-client.js';
import type {
  AgentReviewOptions,
  PairContext,
  ReviewerConfig,
} from '../../../src/compiler/identity/types.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'reviewers'
);
const ECHO_FIXTURE = join(FIXTURES_DIR, 'echo-decisions.mjs');
const HANG_FIXTURE = join(FIXTURES_DIR, 'hang.mjs');

const REVIEW_OPTIONS: AgentReviewOptions = { batchSize: 100 };

function makePair(pairId: string): PairContext {
  return {
    pairId,
    recordAId: `${pairId}-a`,
    recordBId: `${pairId}-b`,
    sourceA: 'crm',
    sourceB: 'billing',
    compositeScore: 0.7,
    fields: { name: { a: 'Acme Corp', b: 'acme corp', score: 0.93 } },
  };
}

function makeDeps(overrides: Partial<ExternalReviewerClientDeps> = {}): ExternalReviewerClientDeps {
  return {
    secretResolver: {
      resolve: async (name) => {
        if (name === 'REVIEWER_TOKEN') return 'secret-token';
        throw new CommandError(`unknown secret ${name}`, 2);
      },
    },
    entity: 'company',
    dialect: 'duckdb',
    targetSchema: 'entity_graph',
    entitySemantics: {
      definition: 'A legal company entity.',
      positiveExamples: ['Acme Corp == acme corp'],
    },
    learningContext: 'precedent text',
    ...overrides,
  };
}

function decisionFor(pairId: string, decision = 'merge', confidence = 0.9): unknown {
  return { pairId, decision, confidence, reasoning: `${decision} ${pairId}` };
}

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

/** Minimal scriptable reviewer server; each handler consumes one request. */
async function startServer(
  handle: (req: RecordedRequest, res: ServerResponse, hit: number) => void
): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      };
      requests.push(recorded);
      handle(recorded, res, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/review`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()));
});

async function reviewer(config: ReviewerConfig, deps: ExternalReviewerClientDeps = makeDeps()) {
  return createExternalReviewerClient(config, deps);
}

describe('buildReviewRequest', () => {
  it('emits the entity_graph_review_request.v1 wire shape (contract §3)', () => {
    const request = buildReviewRequest({
      entity: 'company',
      pairs: [makePair('p1')],
      timeoutS: 300,
      dialect: 'snowflake',
      targetSchema: 'ENTITY_GRAPH',
      entitySemantics: {
        definition: 'A company.',
        categories: [{ name: 'brand', description: 'Consumer brand.' }],
        positiveExamples: ['a == b'],
        negativeExamples: ['c != d'],
      },
      learningContext: 'precedents',
    });

    expect(request).toEqual({
      version: REVIEW_REQUEST_VERSION,
      job: { entity: 'company', max_pairs: 1, timeout_s: 300 },
      context: {
        entity_semantics: {
          definition: 'A company.',
          categories: [{ name: 'brand', description: 'Consumer brand.' }],
          positive_examples: ['a == b'],
          negative_examples: ['c != d'],
        },
        learning_context: 'precedents',
        target_schema: 'ENTITY_GRAPH',
        dialect: 'snowflake',
      },
      // PairContext[] travels camelCase, exactly as the Dogsled type.
      pairs: [makePair('p1')],
    });
  });

  it('adds job.max_cost_usd only when a ceiling is provided (additive)', () => {
    const base = {
      entity: 'company',
      pairs: [makePair('p1')],
      timeoutS: 300,
      dialect: 'duckdb' as const,
      targetSchema: 'entity_graph',
    };
    expect(buildReviewRequest({ ...base, maxCostUsd: 25 }).job).toEqual({
      entity: 'company',
      max_pairs: 1,
      timeout_s: 300,
      max_cost_usd: 25,
    });
    // Absent ceiling → the field is omitted entirely, not emitted as undefined.
    expect(buildReviewRequest(base).job).toEqual({
      entity: 'company',
      max_pairs: 1,
      timeout_s: 300,
    });
  });
});

describe('createExternalReviewerClient — usage reporting (contract §3, additive)', () => {
  it('accumulates a reviewer-reported usage block across batches (sync 200)', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, {
        decisions: [decisionFor('p1')],
        usage: { tokens_used: 1500, cost_usd: 0.25 },
      })
    );
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(client.usage()).toMatchObject({
      tokensUsed: 3000,
      costUsd: 0.5,
      costCeilingReached: false,
    });
  });

  it('accumulates usage from an async poll done body', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'POST') return json(res, 202, { job_id: 'job-usage' });
      return json(res, 200, {
        status: 'done',
        decisions: [decisionFor('p1')],
        usage: { tokens_used: 800, cost_usd: 0.1 },
      });
    });
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url, pollIntervalS: 0.01 });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(client.usage()).toMatchObject({ tokensUsed: 800, costUsd: 0.1 });
  });

  it('treats an absent usage block as a no-op (usage stays zero)', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, { decisions: [decisionFor('p1')] })
    );
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(client.usage()).toMatchObject({
      tokensUsed: 0,
      costUsd: 0,
      costCeilingReached: false,
    });
  });

  it('keeps the decisions when usage is present but malformed (treated as absent)', async () => {
    // A stringified number must not fail the whole envelope parse — the batch's
    // valid decisions survive and usage stays zero (contract fail-soft).
    const server = await startServer((_req, res) =>
      json(res, 200, { decisions: [decisionFor('p1')], usage: { cost_usd: '0.42' } })
    );
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toEqual([
      { pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'merge p1' },
    ]);
    expect(client.usage()).toMatchObject({ tokensUsed: 0, costUsd: 0 });
    // No "did not contain a decisions array" warning — the envelope parsed.
    expect(client.usage().warnings).toEqual([]);
  });

  it('ignores negative reported usage so the ceiling flip is never delayed', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, { decisions: [], usage: { cost_usd: -5, tokens_used: -100 } })
    );
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url }, makeDeps({ maxCostUsd: 1 }));
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    // The negative report is dropped: totals stay at zero, ceiling not reached.
    expect(client.usage()).toMatchObject({
      tokensUsed: 0,
      costUsd: 0,
      costCeilingReached: false,
    });
  });

  it('sends job.max_cost_usd and stops dispatching once reported cost reaches it', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, { decisions: [], usage: { cost_usd: 0.6 } })
    );
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url }, makeDeps({ maxCostUsd: 1 }));

    // Batch 1: cost 0.6 < 1 → ceiling not yet reached, request dispatched.
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    expect(client.usage().costCeilingReached).toBe(false);
    expect(server.requests[0]!.body).toMatchObject({ job: { max_cost_usd: 1 } });

    // Batch 2: cost 1.2 ≥ 1 → ceiling flips.
    await client.reviewPairs([makePair('p2')], REVIEW_OPTIONS);
    expect(client.usage().costCeilingReached).toBe(true);

    // Batch 3: skipped without hitting the server; pairs stay undecided.
    const dispatched = server.requests.length;
    const decisions = await client.reviewPairs([makePair('p3')], REVIEW_OPTIONS);
    expect(decisions).toEqual([]);
    expect(server.requests.length).toBe(dispatched);
    expect(server.requests.length).toBe(2);
  });

  it('accumulates a usage block reported over the command transport', async () => {
    // Emit a {decisions, usage} envelope on stdout (single quotes stay literal
    // inside the double-quoted -e arg, mirroring the other node -e commands) so
    // this exercises the command path's recordUsage wiring, not just no-op.
    const script =
      "console.log(JSON.stringify({decisions:[{pairId:'p1',decision:'merge',confidence:0.9,reasoning:'ok'}],usage:{tokens_used:500,cost_usd:0.3}}))";
    const client = await reviewer({ kind: 'command', command: `node -e "${script}"` });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toHaveLength(1);
    expect(client.usage()).toMatchObject({ tokensUsed: 500, costUsd: 0.3 });
  });

  it('is a no-op over the command transport when usage is absent', async () => {
    // The echo fixture prints a bare {decisions} block (no usage) — the command
    // path must leave usage at zero rather than regressing to a bogus total.
    const client = await reviewer({
      kind: 'command',
      command: `node "${ECHO_FIXTURE}" merge 0.9`,
    });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    expect(client.usage()).toMatchObject({ tokensUsed: 0, costUsd: 0 });
  });
});

describe('createExternalReviewerClient — http transport', () => {
  it('handles a sync 200 response and sends the resolved bearer token', async () => {
    const server = await startServer((_req, res) => {
      json(res, 200, { decisions: [decisionFor('p1'), decisionFor('p2', 'not_match', 0.8)] });
    });
    openServers.push(server.close);

    const client = await reviewer({
      kind: 'http',
      url: server.url,
      authToken: '${{ env.REVIEWER_TOKEN }}',
    });
    const decisions = await client.reviewPairs([makePair('p1'), makePair('p2')], REVIEW_OPTIONS);

    expect(decisions).toEqual([
      { pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'merge p1' },
      { pairId: 'p2', decision: 'not_match', confidence: 0.8, reasoning: 'not_match p2' },
    ]);
    expect(client.usage().warnings).toEqual([]);

    const posted = server.requests[0]!;
    expect(posted.method).toBe('POST');
    expect(posted.authorization).toBe('Bearer secret-token');
    expect(posted.body).toMatchObject({
      version: REVIEW_REQUEST_VERSION,
      job: { entity: 'company', max_pairs: 2, timeout_s: 300 },
      context: {
        entity_semantics: { definition: 'A legal company entity.' },
        learning_context: 'precedent text',
        target_schema: 'entity_graph',
        dialect: 'duckdb',
      },
    });
  });

  it('resolves $VAR-style auth placeholders too', async () => {
    const server = await startServer((_req, res) => json(res, 200, { decisions: [] }));
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url, authToken: '$REVIEWER_TOKEN' });
    await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(server.requests[0]!.authorization).toBe('Bearer secret-token');
  });

  it.each(HOST_EMBEDDING_ENV_NAMES.flatMap((name) => [`$${name}`, `\${{ env.${name} }}`]))(
    'never sends %s, whatever the resolver knows',
    async (authToken) => {
      const server = await startServer((_req, res) => json(res, 200, { decisions: [] }));
      openServers.push(server.close);
      const resolve = vi.fn(async () => 'host-canary');

      const started = reviewer(
        { kind: 'http', url: server.url, authToken },
        makeDeps({ secretResolver: { resolve } })
      );
      await expect(started).rejects.toThrow('reserved');
      await expect(started).rejects.not.toThrow('host-canary');
      expect(resolve).not.toHaveBeenCalled();
      expect(server.requests).toEqual([]);
    }
  );

  it('follows the async 202 + poll flow to done', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'POST') return json(res, 202, { job_id: 'job-1' });
      if (server.requests.filter((r) => r.method === 'GET').length === 1) {
        return json(res, 200, { status: 'running' });
      }
      return json(res, 200, { status: 'done', decisions: [decisionFor('p1')] });
    });
    openServers.push(server.close);

    const client = await reviewer({
      kind: 'http',
      url: server.url,
      authToken: '${{ env.REVIEWER_TOKEN }}',
      pollIntervalS: 0.01,
    });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toHaveLength(1);
    const polls = server.requests.filter((r) => r.method === 'GET');
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls[0]!.url).toBe('/review/job-1');
    expect(polls[0]!.authorization).toBe('Bearer secret-token');
  });

  it('surfaces a failed job as warnings with no decisions', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'POST') return json(res, 202, { job_id: 'job-2' });
      return json(res, 200, { status: 'failed', error: 'agent crashed' });
    });
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url, pollIntervalS: 0.01 });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toEqual([]);
    expect(client.usage().warnings.some((w) => /agent crashed/.test(w))).toBe(true);
  });

  it('gives up when the poll budget (timeout_s) is exhausted', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'POST') return json(res, 202, { job_id: 'job-3' });
      return json(res, 200, { status: 'running' });
    });
    openServers.push(server.close);

    const client = await reviewer({
      kind: 'http',
      url: server.url,
      timeoutS: 0.15,
      pollIntervalS: 0.02,
    });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toEqual([]);
    expect(client.usage().warnings.some((w) => /timed out/.test(w))).toBe(true);
  });

  it('degrades to warnings on garbage responses and non-2xx statuses', async () => {
    const garbage = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('this is not json');
    });
    openServers.push(garbage.close);
    const garbageClient = await reviewer({ kind: 'http', url: garbage.url });
    expect(await garbageClient.reviewPairs([makePair('p1')], REVIEW_OPTIONS)).toEqual([]);
    expect(garbageClient.usage().warnings.some((w) => /not valid JSON/.test(w))).toBe(true);

    const failing = await startServer((_req, res) => json(res, 500, { error: 'boom' }));
    openServers.push(failing.close);
    const failingClient = await reviewer({ kind: 'http', url: failing.url });
    expect(await failingClient.reviewPairs([makePair('p1')], REVIEW_OPTIONS)).toEqual([]);
    expect(failingClient.usage().warnings.some((w) => /HTTP 500/.test(w))).toBe(true);

    // Unreachable server (closed before the call) — still no throw.
    const closed = await startServer((_req, res) => json(res, 200, { decisions: [] }));
    await closed.close();
    const closedClient = await reviewer({ kind: 'http', url: closed.url });
    expect(await closedClient.reviewPairs([makePair('p1')], REVIEW_OPTIONS)).toEqual([]);
    expect(closedClient.usage().warnings.length).toBeGreaterThan(0);
  });

  it('drops unknown pairIds, duplicates, and malformed decisions with warnings', async () => {
    const server = await startServer((_req, res) => {
      json(res, 200, {
        decisions: [
          decisionFor('p1'),
          decisionFor('p1', 'not_match'), // duplicate — first one wins
          decisionFor('ghost'), // unknown pairId
          { pairId: 'p2', decision: 'maybe?', confidence: 0.5, reasoning: 'bad enum' },
          { ...decisionFor('p2'), confidence: 42 }, // clamped to 1
        ],
      });
    });
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url });
    const decisions = await client.reviewPairs(
      [makePair('p1'), makePair('p2'), makePair('p3')],
      REVIEW_OPTIONS
    );

    expect(decisions).toEqual([
      { pairId: 'p1', decision: 'merge', confidence: 0.9, reasoning: 'merge p1' },
      { pairId: 'p2', decision: 'merge', confidence: 1, reasoning: 'merge p2' },
    ]);
    const warnings = client.usage().warnings;
    expect(warnings.some((w) => /unknown pair 'ghost'/.test(w))).toBe(true);
    expect(warnings.some((w) => /duplicate decisions for pair 'p1'/.test(w))).toBe(true);
    expect(warnings.some((w) => /1 malformed decision/.test(w))).toBe(true);
    // p3 got no decision — it stays in the review queue.
    expect(warnings.some((w) => /1 pair\(s\) left undecided/.test(w))).toBe(true);
  });

  it('does not call the server for an empty batch', async () => {
    const server = await startServer((_req, res) => json(res, 200, { decisions: [] }));
    openServers.push(server.close);

    const client = await reviewer({ kind: 'http', url: server.url });
    expect(await client.reviewPairs([], REVIEW_OPTIONS)).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it('throws CommandError(2) when the http config has no url', async () => {
    await expect(reviewer({ kind: 'http' })).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('createExternalReviewerClient — command transport', () => {
  it('pipes the request over stdin and reads {decisions} from stdout', async () => {
    const client = await reviewer({
      kind: 'command',
      command: `node "${ECHO_FIXTURE}" not_match 0.85`,
    });
    const decisions = await client.reviewPairs([makePair('p1'), makePair('p2')], REVIEW_OPTIONS);

    expect(decisions).toEqual([
      {
        pairId: 'p1',
        decision: 'not_match',
        confidence: 0.85,
        reasoning: 'fixture not_match for company',
      },
      {
        pairId: 'p2',
        decision: 'not_match',
        confidence: 0.85,
        reasoning: 'fixture not_match for company',
      },
    ]);
    expect(client.usage().warnings).toEqual([]);
  });

  // Generous vitest timeout: CI runners under load can take seconds just to
  // spawn the shell + node; the reviewer's own timeout_s is what's under test.
  it('kills a hung command at timeout_s and leaves the pairs undecided', async () => {
    const client = await reviewer({
      kind: 'command',
      command: `node "${HANG_FIXTURE}"`,
      timeoutS: 0.3,
    });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);

    expect(decisions).toEqual([]);
    expect(client.usage().warnings.some((w) => /timed out after 0.3s/.test(w))).toBe(true);
  }, 30_000);

  it('degrades to warnings on nonzero exit and non-JSON stdout', async () => {
    const failing = await reviewer({
      kind: 'command',
      command: `node -e "console.error('bad day'); process.exit(3)"`,
    });
    expect(await failing.reviewPairs([makePair('p1')], REVIEW_OPTIONS)).toEqual([]);
    const failWarnings = failing.usage().warnings;
    expect(failWarnings.some((w) => /exit code 3/.test(w))).toBe(true);
    expect(failWarnings.some((w) => /bad day/.test(w))).toBe(true);

    const garbage = await reviewer({
      kind: 'command',
      command: `node -e "console.log('not json')"`,
    });
    expect(await garbage.reviewPairs([makePair('p1')], REVIEW_OPTIONS)).toEqual([]);
    expect(garbage.usage().warnings.some((w) => /not valid JSON/.test(w))).toBe(true);
  });

  it('throws CommandError(2) when the command config has no command', async () => {
    await expect(reviewer({ kind: 'command' })).rejects.toMatchObject({ exitCode: 2 });
  });
});

it('executes argv directly without inherited credentials or shell expansion', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-parent-only');
  try {
    const script =
      "if (process.env.GITHUB_TOKEN !== undefined) process.exit(3); console.log(JSON.stringify({decisions:[{pairId:'p1',decision:'merge',confidence:0.9,reasoning:process.argv[1]}]}))";
    const client = await reviewer({
      kind: 'command',
      command: `node -e "${script}" '$(echo shell-expansion)'`,
    });
    const decisions = await client.reviewPairs([makePair('p1')], REVIEW_OPTIONS);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reasoning).toBe('$(echo shell-expansion)');
  } finally {
    vi.unstubAllEnvs();
  }
});
