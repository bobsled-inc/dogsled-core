import { describe, expect, it, vi } from 'vitest';

import {
  createAgentPanelClient,
  deriveConfidence,
  FIRST_PANEL_CONTEXT_FIELD,
  runPanelReview,
  runReviewWithPanel,
  tallyConsensus,
} from '../../../../src/compiler/identity/agent-panel.js';
import { generateAgentDecisionSql } from '../../../../src/compiler/identity/agent-review.js';

import type {
  AgentPolicy,
  AgentReviewOptions,
  PairContext,
  PairDecision,
  PanelJudge,
  PanelJudgeLabel,
  PanelTrace,
  ResolvedPanelPolicy,
} from '../../../../src/compiler/identity/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPTIONS: AgentReviewOptions = { batchSize: 100 };

function pair(id: string): PairContext {
  return {
    pairId: id,
    recordAId: `${id}-a`,
    recordBId: `${id}-b`,
    sourceA: 'src_a',
    sourceB: 'src_b',
    compositeScore: 0.7,
    fields: {},
  };
}

/** A judge that returns a fixed call per pair (defaults to `defer` when unlisted). */
function fakeJudge(
  role: string,
  byPairId: Record<string, PairDecision['decision']>,
  confidence = 0.9
): PanelJudge {
  return {
    role,
    client: {
      reviewPairs: vi.fn(async (pairs: PairContext[]) =>
        pairs.map((p) => ({
          pairId: p.pairId,
          decision: byPairId[p.pairId] ?? ('defer' as const),
          confidence,
          reasoning: `${role} says ${byPairId[p.pairId] ?? 'defer'}`,
        }))
      ),
    },
  };
}

function panelPolicy(overrides: Partial<ResolvedPanelPolicy> = {}): ResolvedPanelPolicy {
  return {
    enabled: true,
    mode: 'replace',
    firstPanel: ['a', 'b', 'c'],
    resolutionPanel: ['d', 'e'],
    consensus: 'unanimous',
    onUnresolved: 'defer',
    unanimousConfidence: 0.95,
    resolutionConfidence: 0.7,
    ...overrides,
  };
}

function labels(...specs: Array<[string, PairDecision['decision']]>): PanelJudgeLabel[] {
  return specs.map(([role, label]) => ({ role, label, rationale: `${role}:${label}` }));
}

// ---------------------------------------------------------------------------
// tallyConsensus
// ---------------------------------------------------------------------------

describe('tallyConsensus', () => {
  it('unanimous: all agree → decision with ratio 1', () => {
    const v = tallyConsensus(labels(['a', 'merge'], ['b', 'merge'], ['c', 'merge']), 'unanimous');
    expect(v).toEqual({ decision: 'merge', ratio: 1, kind: 'unanimous' });
  });

  it('unanimous: any disagreement → split (no decision)', () => {
    const v = tallyConsensus(
      labels(['a', 'merge'], ['b', 'merge'], ['c', 'not_match']),
      'unanimous'
    );
    expect(v.decision).toBeNull();
    expect(v.kind).toBe('split');
  });

  it('majority: a strict majority decides', () => {
    const v = tallyConsensus(
      labels(['a', 'merge'], ['b', 'merge'], ['c', 'not_match']),
      'majority'
    );
    expect(v.decision).toBe('merge');
    expect(v.kind).toBe('majority');
    expect(v.ratio).toBeCloseTo(0.6667, 3);
  });

  it('majority: an even tie → split', () => {
    const v = tallyConsensus(
      labels(['a', 'merge'], ['b', 'merge'], ['c', 'not_match'], ['d', 'not_match']),
      'majority'
    );
    expect(v.decision).toBeNull();
    expect(v.kind).toBe('split');
  });

  it('majority: a defer majority yields decision=defer (not split)', () => {
    const v = tallyConsensus(labels(['a', 'defer'], ['b', 'defer'], ['c', 'merge']), 'majority');
    expect(v.decision).toBe('defer');
    expect(v.kind).toBe('majority');
  });

  it('empty label set → split', () => {
    expect(tallyConsensus([], 'unanimous')).toEqual({ decision: null, ratio: 0, kind: 'split' });
  });
});

// ---------------------------------------------------------------------------
// deriveConfidence
// ---------------------------------------------------------------------------

