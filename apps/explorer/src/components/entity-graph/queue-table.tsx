'use client';

import Link from 'next/link';
import { readAgentProposalFromQueueRow } from '@/lib/entity-graph-agent-sample';
import type { EntityGraphQueueDecisionMetadata } from '@/lib/entity-graph-queue-rows';

export interface QueueCompareField {
  key: string;
  label: string;
  a: string | null;
  b: string | null;
}

export interface QueueFeatureContribution {
  key: string;
  label: string;
  score: number | null;
  a: string | null;
  b: string | null;
}

export interface QueueRow extends EntityGraphQueueDecisionMetadata {
  pair_id: string;
  record_a_id: string;
  record_b_id: string;
  source_a: string;
  source_b: string;
  composite_score: number;
  threshold_band: string;
  blocking_rules: string | null;
  field_diffs: string | null;
  recommended_action: string | null;
  scenario?: string;
  entity?: string;
  a_display_label: string | null;
  b_display_label: string | null;
  compare_fields: QueueCompareField[];
  feature_contributions: QueueFeatureContribution[];
}

export interface QueueTableProps {
  rows: QueueRow[];
  selectedPairId: string | null;
  onSelect: (pairId: string) => void;
  /**
   * Active status filter — controls the empty-state copy. Auto-merged and
   * auto-rejected pairs bypass this queue entirely (they go straight to
   * `__clusters` or get discarded), so on the `decided` tab "no rows" really
   * means "no review-queue pairs decided yet" — not "the pipeline didn't run".
   * Without this prop the empty state defaults to the open-tab copy.
   */
  statusFilter?: 'open' | 'decided' | 'all';
  /** Render-time hint to deeplink users to the auto-merge view. */
  clustersHref?: string;
}

function bandClasses(band: string): string {
  if (band === 'auto_merge') return 'bg-emerald-500/15 text-emerald-500';
  if (band === 'review') return 'bg-amber-500/15 text-amber-500';
  if (band === 'auto_reject') return 'bg-red-500/15 text-red-500';
  return 'bg-secondary text-muted-foreground';
}

function decisionClasses(decision: string): string {
  if (decision === 'merge') return 'bg-emerald-500/15 text-emerald-500';
  if (decision === 'not_match') return 'bg-red-500/15 text-red-500';
  if (decision === 'defer') return 'bg-amber-500/15 text-amber-500';
  // Legacy rows from before the defer/escalate collapse. New code does not emit
  // 'escalate', but old `__review_decisions` rows may still surface in the queue.
  if (decision === 'escalate') return 'bg-violet-500/15 text-violet-500';
  return 'bg-secondary text-muted-foreground';
}

export function QueueTable({
  rows,
  selectedPairId,
  onSelect,
  statusFilter,
  clustersHref,
}: QueueTableProps) {
  if (rows.length === 0) {
    if (statusFilter === 'decided') {
      return (
        <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
          <p>No review-queue pairs have been decided yet.</p>
          <p className="mt-2 text-xs">
            Auto-merged pairs (score above the auto-merge threshold) and auto-rejected pairs (below
            the auto-reject threshold) skip this queue entirely — auto-merges go straight into
            clusters
            {clustersHref ? (
              <>
                {' '}
                (see the{' '}
                <Link href={clustersHref} className="text-primary hover:underline">
                  Clusters tab
                </Link>
                )
              </>
            ) : null}
            . Pairs only land here once a reviewer confirms (or overrides) a decision — agent
            proposals start as <code>proposed</code> in the Open tab and graduate to Decided after
            confirmation, not before.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No pairs to review. Run the pipeline to populate the queue.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-secondary/60 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Pair</th>
            <th className="px-3 py-2 text-left font-medium">Score</th>
            <th className="px-3 py-2 text-left font-medium">Band</th>
            <th className="px-3 py-2 text-left font-medium">Sources</th>
            <th className="px-3 py-2 text-left font-medium">Records</th>
            <th className="px-3 py-2 text-left font-medium">Decision</th>
            <th className="w-6 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.pair_id === selectedPairId;
            const agentProposal = readAgentProposalFromQueueRow(row);
            return (
              <tr
                key={row.pair_id}
                onClick={() => onSelect(row.pair_id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(row.pair_id);
                  }
                }}
                tabIndex={0}
                aria-selected={selected}
                className={`cursor-pointer border-t border-border transition-colors ${
                  selected ? 'bg-primary/10' : 'hover:bg-secondary/60 focus-visible:bg-secondary/60'
                }`}
              >
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(row.pair_id);
                    }}
                    className="font-mono text-[11px] text-muted-foreground hover:text-foreground focus:text-foreground"
                    aria-pressed={selected}
                    aria-label={
                      selected
                        ? `Inspect pair ${row.pair_id}, selected`
                        : `Inspect pair ${row.pair_id}`
                    }
                  >
                    {row.pair_id.slice(0, 10)}…
                  </button>
                </td>
                <td className="px-3 py-2 font-semibold tabular-nums">
                  {row.composite_score.toFixed(3)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${bandClasses(row.threshold_band)}`}
                  >
                    {row.threshold_band}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {row.source_a} ↔ {row.source_b}
                </td>
                <td className="px-3 py-2">
                  <div className="text-xs">
                    <div className="truncate">{row.a_display_label ?? row.record_a_id}</div>
                    <div className="truncate text-muted-foreground">
                      {row.b_display_label ?? row.record_b_id}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {agentProposal ? (
                    <div className="flex flex-col gap-1">
                      <span
                        className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-medium ${decisionClasses(agentProposal.proposed_decision)}`}
                      >
                        agent proposes: {agentProposal.proposed_decision}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {(agentProposal.proposed_confidence * 100).toFixed(0)}% confident · awaiting
                        review
                      </span>
                    </div>
                  ) : row.decision ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${decisionClasses(row.decision)}`}
                    >
                      {row.decision}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right text-muted-foreground">
                  <span className={selected ? 'text-primary' : ''}>›</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
