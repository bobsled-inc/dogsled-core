'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useEffect, useState } from 'react';
import { readAgentProposalFromQueueRow } from '@/lib/entity-graph-agent-sample';
import type { EntityGraphEntityId, EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { dispatchEntityGraphResolveRefresh } from '@/lib/entity-graph-ui-events';
import type { QueueCompareField, QueueRow } from './queue-table';

function Field({ label, a, b }: QueueCompareField) {
  const match = a && b && a.toLowerCase() === b.toLowerCase();
  return (
    <div className="grid grid-cols-[80px_1fr_1fr] gap-3 border-t border-border py-1.5 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className={match ? 'text-foreground' : 'font-medium text-foreground'}>
        {a ?? <span className="text-muted-foreground">—</span>}
      </div>
      <div className={match ? 'text-foreground' : 'font-medium text-foreground'}>
        {b ?? <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}

interface PairInspectorProps {
  row: QueueRow | null;
  scenario: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
  onDecided: () => void;
}

export function PairInspector({ row, scenario, entity, onDecided }: PairInspectorProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    setBusy(false);
    setError(null);
    setReason('');
  }, [row?.pair_id]);

  if (!row) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground">
        Select a pair on the left to inspect records and decide.
      </div>
    );
  }

  const diffs = row.feature_contributions ?? [];
  const agentProposal = readAgentProposalFromQueueRow(row);
  const previousDecision = row.human_decision
    ? {
        label: 'Previous human decision',
        decision: row.human_decision,
        reviewer: row.human_decision_reviewer,
        decidedAt: row.human_decided_at,
        reason: row.human_decision_reason,
      }
    : row.decision && !agentProposal
      ? {
          label: 'Previous decision',
          decision: row.decision,
          reviewer: row.decision_reviewer,
          decidedAt: row.decided_at,
          reason: row.decision_reason,
        }
      : null;
  const blockingRules = row.blocking_rules
    ? row.blocking_rules
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const submit = async (decision: 'merge' | 'not_match' | 'defer') => {
    setBusy(true);
    setError(null);
    try {
      const res = await explorerFetch('/api/entity-graph/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario,
          entity,
          pairId: row.pair_id,
          decision,
          reviewer: 'explorer-ui',
          reason: reason.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setReason('');
      dispatchEntityGraphResolveRefresh();
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Pair · {row.threshold_band}
          </div>
          <div className="font-mono text-xs">{row.pair_id}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Score</div>
          <div className="text-lg font-semibold tabular-nums">{row.composite_score.toFixed(3)}</div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {blockingRules.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {blockingRules.map((rule) => (
              <span
                key={rule}
                className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500"
              >
                blocked by {rule}
              </span>
            ))}
          </div>
        )}

        {agentProposal && (
          <section className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                  Agent assessment
                </h4>
                <div className="mt-1 font-medium text-foreground">
                  Proposed action:{' '}
                  <span className="font-semibold">{agentProposal.proposed_decision}</span>
                </div>
              </div>
              <div className="rounded-full bg-background/70 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-200">
                {(agentProposal.proposed_confidence * 100).toFixed(0)}% confident
              </div>
            </div>
            <p className="mt-2 leading-relaxed text-foreground/80">{agentProposal.assessment}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              The agent&apos;s proposal is highlighted below — one click confirms it, or override
              with a different decision.
            </p>
          </section>
        )}

        <section>
          <div className="grid grid-cols-[80px_1fr_1fr] gap-3 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <div></div>
            <div>
              A · <span className="text-foreground">{row.source_a}</span>
            </div>
            <div>
              B · <span className="text-foreground">{row.source_b}</span>
            </div>
          </div>
          {row.compare_fields.map((field) => (
            <Field key={field.key} label={field.label} a={field.a} b={field.b} />
          ))}
        </section>

        {diffs.length > 0 && (
          <section>
            <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Feature contributions
            </h4>
            <div className="mt-2 space-y-2">
              {diffs.map((diff, idx) => {
                const similarity = typeof diff.score === 'number' ? diff.score : 0;
                const width = Math.max(0, Math.min(1, similarity)) * 100;
                return (
                  <div key={`${diff.key}-${idx}`} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium">{diff.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {similarity.toFixed(3)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    {(diff.a !== null || diff.b !== null) && (
                      <div className="flex gap-2 font-mono text-[10px] text-muted-foreground">
                        <span className="truncate">{diff.a ?? '—'}</span>
                        <span>·</span>
                        <span className="truncate">{diff.b ?? '—'}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {previousDecision && (
          <section className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
            <div className="font-medium">
              {previousDecision.label}:{' '}
              <span className="font-semibold">{previousDecision.decision}</span>
            </div>
            {previousDecision.reviewer && (
              <div className="text-muted-foreground">
                by {previousDecision.reviewer}
                {previousDecision.decidedAt &&
                  ` · ${new Date(previousDecision.decidedAt).toLocaleString()}`}
              </div>
            )}
            {previousDecision.reason && (
              <div className="mt-1 text-muted-foreground">{previousDecision.reason}</div>
            )}
          </section>
        )}
      </div>

      <div className="border-t border-border bg-card/60 px-4 py-3">
        <label className="block text-[11px] uppercase tracking-wider text-muted-foreground">
          Reason (optional)
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Why this decision?"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
        {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
        {agentProposal && (
          <div className="mt-3 flex items-center gap-1.5 text-[10px]">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${
                agentProposal.proposed_decision === 'merge'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : agentProposal.proposed_decision === 'not_match'
                    ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              }`}
            >
              ✓ agent proposes {agentProposal.proposed_decision} ·{' '}
              {(agentProposal.proposed_confidence * 100).toFixed(0)}% confident
            </span>
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => submit('merge')}
            className={`rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50 ${
              agentProposal?.proposed_decision === 'merge'
                ? 'ring-2 ring-emerald-300 ring-offset-2 ring-offset-card'
                : ''
            }`}
            aria-label={
              agentProposal?.proposed_decision === 'merge' ? 'Merge (agent proposed)' : 'Merge'
            }
          >
            Merge
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit('not_match')}
            className={`rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50 ${
              agentProposal?.proposed_decision === 'not_match'
                ? 'ring-2 ring-red-300 ring-offset-2 ring-offset-card'
                : ''
            }`}
            aria-label={
              agentProposal?.proposed_decision === 'not_match'
                ? 'Not a match (agent proposed)'
                : 'Not a match'
            }
          >
            Not a match
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit('defer')}
            className={`rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:border-foreground/30 disabled:opacity-50 ${
              agentProposal?.proposed_decision === 'defer'
                ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-card'
                : ''
            }`}
            aria-label={
              agentProposal?.proposed_decision === 'defer' ? 'Defer (agent proposed)' : 'Defer'
            }
          >
            Defer
          </button>
        </div>
      </div>
    </div>
  );
}
