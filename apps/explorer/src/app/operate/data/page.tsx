'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { CodeEditor } from '@/components/ui/code-editor';
import { PageHeader } from '@/components/ui/page-header';
import {
  formatRelativeTime,
  inferColumnType,
  loadHistory,
  type HistoryEntry,
} from '@/lib/data-page-helpers';
import { loadStoredJson, saveStoredJson } from '@/lib/storage';

interface QueryResult {
  rows: Record<string, unknown>[];
  count: number;
  totalCount?: number;
  truncated?: boolean;
  maxRows?: number;
  raw?: string;
  error?: string;
}

interface SavedConnection {
  id: string;
  type: string;
  name: string;
  config: Record<string, string>;
}

const QUICK_QUERIES = [
  {
    label: 'Show tables',
    sql: 'SELECT table_schema, table_name FROM information_schema.tables ORDER BY table_schema, table_name',
  },
  {
    label: 'Table sizes',
    sql: 'SELECT table_name, estimated_size as size_bytes, column_count FROM duckdb_tables() ORDER BY estimated_size DESC',
  },
];

const STATIC_DATABASES = [{ label: 'Pipeline (pipeline.duckdb)', path: './pipeline.duckdb' }];

const DB_KEY_PICKER_PREFIX = '__dbkey__';
const QUERY_HISTORY_STORAGE_KEY = 'dogsled-explorer-query-history';
const CONNECTION_STORAGE_KEY = 'dogsled-explorer-connections';
const MAX_DISPLAY_ROWS = 500;

function escapeCsvValue(value: unknown): string {
  const stringValue = value == null ? '' : String(value);
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0] ?? {});
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvValue(row[column])).join(',')),
  ].join('\n');
}

function isSavedConnection(value: unknown): value is SavedConnection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SavedConnection>;
  return typeof candidate.id === 'string' && typeof candidate.type === 'string';
}

function loadConnections(): SavedConnection[] {
  const raw = loadStoredJson<unknown[]>(CONNECTION_STORAGE_KEY, [], (value): value is unknown[] =>
    Array.isArray(value)
  );
  return raw.filter(isSavedConnection);
}

