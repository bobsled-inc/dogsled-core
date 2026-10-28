'use client';

import { useCallback, useMemo, useState } from 'react';
import { formatCount } from '@/lib/format';

export type ClusterRow = {
  cluster_id: string;
  display_name: string | null;
  source_count: number;
  record_count: number;
  entity_confidence: number | null;
  observed_at: string | null;
  trust_tier: string | null;
  entity_trust_score: number | null;
};

type SortKey = 'record_count_desc' | 'record_count_asc' | 'trust_desc' | 'last_touched_desc';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'record_count_desc', label: 'Records (high → low)' },
  { value: 'record_count_asc', label: 'Records (low → high)' },
  { value: 'trust_desc', label: 'Trust (gold → unrated)' },
  { value: 'last_touched_desc', label: 'Last touched (newest)' },
];

const TRUST_RANK: Record<string, number> = {
  gold: 3,
  silver: 2,
  bronze: 1,
  unrated: 0,
};

function tierClasses(tier: string | null): string {
  if (tier === 'gold') return 'bg-amber-500/20 text-amber-600 dark:text-amber-400';
  if (tier === 'silver') return 'bg-slate-400/20 text-slate-500';
  if (tier === 'bronze') return 'bg-orange-500/15 text-orange-500';
  return 'bg-secondary text-muted-foreground';
}

function normalizeTier(tier: string | null): string {
  return tier ?? 'unrated';
}

function trustRankFor(tier: string | null): number {
  const normalized = normalizeTier(tier);
  return TRUST_RANK[normalized] ?? -1;
}

function observedAtMs(value: string | null): number {
  // Null/invalid timestamps sort to the bottom for "Last touched (newest)" sort.
  // Returning 0 (not -Infinity) keeps the sort stable when all values are missing.
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ClusterList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ClusterRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [tierSelection, setTierSelection] = useState<Set<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<SortKey>('record_count_desc');

  const tiers = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(normalizeTier(row.trust_tier));
    // Stable, intuitive order: gold → silver → bronze → unrated → other.
    const known = ['gold', 'silver', 'bronze', 'unrated'].filter((t) => set.has(t));
    const others = [...set].filter((t) => !known.includes(t)).sort();
    return [...known, ...others];
  }, [rows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const name = (row.display_name ?? row.cluster_id).toLowerCase();
      const matchesQuery = !normalizedQuery || name.includes(normalizedQuery);
      const matchesTier =
        tierSelection.size === 0 || tierSelection.has(normalizeTier(row.trust_tier));
      return matchesQuery && matchesTier;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'record_count_asc':
          return a.record_count - b.record_count;
        case 'record_count_desc':
          return b.record_count - a.record_count;
        case 'trust_desc': {
          const diff = trustRankFor(b.trust_tier) - trustRankFor(a.trust_tier);
          if (diff !== 0) return diff;
          return b.record_count - a.record_count;
        }
        case 'last_touched_desc':
          return observedAtMs(b.observed_at) - observedAtMs(a.observed_at);
        default:
          return 0;
      }
    });
    return sorted;
  }, [rows, query, tierSelection, sortKey]);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No clusters yet. Run the pipeline to build clusters.
      </div>
    );
  }

  const toggleTier = useCallback((tier: string) => {
    setTierSelection((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }, []);

  const clearTiers = useCallback(() => setTierSelection(new Set()), []);

  const tierFilterActive = tierSelection.size > 0;
  // Keep the filter visible whenever it's active, even if the underlying tier
  // set has shrunk to 0/1 since selection happened. Otherwise a previously
  // selected tier can disappear and leave the user with a non-clearable
  // "No clusters match" empty state.
  const showTierFilter = tiers.length > 1 || tierFilterActive;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search clusters"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clusters…"
          className="min-w-[160px] flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:border-primary"
        />
        <select
          aria-label="Sort clusters"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {showTierFilter && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Trust</span>
          <button
            type="button"
            onClick={clearTiers}
            aria-pressed={!tierFilterActive}
            className={`rounded-full px-2 py-0.5 text-[10px] ${
              !tierFilterActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground'
            }`}
          >
            All
          </button>
          {tiers.map((tier) => {
            const active = tierSelection.has(tier);
            return (
              <button
                key={tier}
                type="button"
                onClick={() => toggleTier(tier)}
                aria-pressed={active}
                className={`rounded-full px-2 py-0.5 text-[10px] ${
                  active ? 'bg-primary/15 text-primary' : 'text-muted-foreground'
                }`}
              >
                {tier}
              </button>
            );
          })}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground">
        Showing {formatCount(filteredRows.length)} of {formatCount(rows.length)} cluster
        {rows.length === 1 ? '' : 's'}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="max-h-[65vh] overflow-y-auto">
          <ul className="divide-y divide-border">
            {filteredRows.map((row) => {
              const selected = row.cluster_id === selectedId;
              return (
                <li key={row.cluster_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(row.cluster_id)}
                    aria-pressed={selected}
                    className={`block w-full px-4 py-3 text-left transition-colors ${
                      selected ? 'bg-primary/10' : 'hover:bg-secondary/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium">
                        {row.display_name ?? row.cluster_id}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tierClasses(row.trust_tier)}`}
                      >
                        {normalizeTier(row.trust_tier)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        {row.record_count} record{row.record_count === 1 ? '' : 's'} ·{' '}
                        {row.source_count} source{row.source_count === 1 ? '' : 's'}
                      </span>
                      {typeof row.entity_trust_score === 'number' && (
                        <span className="tabular-nums">{row.entity_trust_score.toFixed(2)}</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
            {filteredRows.length === 0 && (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                No clusters match.
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
