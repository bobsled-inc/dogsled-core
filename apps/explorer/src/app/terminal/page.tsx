'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { LogMessage, MetricMessage, ProgressMessage } from '@bobsled-inc/protocol';
import {
  collectProtocolStats,
  commandOutputsToText,
  getMetricTableRows,
} from '@/lib/command-insights';
import {
  buildTerminalHref,
  formatExplorerCommandForHistory,
  getDuckDbPathFromExplorerCommand,
  getIntegrationFromExplorerCommand,
  getIntegrationsFromExplorerCommand,
  isExplorerCommandSequence,
  isExplorerBobsledCommand,
  type ExplorerCommand,
} from '@/lib/command-links';
import { clearRuns, loadRuns, type RunRecord } from '@/lib/run-history';
import { saveRun } from '@/lib/run-history';
import { loadStoredJson, saveStoredJson } from '@/lib/storage';
import { useCommand, type CommandOutput } from '@/lib/use-command';
import { PageHeader } from '@/components/ui/page-header';

const COMMAND_SUGGESTIONS = [
  { cmd: 'integrations', args: ['list'], label: 'List integrations' },
  { cmd: 'integrations', args: ['list', '--type', 'api'], label: 'List API integrations' },
  { cmd: 'integrations', args: ['show', 'stripe'], label: 'Show Stripe integration' },
  { cmd: 'extract', args: ['--help'], label: 'Extract help' },
  { cmd: 'load', args: ['--help'], label: 'Load help' },
  { cmd: 'model', args: ['--help'], label: 'Model help' },
  { cmd: 'setup', args: ['describe', '--json'], label: 'Describe setup catalog' },
  { cmd: 'examples', args: ['--list'], label: 'List examples' },
];

const TERMINAL_HISTORY_STORAGE_KEY = 'bobsled-explorer-terminal-history';

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function formatCommandInput(command: ExplorerCommand): string {
  if (isExplorerCommandSequence(command)) {
    return command.sequence
      .map((entry) => `${entry.command} ${entry.args.join(' ')}`.trim())
      .join('\n');
  }

  return `${command.command} ${command.args.join(' ')}`.trim();
}

