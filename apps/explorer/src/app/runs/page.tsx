'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { buildTerminalHref } from '@/lib/command-links';
import { clearRuns, loadRuns, type RunRecord } from '@/lib/run-history';
import { PageHeader } from '@/components/ui/page-header';

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return `${seconds}s`;
}

function getRunIntegrations(run: RunRecord): string[] {
  const all: string[] = [];
  if (run.integration) all.push(run.integration);
  if (run.integrations) all.push(...run.integrations);
  return Array.from(new Set(all));
}

function parseLocalDateBoundary(value: string, endOfDay = false): Date | null {
  if (!value) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failure'>('all');
  const [integrationFilter, setIntegrationFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    setRuns(loadRuns());
  }, []);

  const integrations = useMemo(() => [...new Set(runs.flatMap(getRunIntegrations))].sort(), [runs]);

  const filteredRuns = useMemo(() => {
    const fromBoundary = parseLocalDateBoundary(fromDate);
    const toBoundary = parseLocalDateBoundary(toDate, true);
    return runs.filter((run) => {
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'success'
            ? run.exitCode === 0
            : run.exitCode !== 0;
      const matchesIntegration =
        integrationFilter === 'all' ? true : getRunIntegrations(run).includes(integrationFilter);
      const runDate = new Date(run.startedAt);
      const matchesFrom = fromBoundary ? runDate >= fromBoundary : true;
      const matchesTo = toBoundary ? runDate <= toBoundary : true;
      return matchesStatus && matchesIntegration && matchesFrom && matchesTo;
    });
  }, [fromDate, integrationFilter, runs, statusFilter, toDate]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Runs"
        description="Review recent Bobsled Core CLI runs, reopen them in Terminal, or jump straight into DuckDB results."
        actions={
          <button
            type="button"
            onClick={() => {
              clearRuns();
              setRuns([]);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Clear history
          </button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <select
          aria-label="Filter runs by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as 'all' | 'success' | 'failure')}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All statuses</option>
          <option value="success">Success only</option>
          <option value="failure">Failures only</option>
        </select>

        <select
          aria-label="Filter runs by integration"
          value={integrationFilter}
          onChange={(event) => setIntegrationFilter(event.target.value)}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All integrations</option>
          {integrations.map((integration) => (
            <option key={integration} value={integration}>
              {integration}
            </option>
          ))}
        </select>

        <input
          type="date"
          aria-label="Filter runs from date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          type="date"
          aria-label="Filter runs to date"
          value={toDate}
          onChange={(event) => setToDate(event.target.value)}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-xs">
          <thead className="bg-secondary/60">
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Command
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Integration
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Started
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Duration
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Exit
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredRuns.map((run) => (
              <Fragment key={run.id}>
                <tr key={run.id} className="border-b border-border align-top hover:bg-secondary/40">
                  <td className="px-4 py-3 font-mono text-[11px]">
                    {run.command} {run.args.join(' ')}
                  </td>
                  <td className="px-4 py-3">{run.integration ?? '—'}</td>
                  <td className="px-4 py-3">{formatDateTime(run.startedAt)}</td>
                  <td className="px-4 py-3">{formatDuration(run.startedAt, run.endedAt)}</td>
                  <td
                    className={`px-4 py-3 font-medium ${run.exitCode === 0 ? 'text-accent' : 'text-destructive'}`}
                  >
                    <span className="mr-1" aria-hidden="true">
                      ●
                    </span>
                    {run.exitCode ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={buildTerminalHref(
                          run.sequence
                            ? { sequence: run.sequence }
                            : { command: run.command, args: run.args }
                        )}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Re-run
                      </Link>
                      {run.dbPath && (
                        <Link
                          href={`/operate/data?db=${encodeURIComponent(run.dbPath)}`}
                          className="text-[10px] text-primary hover:underline"
                        >
                          Query results
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId((current) => (current === run.id ? null : run.id))
                        }
                        className="text-[10px] text-primary hover:underline"
                      >
                        {expandedId === run.id ? 'Hide output' : 'Show output'}
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedId === run.id && (
                  <tr className="border-b border-border bg-secondary/20">
                    <td colSpan={6} className="px-4 py-3">
                      <pre className="max-h-96 overflow-auto rounded-2xl border border-border bg-card p-4 font-mono text-[11px] whitespace-pre-wrap">
                        {run.stdoutLines.join('\n')}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filteredRuns.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No runs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
