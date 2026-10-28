'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { formatMemberDate, isDateField } from '@/lib/format';
import { isPlainObject } from '@/lib/guards';
import {
  buildEntityGraphHref,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import {
  parseClusterDetailPayload,
  type ClusterDetailAuditRow as AuditRow,
  type ClusterDetailGoldenRow,
  type ClusterDetailMember,
  type ClusterDetailPayload,
} from '@/lib/entity-graph-cluster-detail';

interface ClusterDetailProps {
  clusterId: string | null;
  scenario: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
}

const MEMBER_COLUMN_LIMIT = 5;

export function ClusterDetail({ clusterId, scenario, entity }: ClusterDetailProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [data, setData] = useState<ClusterDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAllMembers, setShowAllMembers] = useState(false);
  // `nowMs` stays null during SSR so formatMemberDate falls back to the
  // calendar format and the server-rendered HTML matches the client's first
  // paint. After hydration the effect below sets it to Date.now() and the
  // dates flip to relative wording — no React mismatch warning.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  // Build the URL to jump to the review queue tab pre-filtered to this cluster.
  // When the cluster detail is rendered inside a `/.../resolve/clusters/<id>`
  // page, strip the trailing `/clusters/...` so we navigate to the matching
  // `/.../resolve` page. When it's embedded in the resolve page itself, stay
  // on the same path. Fall back to the generic `/entity-graph/resolve` route when the
  // pathname is unavailable (e.g. during SSR).
  //
  // Preserve any existing query params (e.g. scenario/entity context on the
  // detail page) and override only `tab` and `cluster` — otherwise the link
  // drops the active workspace context and lands the user in the default
  // queue instead of the filtered one.
  const queueHref = useMemo(() => {
    if (!clusterId) return null;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('tab', 'queue');
    params.set('cluster', clusterId);
    const clustersIdx = pathname?.indexOf('/clusters/') ?? -1;
    const resolveBase =
      clustersIdx >= 0 && pathname ? pathname.slice(0, clustersIdx) : (pathname ?? null);
    if (resolveBase && resolveBase.endsWith('/resolve')) {
      return `${resolveBase}?${params.toString()}`;
    }
    return buildEntityGraphHref('/entity-graph/resolve', {
      scenario,
      entity,
      params: Object.fromEntries(params.entries()),
    });
  }, [clusterId, pathname, scenario, entity, searchParams]);

  useEffect(() => {
    if (!clusterId) {
      setData(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(
      `/api/entity-graph/clusters/${encodeURIComponent(clusterId)}?scenario=${encodeURIComponent(scenario)}&entity=${encodeURIComponent(entity)}`,
      { signal: controller.signal }
    )
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        if (cancelled) return;
        const apiError = isPlainObject(json) && typeof json.error === 'string' ? json.error : null;
        if (!r.ok || apiError) {
          setError(apiError ?? `HTTP ${r.status}`);
          setData(null);
          return;
        }

        try {
          setData(parseClusterDetailPayload(json));
        } catch (parseError) {
          setError(
            parseError instanceof Error ? parseError.message : 'Invalid cluster detail response'
          );
          setData(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clusterId, entity, scenario]);

  if (!clusterId) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground">
        Select a cluster to inspect the golden record, members, and survivorship audit.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading cluster…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const { profile, members, golden_record, survivorship_audit, business_snapshot } = data;
  const isSingleton = profile.record_count === 1 || members.length === 1;
  const auditByAttr = new Map<string, AuditRow>();
  for (const row of survivorship_audit) {
    if (!auditByAttr.has(row.attribute_name)) auditByAttr.set(row.attribute_name, row);
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">
              {profile.display_name ?? profile.cluster_id}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {profile.cluster_id}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {queueHref && (
              <Link
                href={queueHref}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                View pairs in queue
                <span aria-hidden="true">→</span>
              </Link>
            )}
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Trust · {profile.trust_tier ?? 'unrated'}
              </div>
              <div className="text-sm font-semibold tabular-nums">
                {profile.entity_trust_score?.toFixed(2) ?? '—'}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
          <Stat label="Records" value={String(profile.record_count)} />
          <Stat label="Sources" value={String(profile.source_count)} />
          <Stat label="Identity" value={profile.identity_confidence?.toFixed(2) ?? '—'} />
          <Stat label="Freshness" value={profile.freshness_score?.toFixed(2) ?? '—'} />
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {business_snapshot.length > 0 && (
          <section className="grid gap-2 md:grid-cols-3">
            {business_snapshot.map((card, index) => (
              <div
                key={`${card.label}-${index}`}
                className="rounded-md border border-border bg-background/40 p-3"
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {card.label}
                </div>
                <div className="mt-1 text-sm font-semibold">{card.value}</div>
                {card.context && (
                  <div className="mt-1 text-xs text-muted-foreground">{card.context}</div>
                )}
              </div>
            ))}
          </section>
        )}

        <SurvivorshipDiff
          members={members}
          goldenRecord={golden_record}
          auditByAttr={auditByAttr}
          isSingleton={isSingleton}
          showAllMembers={showAllMembers}
          onToggleShowAll={() => setShowAllMembers((prev) => !prev)}
          nowMs={nowMs}
        />

        {isSingleton && (
          <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
            This entity has no confirmed merge partners. Its score against all candidates fell below
            the auto-merge threshold. If you believe it should be merged with another cluster, use
            the Queue to locate the pair and decide manually.
          </div>
        )}

        {survivorship_audit.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Survivorship audit
            </h3>
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border">
              {survivorship_audit.map((row, idx) => (
                <li
                  key={`${row.attribute_name}-${idx}`}
                  className="flex items-center justify-between gap-2 px-3 py-1 text-[11px]"
                >
                  <span className="font-medium">{row.attribute_name}</span>
                  <span className="text-muted-foreground">
                    {row.strategy ?? '—'} · from {row.source_system ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}

interface SurvivorshipDiffProps {
  members: ClusterDetailMember[];
  goldenRecord: ClusterDetailGoldenRow[];
  auditByAttr: Map<string, AuditRow>;
  isSingleton: boolean;
  showAllMembers: boolean;
  onToggleShowAll: () => void;
  /**
   * Reference moment for relative date wording. Stays `null` during SSR so
   * formatMemberDate falls back to the calendar format and the server HTML
   * matches the client's first paint.
   */
  nowMs: number | null;
}

function SurvivorshipDiff({
  members,
  goldenRecord,
  auditByAttr,
  isSingleton,
  showAllMembers,
  onToggleShowAll,
  nowMs,
}: SurvivorshipDiffProps) {
  if (goldenRecord.length === 0 && members.length === 0) {
    return (
      <section>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Survivorship diff
        </h3>
        <div className="mt-2 rounded-md border border-border p-3 text-center text-xs text-muted-foreground">
          No golden-record attributes yet. Run survivorship to populate.
        </div>
      </section>
    );
  }

  const totalMembers = members.length;
  const overflow = !isSingleton && totalMembers > MEMBER_COLUMN_LIMIT;
  const visibleMembers =
    overflow && !showAllMembers ? members.slice(0, MEMBER_COLUMN_LIMIT) : members;
  const hiddenCount = totalMembers - visibleMembers.length;

  // Build a per-member field-key lookup for fast diffing.
  const memberFieldMaps = visibleMembers.map((member) => {
    const map = new Map<string, { key: string; value: string | null; label: string }>();
    for (const f of member.member_fields) map.set(f.key, f);
    return map;
  });

  // Union of attribute rows: golden record first, then any member field keys
  // that aren't in the golden record (rare, but keeps reader oriented).
  // Only consider visible members so collapsed-view rows don't render empty
  // cells for fields that exist solely on hidden members.
  const goldenKeys = new Set(goldenRecord.map((row) => row.attribute_name));
  const extraKeys: { key: string; label: string }[] = [];
  const seen = new Set<string>(goldenKeys);
  for (const member of visibleMembers) {
    for (const f of member.member_fields) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      extraKeys.push({ key: f.key, label: f.label });
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {isSingleton ? 'Source values' : 'Survivorship diff'}
        </h3>
        {overflow && (
          <button
            type="button"
            onClick={onToggleShowAll}
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAllMembers ? 'Show first 5' : `Show all (${totalMembers})`}
          </button>
        )}
      </div>
      <div className="mt-2 overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[480px] text-xs">
          <thead className="bg-secondary/60 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Attribute</th>
              {visibleMembers.map((m) => (
                <th
                  key={m.record_id}
                  className="px-3 py-1.5 text-left font-medium"
                  title={m.record_id}
                >
                  <div className="truncate">{m.source_system}</div>
                  {m.confidence_score !== null && (
                    <div className="font-mono text-[9px] normal-case tracking-normal text-muted-foreground/70">
                      conf {m.confidence_score.toFixed(2)}
                    </div>
                  )}
                </th>
              ))}
              {!isSingleton && (
                <th className="border-l border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5 text-left font-medium text-emerald-400">
                  Winner
                </th>
              )}
            </tr>
            {overflow && !showAllMembers && (
              <tr>
                <td
                  colSpan={1 + visibleMembers.length + (isSingleton ? 0 : 1)}
                  className="border-t border-border bg-secondary/30 px-3 py-1 text-[10px] normal-case tracking-normal text-muted-foreground"
                >
                  Showing {visibleMembers.length} of {totalMembers} members. {hiddenCount} hidden.
                </td>
              </tr>
            )}
          </thead>
          <tbody>
            {goldenRecord.map((row) => {
              const audit = auditByAttr.get(row.attribute_name);
              const winnerValue = row.attribute_value;
              const winnerSource = row.source_system;
              const isDateAttr = isDateField({ key: row.attribute_name, value: winnerValue });
              return (
                <tr key={row.attribute_name} className="border-t border-border align-top">
                  <td className="px-3 py-1.5 font-medium">
                    {row.attribute_label ?? row.attribute_name}
                  </td>
                  {visibleMembers.map((member, memberIdx) => {
                    const field = memberFieldMaps[memberIdx]?.get(row.attribute_name);
                    const memberValue = field?.value ?? null;
                    const display = isDateAttr
                      ? formatMemberDate(memberValue, nowMs ?? undefined)
                      : (memberValue ?? '—');
                    const isWinner =
                      !isSingleton &&
                      memberValue !== null &&
                      winnerValue !== null &&
                      memberValue === winnerValue &&
                      (winnerSource === null || member.source_system === winnerSource);
                    const isLoser =
                      !isSingleton &&
                      !isWinner &&
                      memberValue !== null &&
                      winnerValue !== null &&
                      memberValue !== winnerValue;
                    return (
                      <td
                        key={member.record_id}
                        className={
                          isWinner
                            ? 'bg-emerald-500/10 px-3 py-1.5 ring-1 ring-inset ring-emerald-500/30'
                            : isLoser
                              ? 'px-3 py-1.5 text-muted-foreground line-through'
                              : 'px-3 py-1.5 text-muted-foreground'
                        }
                      >
                        <span className="inline-flex items-center gap-1">
                          {isWinner && (
                            <span aria-hidden="true" className="text-emerald-400">
                              ✓
                            </span>
                          )}
                          <span className="truncate">{display}</span>
                        </span>
                      </td>
                    );
                  })}
                  {!isSingleton && (
                    <td className="border-l border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
                      <div className="font-medium">
                        {isDateAttr
                          ? formatMemberDate(winnerValue, nowMs ?? undefined)
                          : (winnerValue ?? '—')}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {audit?.strategy ?? '—'}
                        {winnerSource ? ` · ${winnerSource}` : ''}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {extraKeys.map((extra) => (
              <tr key={extra.key} className="border-t border-border align-top">
                <td className="px-3 py-1.5 font-medium text-muted-foreground">{extra.label}</td>
                {visibleMembers.map((member, memberIdx) => {
                  const field = memberFieldMaps[memberIdx]?.get(extra.key);
                  const memberValue = field?.value ?? null;
                  const display = isDateField({ key: extra.key, value: memberValue })
                    ? formatMemberDate(memberValue, nowMs ?? undefined)
                    : (memberValue ?? '—');
                  return (
                    <td key={member.record_id} className="px-3 py-1.5 text-muted-foreground/70">
                      {display}
                    </td>
                  );
                })}
                {!isSingleton && (
                  <td className="border-l border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5 text-[10px] text-muted-foreground">
                    not in golden record
                  </td>
                )}
              </tr>
            ))}
            {goldenRecord.length === 0 && extraKeys.length === 0 && (
              <tr>
                <td
                  colSpan={1 + visibleMembers.length + (isSingleton ? 0 : 1)}
                  className="px-3 py-3 text-center text-muted-foreground"
                >
                  No attributes to compare.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