function OutputLine({ output }: { output: CommandOutput }) {
  const parsed = output.parsed;

  if (parsed?.type === 'LOG') {
    const { level, message } = parsed as LogMessage;
    const colorClass =
      level === 'error'
        ? 'text-destructive'
        : level === 'warn'
          ? 'text-warning'
          : level === 'debug'
            ? 'text-muted-foreground'
            : 'text-info';

    return (
      <div className={`font-mono text-[11px] ${colorClass}`}>
        <span className="mr-2 text-muted-foreground">[{level.toUpperCase()}]</span>
        {message}
      </div>
    );
  }

  if (parsed?.type === 'METRIC') {
    const { stream, metrics } = parsed as MetricMessage;
    return (
      <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2 text-[11px]">
        <div className="font-mono text-accent">
          <span className="mr-2 text-muted-foreground">[METRIC]</span>
          {stream}
        </div>
        <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.entries(metrics) as Array<[string, number | string | undefined]>)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => (
              <div key={key} className="font-mono text-[10px] text-muted-foreground">
                <span className="text-foreground">{key}</span>: {String(value)}
              </div>
            ))}
        </div>
      </div>
    );
  }

  if (parsed?.type === 'PROGRESS') {
    const { event, resource } = parsed as ProgressMessage;
    return (
      <div className="font-mono text-[11px] text-primary">
        <span className="mr-2 text-muted-foreground">[PROGRESS]</span>
        {event} {resource && <span className="text-foreground">{resource}</span>}
      </div>
    );
  }

  if (parsed?.type === 'SCHEMA') {
    return (
      <div className="font-mono text-[11px] text-warning">
        <span className="mr-2 text-muted-foreground">[SCHEMA]</span>
        {parsed.stream}
      </div>
    );
  }

  if (parsed?.type === 'RECORD') {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        <span className="mr-2">[RECORD]</span>
        <span className="truncate">{output.raw.slice(0, 200)}</span>
      </div>
    );
  }

  return (
    <div
      className={`whitespace-pre-wrap break-all font-mono text-[11px] ${
        output.stream === 'stderr' ? 'text-muted-foreground' : 'text-foreground'
      }`}
    >
      {output.raw}
    </div>
  );
}
export default function TerminalPage() {
  const [input, setInput] = useState('');
  const {
    running,
    outputs,
    exitCode,
    error,
    run: executeRun,
    runSequence,
    stop,
    clear,
    startedAt,
    completedAt,
  } = useCommand();
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [lastCommand, setLastCommand] = useState<ExplorerCommand | null>(null);
  const [activeTab, setActiveTab] = useState<'terminal' | 'history'>('terminal');
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [showLogOnly, setShowLogOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoRunRef = useRef(false);
  const savedRunRef = useRef<string | null>(null);

  const addToHistory = (entry: string) => {
    setHistory((previous) => {
      const next = [entry, ...previous.filter((item) => item !== entry)].slice(0, 50);
      saveStoredJson(TERMINAL_HISTORY_STORAGE_KEY, next);
      return next;
    });
  };

  useEffect(() => {
    setHistory(loadStoredJson<string[]>(TERMINAL_HISTORY_STORAGE_KEY, [], isStringArray));
    setRunHistory(loadRuns());
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('tab') === 'history') {
      setActiveTab('history');
    }
  }, []);

  useEffect(() => {
    if (autoRunRef.current) return;

    const searchParams = new URLSearchParams(window.location.search);
    const cmd = searchParams.get('cmd');
    if (!cmd) return;

    autoRunRef.current = true;

    try {
      const parsed = JSON.parse(cmd) as unknown;
      if (isExplorerBobsledCommand(parsed)) {
        setLastCommand(parsed);
        addToHistory(formatCommandInput(parsed));
        void executeRun(parsed.command, parsed.args);
        return;
      }
      if (isExplorerCommandSequence(parsed)) {
        setLastCommand(parsed);
        addToHistory(formatCommandInput(parsed));
        void runSequence(parsed.sequence);
        return;
      }
    } catch {
      const parts = cmd.trim().split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      if (!command) return;
      setLastCommand({ command, args });
      addToHistory(`${command} ${args.join(' ')}`.trim());
      void executeRun(command, args);
    }
  }, [executeRun, runSequence]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [outputs]);

  useEffect(() => {
    if (!lastCommand || !startedAt || !completedAt || running) {
      return;
    }

    const historyCommand = formatExplorerCommandForHistory(lastCommand);
    const runId = `${historyCommand.command}-${startedAt}-${completedAt}`;
    if (savedRunRef.current === runId) {
      return;
    }

    savedRunRef.current = runId;
    const integrations = getIntegrationsFromExplorerCommand(lastCommand);
    const record: RunRecord = {
      id: runId,
      command: historyCommand.command,
      args: historyCommand.args,
      sequence: isExplorerCommandSequence(lastCommand) ? lastCommand.sequence : undefined,
      startedAt,
      endedAt: completedAt,
      exitCode,
      stdoutLines: commandOutputsToText(outputs, exitCode, error).split('\n').slice(-400),
      integration: getIntegrationFromExplorerCommand(lastCommand),
      integrations: integrations.length > 0 ? integrations : undefined,
      dbPath: getDuckDbPathFromExplorerCommand(lastCommand),
    };
    setRunHistory(saveRun(record));
  }, [completedAt, error, exitCode, lastCommand, outputs, running, startedAt]);

  const handleSubmit = (command: string, args: string[]) => {
    const fullCommand = `${command} ${args.join(' ')}`.trim();
    addToHistory(fullCommand);
    setHistoryIndex(-1);
    setLastCommand({ command, args });
    void executeRun(command, args);
  };

  const handleInputSubmit = () => {
    const parts = input.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    if (!command) return;
    setInput('');
    handleSubmit(command, args);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleInputSubmit();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (history.length > 0) {
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex] ?? '');
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex] ?? '');
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (event.key === 'c' && event.ctrlKey) {
      stop();
    }
  };

  const downloadOutput = () => {
    const blob = new Blob([commandOutputsToText(outputs, exitCode, error)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'bobsled-terminal-output.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const dataHref = useMemo(() => {
    const dbPath = lastCommand ? getDuckDbPathFromExplorerCommand(lastCommand) : undefined;
    return dbPath ? `/operate/data?db=${encodeURIComponent(dbPath)}` : '/operate/data';
  }, [lastCommand]);
  const visibleOutputs = useMemo(
    () => (showLogOnly ? outputs.filter((output) => output.parsed?.type === 'LOG') : outputs),
    [outputs, showLogOnly]
  );
  const protocolStats = useMemo(
    () => collectProtocolStats(outputs, startedAt, completedAt),
    [completedAt, outputs, startedAt]
  );
  const metricRows = useMemo(() => getMetricTableRows(outputs).slice(-12), [outputs]);

  return (
    <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-6xl flex-col gap-4 p-6">
      <PageHeader
        breadcrumbs={[{ label: 'Bobsled Core', href: '/' }, { label: 'Terminal' }]}
        title="Terminal"
        description="Execute Bobsled Core commands with streaming output, then jump straight into the resulting DuckDB tables."
        actions={
          activeTab === 'terminal' ? (
            <>
              <button
                type="button"
                onClick={() => setShowLogOnly((value) => !value)}
                aria-pressed={showLogOnly}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  showLogOnly
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {showLogOnly ? 'Show All Output' : 'Filter Output'}
              </button>
              <button
                type="button"
                onClick={downloadOutput}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Download Output
              </button>
              <button
                type="button"
                onClick={clear}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Clear
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                clearRuns();
                setRunHistory([]);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              Clear history
            </button>
          )
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['terminal', 'history'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-2 text-xs font-medium capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'terminal' ? 'Terminal' : `History (${runHistory.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'history' && (
        <div className="flex-1 overflow-auto">
          {runHistory.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No CLI runs recorded yet. Run a command in the Terminal tab.
            </div>
          ) : (
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
                  {runHistory.map((run) => (
                    <Fragment key={run.id}>
                      <tr className="border-b border-border align-top hover:bg-secondary/40">
                        <td className="px-4 py-3 font-mono text-[11px]">
                          {run.command} {run.args.join(' ')}
                        </td>
                        <td className="px-4 py-3">{run.integration ?? '—'}</td>
                        <td className="px-4 py-3">
                          {dateFormatter.format(new Date(run.startedAt))}
                        </td>
                        <td className="px-4 py-3">
                          {Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))}s
                        </td>
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
                              onClick={(e) => {
                                e.preventDefault();
                                const rerunCommand: ExplorerCommand = run.sequence
                                  ? { sequence: run.sequence }
                                  : { command: run.command, args: run.args };
                                setActiveTab('terminal');
                                setLastCommand(rerunCommand);
                                addToHistory(formatCommandInput(rerunCommand));
                                if (run.sequence) {
                                  void runSequence(run.sequence);
                                } else {
                                  void executeRun(run.command, run.args);
                                }
                              }}
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
                                setExpandedRunId((c) => (c === run.id ? null : run.id))
                              }
                              className="text-[10px] text-primary hover:underline"
                            >
                              {expandedRunId === run.id ? 'Hide output' : 'Show output'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedRunId === run.id && (
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
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'terminal' && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {COMMAND_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                onClick={() => setInput(`${suggestion.cmd} ${suggestion.args.join(' ')}`.trim())}
                disabled={running}
                className="rounded bg-secondary px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {suggestion.label}
              </button>
            ))}
          </div>

          {protocolStats.totalStreams > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Bobsled Core protocol activity
              </div>
              <div className="flex flex-wrap gap-2">
                {protocolStats.streams.map((stream) => (
                  <div
                    key={stream.stream}
                    className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-[10px] text-muted-foreground"
                  >
                    <span className="text-foreground">{stream.stream}</span>:{' '}
                    {stream.records.toLocaleString()} records
                  </div>
                ))}
              </div>
            </div>
          )}

          <div
            ref={scrollRef}
            className="min-h-[400px] flex-1 space-y-1.5 overflow-auto rounded-2xl border border-border bg-card p-4"
          >
            {outputs.length === 0 && !running && !error && (
              <div className="text-xs text-muted-foreground">
                Enter a Bobsled Core command below, or click a quick command above.
                <br />
                <span className="text-[10px]">Example: integrations list --type api</span>
              </div>
            )}
            {visibleOutputs.map((output) => (
              <OutputLine key={output.id} output={output} />
            ))}
            {running && <div className="animate-pulse text-[11px] text-primary">Running...</div>}
            {exitCode !== null && (
              <div
                className={`mt-2 text-[11px] ${exitCode === 0 ? 'text-accent' : 'text-destructive'}`}
              >
                Process exited with code {exitCode}
              </div>
            )}
            {error && <div className="mt-2 text-[11px] text-destructive">{error}</div>}
          </div>

          {(metricRows.length > 0 || protocolStats.totalStreams > 0) && (
            <details className="rounded-2xl border border-border bg-card p-4">
              <summary className="cursor-pointer list-none text-sm font-medium">
                Bobsled Core protocol stats
              </summary>
              <div className="mt-3 space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-xl bg-secondary/40 p-3">
                    <div className="text-[10px] text-muted-foreground">Streams extracted</div>
                    <div className="mt-1 text-base font-semibold">{protocolStats.totalStreams}</div>
                  </div>
                  <div className="rounded-xl bg-secondary/40 p-3">
                    <div className="text-[10px] text-muted-foreground">Total records</div>
                    <div className="mt-1 text-base font-semibold">
                      {protocolStats.totalRecords.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl bg-secondary/40 p-3">
                    <div className="text-[10px] text-muted-foreground">Duration</div>
                    <div className="mt-1 text-base font-semibold">
                      {protocolStats.durationMs != null
                        ? `${(protocolStats.durationMs / 1000).toFixed(1)}s`
                        : '—'}
                    </div>
                  </div>
                  <div className="rounded-xl bg-secondary/40 p-3">
                    <div className="text-[10px] text-muted-foreground">Errors</div>
                    <div className="mt-1 text-base font-semibold">
                      {protocolStats.errors.length}
                    </div>
                  </div>
                </div>

                {metricRows.length > 0 && (
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-secondary/40">
                          <th className="px-3 py-2 text-left text-[10px] text-muted-foreground">
                            Stream
                          </th>
                          <th className="px-3 py-2 text-left text-[10px] text-muted-foreground">
                            Metric
                          </th>
                          <th className="px-3 py-2 text-left text-[10px] text-muted-foreground">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {metricRows.map((row) => (
                          <tr key={row.id} className="border-b border-border last:border-b-0">
                            <td className="px-3 py-2 font-mono text-[11px]">{row.stream}</td>
                            <td className="px-3 py-2 text-[11px] text-muted-foreground">
                              {row.name}
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px]">{row.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </details>
          )}

          {exitCode === 0 && (
            <div className="rounded-[24px] border border-border bg-card p-4">
              <div className="text-sm font-medium">Next step</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                If the command produced local tables, open Data Preview and inspect the results
                immediately.
              </p>
              <Link
                href={dataHref}
                className="mt-3 inline-block text-xs text-primary hover:underline"
              >
                Query the results
              </Link>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-primary">bobsled</span>
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="integrations list --type api"
              disabled={running}
              className="flex-1 rounded-md border border-border bg-input px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              autoFocus
            />
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground transition-colors hover:bg-destructive/80"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleInputSubmit}
                className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/85"
              >
                Run
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