export default function OperateDataPage() {
  const [dbPath, setDbPath] = useState('./pipeline.duckdb');
  const [dbKey, setDbKey] = useState<string | null>(null);
  const [sql, setSql] = useState(QUICK_QUERIES[0]?.sql ?? '');
  const [pendingAutorunSql, setPendingAutorunSql] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [selectedCloudConnectionId, setSelectedCloudConnectionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const searchParams = new URLSearchParams(window.location.search);
    const requestedDbKey = searchParams.get('dbKey');
    const requestedDb = searchParams.get('db');
    const requestedSql = searchParams.get('sql');
    if (requestedDbKey) {
      setDbKey(requestedDbKey);
      setSelectedCloudConnectionId(null);
    } else if (requestedDb) {
      setDbKey(null);
      if (requestedDb.startsWith('__cloud__')) {
        setSelectedCloudConnectionId(requestedDb.slice('__cloud__'.length));
      } else {
        setSelectedCloudConnectionId(null);
      }
      setDbPath(requestedDb);
    }
    if (requestedSql) {
      setSql(requestedSql);
      if (searchParams.get('autorun') === '1') {
        setPendingAutorunSql(requestedSql);
      }
    }
    setHistory(loadHistory(loadStoredJson<unknown>(QUERY_HISTORY_STORAGE_KEY, [])));
    setConnections(loadConnections());
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const duckdbConnections = connections.filter((c) => c.type === 'duckdb');
  const cloudConnections = connections.filter((c) => c.type !== 'duckdb');

  const allDatabases = [
    ...(dbKey
      ? // Keep linked database keys as picker sentinels so dbPath remains a real filesystem path.
        [{ label: `Linked database (${dbKey})`, path: `${DB_KEY_PICKER_PREFIX}${dbKey}` }]
      : []),
    ...STATIC_DATABASES,
    ...duckdbConnections.map((c) => ({
      label: `${c.name} (${c.config.path ?? c.id})`,
      path: c.config.path ?? '',
    })),
    ...cloudConnections.map((c) => ({
      label: `${c.name} (${c.type})`,
      path: `__cloud__${c.id}`,
    })),
  ];

  const selectedConnection = selectedCloudConnectionId
    ? cloudConnections.find((c) => c.id === selectedCloudConnectionId)
    : null;

  const pickerValue = dbKey
    ? `${DB_KEY_PICKER_PREFIX}${dbKey}`
    : selectedCloudConnectionId
      ? `__cloud__${selectedCloudConnectionId}`
      : allDatabases.some((db) => db.path === dbPath)
        ? dbPath
        : '__custom__';

  const isCustomPath =
    !dbKey && !selectedCloudConnectionId && !allDatabases.some((db) => db.path === dbPath);

  const runQuery = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setResult(null);
      try {
        const response = await explorerFetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dbPath, dbKey: dbKey ?? undefined, sql: query }),
          signal: ac.signal,
        });
        const data = (await response.json()) as QueryResult;
        if (ac.signal.aborted || !mountedRef.current) return;
        setResult(data);
        if (!data.error && query.trim()) {
          const entry: HistoryEntry = {
            sql: query,
            dbPath,
            dbKey: dbKey ?? undefined,
            timestamp: Date.now(),
            rowCount: data.rows?.length,
          };
          setHistory((previous) => {
            const next = [
              entry,
              ...previous.filter(
                (e) => !(e.sql === query && e.dbPath === dbPath && e.dbKey === (dbKey ?? undefined))
              ),
            ].slice(0, 20);
            saveStoredJson(QUERY_HISTORY_STORAGE_KEY, next);
            return next;
          });
        }
      } catch (err) {
        if (ac.signal.aborted || !mountedRef.current) return;
        setResult({ rows: [], count: 0, error: String(err) });
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          if (mountedRef.current) setLoading(false);
        }
      }
    },
    [dbKey, dbPath]
  );

  useEffect(() => {
    if (!pendingAutorunSql) {
      return;
    }

    const query = pendingAutorunSql;
    setPendingAutorunSql(null);
    void runQuery(query);
  }, [pendingAutorunSql, runQuery]);

  const columns = result?.rows?.[0] ? Object.keys(result.rows[0]) : [];
  const displayedRows = result?.rows ? result.rows.slice(0, MAX_DISPLAY_ROWS) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        breadcrumbs={[{ label: 'Dogsled', href: '/' }, { label: 'Data' }]}
        title="Pipeline Data"
        description="Query DuckDB databases from extracted pipeline data. Add connections in the Connections page to query additional databases."
      />

      {/* Database picker */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-muted-foreground">Database:</label>
        <select
          value={pickerValue}
          onChange={(event) => {
            const val = event.target.value;
            if (val.startsWith(DB_KEY_PICKER_PREFIX)) {
              const nextDbKey = val.slice(DB_KEY_PICKER_PREFIX.length);
              setDbKey(nextDbKey);
              setSelectedCloudConnectionId(null);
            } else if (val.startsWith('__cloud__')) {
              setDbKey(null);
              setSelectedCloudConnectionId(val.slice('__cloud__'.length));
            } else if (val !== '__custom__') {
              setDbKey(null);
              setSelectedCloudConnectionId(null);
              setDbPath(val);
            } else {
              setDbKey(null);
              setSelectedCloudConnectionId(null);
              setDbPath('');
            }
          }}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {allDatabases.map((db) => (
            <option key={db.path} value={db.path}>
              {db.label}
            </option>
          ))}
          <option value="__custom__">Custom path…</option>
        </select>
        {isCustomPath && (
          <input
            value={dbPath}
            onChange={(event) => setDbPath(event.target.value)}
            placeholder="path/to/database.duckdb"
            className="w-72 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        {duckdbConnections.length === 0 && cloudConnections.length === 0 && (
          <Link href="/operate/connections" className="text-xs text-primary hover:underline">
            Add connections →
          </Link>
        )}
      </div>

      {/* Cloud connection banner */}
      {selectedConnection && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs">
          <span className="font-medium">Querying via {selectedConnection.name}</span>
          {selectedConnection.type === 'bigquery' && (
            <span className="text-muted-foreground">
              {' '}
              (BigQuery). Ensure the service account has read access to the dataset.
            </span>
          )}
        </div>
      )}

      {/* Empty state */}
      {allDatabases.length <= 1 && duckdbConnections.length === 0 && (
        <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No pipeline has run yet.{' '}
          <Link href="/pipelines/new" className="text-primary hover:underline">
            Build and run a pipeline
          </Link>{' '}
          to see data here.
        </div>
      )}

      {/* Quick queries */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_QUERIES.map((query) => (
          <button
            key={query.label}
            type="button"
            onClick={() => {
              setSql(query.sql);
              void runQuery(query.sql);
            }}
            className="rounded-md bg-secondary px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            {query.label}
          </button>
        ))}
      </div>

      {/* SQL Editor */}
      <div className="space-y-2">
        <CodeEditor
          value={sql}
          onChange={setSql}
          language="sql"
          placeholder="SELECT * FROM stripe__customers LIMIT 100"
          rows={6}
          textareaProps={{ 'aria-label': 'SQL query editor' }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runQuery(sql);
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">Ctrl+Enter to run</span>
          <button
            type="button"
            onClick={() => void runQuery(sql)}
            disabled={!sql.trim() || loading}
            className="rounded-md bg-primary px-4 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Running...' : 'Run Query'}
          </button>
        </div>
      </div>

      {result?.error && (
        <div className="rounded-2xl border border-destructive/20 border-l-4 border-l-destructive bg-destructive/10 p-4">
          <div className="font-mono text-xs text-destructive">{result.error}</div>
        </div>
      )}

      {result && !result.error && result.rows?.length === 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
          0 rows returned.
        </div>
      )}

      {result?.rows && result.rows.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1 text-[10px] text-muted-foreground">
              <div>
                {result.count} row{result.count !== 1 ? 's' : ''}
                {result.truncated && result.totalCount !== undefined
                  ? ` of ${result.totalCount}+ (truncated)`
                  : ''}
              </div>
              {result.truncated && result.maxRows !== undefined && (
                <div className="text-warning">
                  Server returned first {result.maxRows} rows. Add a LIMIT clause or narrow the
                  query.
                </div>
              )}
              {!result.truncated && result.count > MAX_DISPLAY_ROWS && (
                <div className="text-warning">Showing first {MAX_DISPLAY_ROWS} rows</div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(toCsv(result.rows))}
                className="text-[10px] text-primary hover:underline"
              >
                Copy as CSV
              </button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2))
                }
                className="text-[10px] text-primary hover:underline"
              >
                Copy as JSON
              </button>
            </div>
          </div>
          <div className="max-h-[500px] overflow-auto rounded-2xl border border-border bg-card">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-secondary/60">
                <tr className="border-b border-border">
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="whitespace-nowrap px-3 py-2 text-left text-[10px] font-medium text-muted-foreground"
                    >
                      <div>{column}</div>
                      <Badge className="mt-1" variant="primary">
                        {inferColumnType(displayedRows, column)}
                      </Badge>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {displayedRows.map((row, index) => (
                  <tr key={index} className="hover:bg-secondary/40">
                    {columns.map((column) => (
                      <td
                        key={column}
                        className="max-w-xs truncate whitespace-nowrap px-3 py-1.5 font-mono text-[10px]"
                      >
                        {row[column] === null ? (
                          <span className="italic text-muted-foreground">null</span>
                        ) : (
                          String(row[column])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result?.raw && (
        <pre className="max-h-96 overflow-auto rounded-2xl border border-border bg-card p-4 font-mono text-[11px]">
          {result.raw}
        </pre>
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Query History</span>
            <span className="text-[10px] text-muted-foreground">{history.length} saved</span>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground">
                    Query
                  </th>
                  <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground">
                    Database
                  </th>
                  <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground">
                    Rows
                  </th>
                  <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground">
                    When
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((entry, index) => (
                  <tr key={index} className="hover:bg-secondary/40 transition-colors">
                    <td className="max-w-xs truncate px-4 py-2 font-mono text-[10px]">
                      <button
                        type="button"
                        className="w-full truncate text-left"
                        onClick={() => {
                          if (entry.dbKey) {
                            setDbKey(entry.dbKey);
                            setSelectedCloudConnectionId(null);
                            if (entry.dbPath) {
                              setDbPath(entry.dbPath);
                            }
                          } else if (entry.dbPath) {
                            setDbKey(null);
                            if (entry.dbPath.startsWith('__cloud__')) {
                              setSelectedCloudConnectionId(entry.dbPath.slice('__cloud__'.length));
                            } else {
                              setSelectedCloudConnectionId(null);
                            }
                            setDbPath(entry.dbPath);
                          }
                          setSql(entry.sql);
                        }}
                        title={entry.sql}
                        aria-label={`Restore query for ${entry.dbKey ?? entry.dbPath ?? 'pipeline'}`}
                      >
                        {entry.sql}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-[10px] text-muted-foreground">
                      {entry.dbKey ?? entry.dbPath ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-[10px] text-muted-foreground">
                      {entry.rowCount ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-[10px] text-muted-foreground">
                      {formatRelativeTime(entry.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