describe('deriveConfidence', () => {
  const policy = panelPolicy();

  it('first-panel unanimous → unanimousConfidence', () => {
    expect(deriveConfidence('first', 1, policy)).toBe(0.95);
  });

  it('resolution-panel unanimous → resolutionConfidence', () => {
    expect(deriveConfidence('resolution', 1, policy)).toBe(0.7);
  });

  it('scales by agreement ratio so a partial majority lands below unanimous', () => {
    const majority = deriveConfidence('first', 0.6, policy);
    const unanimous = deriveConfidence('first', 1, policy);
    expect(majority).toBeLessThan(unanimous);
    expect(majority).toBe(0.57);
  });

  it('a resolution agreement is capped below a first-panel one', () => {
    expect(deriveConfidence('resolution', 1, policy)).toBeLessThan(
      deriveConfidence('first', 1, policy)
    );
  });
});

// ---------------------------------------------------------------------------
// runPanelReview — two-tier consensus
// ---------------------------------------------------------------------------

describe('runPanelReview', () => {
  it('returns [] for an empty batch and never calls a judge', async () => {
    const first = fakeJudge('a', {});
    const out = await runPanelReview([], OPTIONS, {
      judges: { firstPanel: [first], resolutionPanel: [] },
      policy: panelPolicy(),
    });
    expect(out).toEqual([]);
    expect(first.client.reviewPairs).not.toHaveBeenCalled();
  });

  it('first-panel unanimous: emits the agreed label at high confidence, tier-1 trace, no resolution call', async () => {
    const verdict: Record<string, PairDecision['decision']> = { 'pair-1': 'merge' };
    const firstPanel = [fakeJudge('a', verdict), fakeJudge('b', verdict), fakeJudge('c', verdict)];
    const resJudge = fakeJudge('d', verdict);

    const out = await runPanelReview([pair('pair-1')], OPTIONS, {
      judges: { firstPanel, resolutionPanel: [resJudge] },
      policy: panelPolicy(),
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.decision).toBe('merge');
    expect(out[0]!.confidence).toBe(0.95);
    const trace = JSON.parse(out[0]!.reasoning) as PanelTrace;
    expect(trace.resolvedAtTier).toBe('first');
    expect(trace.firstPanel).toHaveLength(3);
    expect(trace.resolutionPanel).toBeUndefined();
    // Resolution panel must not run when the first panel agrees.
    expect(resJudge.client.reviewPairs).not.toHaveBeenCalled();
  });

  it('disagree → resolution panel agrees: capped confidence, tier-2 trace, __first_panel dossier passed', async () => {
    // First panel splits 2:1; resolution panel unanimously merges.
    const firstPanel = [
      fakeJudge('a', { 'pair-1': 'merge' }),
      fakeJudge('b', { 'pair-1': 'merge' }),
      fakeJudge('c', { 'pair-1': 'not_match' }),
    ];
    let resolutionInput: PairContext[] | null = null;
    const resolutionPanel: PanelJudge[] = [
      {
        role: 'd',
        client: {
          reviewPairs: vi.fn(async (pairs: PairContext[]) => {
            resolutionInput = pairs;
            return pairs.map((p) => ({
              pairId: p.pairId,
              decision: 'merge' as const,
              confidence: 0.9,
              reasoning: 'd agrees merge',
            }));
          }),
        },
      },
      fakeJudge('e', { 'pair-1': 'merge' }),
    ];

    const out = await runPanelReview([pair('pair-1')], OPTIONS, {
      judges: { firstPanel, resolutionPanel },
      policy: panelPolicy(),
    });

    expect(out[0]!.decision).toBe('merge');
    expect(out[0]!.confidence).toBe(0.7); // resolutionConfidence * ratio(1)
    const trace = JSON.parse(out[0]!.reasoning) as PanelTrace;
    expect(trace.resolvedAtTier).toBe('resolution');
    expect(trace.resolutionPanel).toHaveLength(2);

    // The resolution panel saw the aggregated first-panel dossier.
    expect(resolutionInput).not.toBeNull();
    const dossierField = resolutionInput![0]!.fields[FIRST_PANEL_CONTEXT_FIELD];
    expect(dossierField).toBeDefined();
    const dossier = JSON.parse(dossierField!.a) as Array<{ role: string; label: string }>;
    expect(dossier.map((d) => d.role)).toEqual(['a', 'b', 'c']);
    expect(dossier).toContainEqual(expect.objectContaining({ role: 'c', label: 'not_match' }));
  });

  it('disagree → resolution panel also splits: defers to human at confidence 0', async () => {
    const firstPanel = [
      fakeJudge('a', { 'pair-1': 'merge' }),
      fakeJudge('b', { 'pair-1': 'not_match' }),
    ];
    const resolutionPanel = [
      fakeJudge('d', { 'pair-1': 'merge' }),
      fakeJudge('e', { 'pair-1': 'not_match' }),
    ];

    const out = await runPanelReview([pair('pair-1')], OPTIONS, {
      judges: { firstPanel, resolutionPanel },
      policy: panelPolicy(),
    });

    expect(out[0]!.decision).toBe('defer');
    expect(out[0]!.confidence).toBe(0);
    const trace = JSON.parse(out[0]!.reasoning) as PanelTrace;
    expect(trace.resolvedAtTier).toBe('unresolved');
  });

  it('ignores labels for unknown and duplicated pair IDs from a judge', async () => {
    const noisyJudge: PanelJudge = {
      role: 'a',
      client: {
        reviewPairs: vi.fn(async () => [
          { pairId: 'pair-1', decision: 'merge' as const, confidence: 0.9, reasoning: 'ok' },
          { pairId: 'pair-1', decision: 'not_match' as const, confidence: 0.9, reasoning: 'dup' },
          { pairId: 'ghost', decision: 'merge' as const, confidence: 0.9, reasoning: 'unknown' },
        ]),
      },
    };
    const out = await runPanelReview([pair('pair-1')], OPTIONS, {
      judges: {
        firstPanel: [noisyJudge, fakeJudge('b', { 'pair-1': 'merge' })],
        resolutionPanel: [],
      },
      policy: panelPolicy(),
    });
    // Only the first label from the noisy judge counts → unanimous merge.
    expect(out).toHaveLength(1);
    expect(out[0]!.decision).toBe('merge');
    const trace = JSON.parse(out[0]!.reasoning) as PanelTrace;
    expect(trace.firstPanel).toHaveLength(2);
  });

  it('routes panel decisions through the existing confidence gate (applied / proposed / deferred)', async () => {
    // Three pairs, one per outcome class.
    const firstPanel = [
      fakeJudge('a', { applied: 'merge', proposed: 'merge', deferred: 'merge' }),
      fakeJudge('b', { applied: 'merge', proposed: 'merge', deferred: 'not_match' }),
      fakeJudge('c', { applied: 'merge', proposed: 'merge', deferred: 'merge' }),
    ];
    // proposed: first panel splits, resolution unanimously merges → conf 0.70.
    const resolutionPanel = [
      fakeJudge('d', { proposed: 'merge', deferred: 'merge' }),
      fakeJudge('e', { proposed: 'merge', deferred: 'not_match' }),
    ];
    // Make 'proposed' split at tier 1 by overriding judge b for that pair.
    firstPanel[1] = fakeJudge('b', {
      applied: 'merge',
      proposed: 'not_match',
      deferred: 'not_match',
    });

    const decisions = await runPanelReview(
      [pair('applied'), pair('proposed'), pair('deferred')],
      OPTIONS,
      { judges: { firstPanel, resolutionPanel }, policy: panelPolicy() }
    );

    const byId = new Map(decisions.map((d) => [d.pairId, d]));
    expect(byId.get('applied')!.confidence).toBe(0.95);
    expect(byId.get('proposed')!.confidence).toBe(0.7);
    expect(byId.get('deferred')!.decision).toBe('defer');

    const sql = generateAgentDecisionSql(decisions, 'company', 'snowflake', 'ENTITY_GRAPH', {
      mode: 'apply',
      autoApplyThreshold: 0.75,
    })[0]!.sql;

    // 0.95 ≥ 0.75 → applied; 0.70 < 0.75 → proposed; defer → deferred.
    expect(sql).toContain("'applied'");
    expect(sql).toContain("'proposed'");
    expect(sql).toContain("'deferred'");
  });
});

// ---------------------------------------------------------------------------
// createAgentPanelClient
// ---------------------------------------------------------------------------

describe('createAgentPanelClient', () => {
  it('is a drop-in LlmClient', async () => {
    const verdict = { 'pair-1': 'merge' as const };
    const client = createAgentPanelClient(
      {
        firstPanel: [fakeJudge('a', verdict), fakeJudge('b', verdict)],
        resolutionPanel: [fakeJudge('d', verdict)],
      },
      panelPolicy()
    );
    const out = await client.reviewPairs([pair('pair-1')], OPTIONS);
    expect(out[0]!.decision).toBe('merge');
  });
});

// ---------------------------------------------------------------------------
// runReviewWithPanel — replace vs escalate
// ---------------------------------------------------------------------------

describe('runReviewWithPanel', () => {
  const basePolicy: AgentPolicy = { enabled: true, agentConfidenceFloor: 0.5 };

  it('panel disabled → single-agent reviewer only', async () => {
    const single = fakeJudge('single', { 'pair-1': 'merge' }).client;
    const out = await runReviewWithPanel({
      pairs: [pair('pair-1')],
      policy: { ...basePolicy },
      singleAgentClient: single,
      judges: { firstPanel: [], resolutionPanel: [] },
    });
    expect(out[0]!.decision).toBe('merge');
  });

  it('replace mode: the panel reviews every pair; the single agent never runs', async () => {
    const single = fakeJudge('single', { 'pair-1': 'not_match' });
    const verdict = { 'pair-1': 'merge' as const };
    const out = await runReviewWithPanel({
      pairs: [pair('pair-1')],
      policy: { ...basePolicy, panel: panelPolicy({ mode: 'replace' }) },
      singleAgentClient: single.client,
      judges: {
        firstPanel: [fakeJudge('a', verdict), fakeJudge('b', verdict), fakeJudge('c', verdict)],
        resolutionPanel: [fakeJudge('d', verdict)],
      },
    });
    expect(out[0]!.decision).toBe('merge'); // panel's call, not the single agent's
    expect(single.client.reviewPairs).not.toHaveBeenCalled();
  });

  it('escalate mode: only defer / low-confidence pairs reach the panel; the rest keep the single-agent call', async () => {
    // single agent: keep=high-confidence merge, esc=defer, low=below-floor merge.
    const singleCalls: Record<string, PairDecision> = {
      keep: { pairId: 'keep', decision: 'merge', confidence: 0.9, reasoning: 'sure' },
      esc: { pairId: 'esc', decision: 'defer', confidence: 0.2, reasoning: 'unsure' },
      low: { pairId: 'low', decision: 'merge', confidence: 0.3, reasoning: 'weak' },
    };
    const single: PanelJudge['client'] = {
      reviewPairs: vi.fn(async (pairs: PairContext[]) => pairs.map((p) => singleCalls[p.pairId]!)),
    };
    const firstJudgeA = fakeJudge('a', { esc: 'merge', low: 'merge' });
    const verdict = { esc: 'merge' as const, low: 'merge' as const };

    const out = await runReviewWithPanel({
      pairs: [pair('keep'), pair('esc'), pair('low')],
      policy: { ...basePolicy, panel: panelPolicy({ mode: 'escalate' }) },
      singleAgentClient: single,
      judges: {
        firstPanel: [firstJudgeA, fakeJudge('b', verdict), fakeJudge('c', verdict)],
        resolutionPanel: [fakeJudge('d', verdict)],
      },
    });

    const byId = new Map(out.map((d) => [d.pairId, d]));
    // Kept pair retains the single agent's high-confidence call untouched.
    expect(byId.get('keep')!.decision).toBe('merge');
    expect(byId.get('keep')!.confidence).toBe(0.9);
    expect(byId.get('keep')!.reasoning).toBe('sure');
    // Escalated pairs carry the panel's call (confidence 0.95, panel trace).
    expect(byId.get('esc')!.confidence).toBe(0.95);
    expect(byId.get('low')!.confidence).toBe(0.95);
    expect(() => JSON.parse(byId.get('esc')!.reasoning)).not.toThrow();

    // The panel only ever saw the escalation set, not the kept pair.
    const seen = (firstJudgeA.client.reviewPairs as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((call) => (call[0] as PairContext[]).map((p) => p.pairId))
      .sort();
    expect(seen).toEqual(['esc', 'low']);
  });

  it('escalate mode: nothing escalates when the single agent is confident', async () => {
    const single = fakeJudge('single', { 'pair-1': 'merge' }, 0.95);
    const firstJudge = fakeJudge('a', { 'pair-1': 'not_match' });
    const out = await runReviewWithPanel({
      pairs: [pair('pair-1')],
      policy: { ...basePolicy, panel: panelPolicy({ mode: 'escalate' }) },
      singleAgentClient: single.client,
      judges: { firstPanel: [firstJudge, fakeJudge('b', {})], resolutionPanel: [] },
    });
    expect(out[0]!.decision).toBe('merge');
    expect(firstJudge.client.reviewPairs).not.toHaveBeenCalled();
  });
});
