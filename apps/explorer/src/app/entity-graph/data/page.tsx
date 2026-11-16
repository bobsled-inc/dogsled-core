'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  buildEntityGraphDataQuickQueries,
  isEntityGraphDataQuickQuery,
} from '@/lib/entity-graph-data-queries';
import {
  getEntityGraphEntityDefinition,
  getEntityGraphScenarioDefinition,
  isInvalidEntityGraphInputError,
  isEntityGraphEntityId,
  isEntityGraphScenarioId,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
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

const ENTITY_GRAPH_SCENARIOS: { scenario: EntityGraphScenarioId; label: string }[] = [
  { scenario: 'default', label: 'Entity Graph Demo (company_resolution.db)' },
];

const QUERY_HISTORY_STORAGE_KEY = 'bobsled-explorer-entity_graph-query-history';
const LEGACY_QUERY_HISTORY_STORAGE_KEY = 'bobsled-explorer-mdm-query-history';
const MAX_DISPLAY_ROWS = 500;

function resolveDataPageSelection(
  scenarioId: EntityGraphScenarioId,
  entityValue?: string | null
): { scenarioId: EntityGraphScenarioId; entityId: EntityGraphEntityId } {
  try {
    const resolved = resolveEntityGraphScenarioEntity(scenarioId, entityValue);
    return { scenarioId: resolved.scenarioId, entityId: resolved.entityId };
  } catch (err) {
    if (!isInvalidEntityGraphInputError(err)) {
      throw err;
    }
    const resolved = resolveEntityGraphScenarioEntity(scenarioId, null);
    return { scenarioId: resolved.scenarioId, entityId: resolved.entityId };
  }
}

export default function EntityGraphDataPage() {
  const initialScenario = ENTITY_GRAPH_SCENARIOS[0]?.scenario ?? 'default';
  const initialEntity = getEntityGraphScenarioDefinition(initialScenario).defaultEntity;
  const [scenario, setScenario] = useState<EntityGraphScenarioId>(initialScenario);
  const [entity, setEntity] = useState<EntityGraphEntityId>(initialEntity);
  const [sql, setSql] = useState(
    buildEntityGraphDataQuickQueries(initialScenario, initialEntity)[0]?.sql ?? ''
  );
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const previousSelectionRef = useRef<{
    scenario: EntityGraphScenarioId;
    entity: EntityGraphEntityId;
  }>({
    scenario: initialScenario,
    entity: initialEntity,
  });
  const quickQueries = useMemo(
    () => buildEntityGraphDataQuickQueries(scenario, entity),
    [entity, scenario]
  );
  const defaultQuickQuery = quickQueries[0]?.sql ?? '';
  const entityOptions = useMemo(
    () => getEntityGraphScenarioDefinition(scenario).supportedEntities,
    [scenario]
  );

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const requestedScenario = searchParams.get('scenario');
    const requestedEntity = searchParams.get('entity');
    const nextScenario = isEntityGraphScenarioId(requestedScenario)
      ? requestedScenario
      : initialScenario;
    const resolved = resolveDataPageSelection(nextScenario, requestedEntity);
    setScenario(resolved.scenarioId);
    setEntity(resolved.entityId);
    const currentRaw = loadStoredJson<unknown>(QUERY_HISTORY_STORAGE_KEY, null);
    const historyRaw = currentRaw ?? loadStoredJson<unknown>(LEGACY_QUERY_HISTORY_STORAGE_KEY, []);
    const normalized = loadHistory(historyRaw);
    if (currentRaw === null && normalized.length > 0) {
      saveStoredJson(QUERY_HISTORY_STORAGE_KEY, normalized);
    }
    setHistory(normalized);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previousSelection = previousSelectionRef.current;
    if (previousSelection.scenario === scenario && previousSelection.entity === entity) return;

    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setResult(null);
    setSql((currentSql) =>
      !currentSql.trim() ||
      isEntityGraphDataQuickQuery(currentSql, previousSelection.scenario, previousSelection.entity)
        ? defaultQuickQuery
        : currentSql
    );
    previousSelectionRef.current = { scenario, entity };
  }, [defaultQuickQuery, entity, scenario]);

  const runQuery = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setResult(null);
      try {
        const response = await explorerFetch('/api/entity-graph/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario, entity, sql: query }),
          signal: controller.signal,
        });
        const data = (await response.json()) as QueryResult;
        if (controller.signal.aborted) return;
        setResult(data);
        if (!data.error && query.trim()) {
          const entry: HistoryEntry = {
            sql: query,
            scenario,
            entity,
            timestamp: Date.now(),
            rowCount: data.rows?.length,
          };
          setHistory((previous) => {
            const next = [
              entry,
              ...previous.filter(
                (e) => !(e.sql === query && e.scenario === scenario && e.entity === entity)
              ),
            ].slice(0, 20);
            saveStoredJson(QUERY_HISTORY_STORAGE_KEY, next);
            return next;
          });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setResult({ rows: [], count: 0, error: String(err) });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [entity, scenario]
  );

  const columns = result?.rows?.[0] ? Object.keys(result.rows[0]) : [];
  const displayedRows = result?.rows ? result.rows.slice(0, MAX_DISPLAY_ROWS) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Entity Graph', href: '/entity-graph' },
          { label: 'Data' },
        ]}
        title="Entity Graph Data"
        description="Query Entity Graph workspace databases for entity profiles, clusters, and review queues."
      />

      {/* Scenario picker */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-muted-foreground">Workspace:</label>
        <select
          value={scenario}
          onChange={(event) => {
            if (!isEntityGraphScenarioId(event.target.value)) return;
            const resolved = resolveDataPageSelection(event.target.value, entity);
            setScenario(resolved.scenarioId);
            setEntity(resolved.entityId);
          }}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {ENTITY_GRAPH_SCENARIOS.map((option) => (
            <option key={option.scenario} value={option.scenario}>
              {option.label}
            </option>
          ))}
        </select>
        {entityOptions.length > 1 && (
          <>
            <label className="text-xs text-muted-foreground">Entity:</label>
            <select
              value={entity}
              onChange={(event) => {
                if (!isEntityGraphEntityId(event.target.value)) return;
                const resolved = resolveDataPageSelection(scenario, event.target.value);
                setEntity(resolved.entityId);
              }}
              className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {entityOptions.map((entityOption) => (
                <option key={entityOption} value={entityOption}>
                  {getEntityGraphEntityDefinition(entityOption).label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Quick queries */}
      <div className="flex flex-wrap gap-1.5">
        {quickQueries.map((query) => (
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
          placeholder={defaultQuickQuery}
          rows={6}
          textareaProps={{ 'aria-label': 'Entity Graph SQL query editor' }}
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
          0 rows returned. Run the Terminal seed command first if the Entity Graph workspace
          hasn&apos;t been seeded.{' '}
          <Link href="/terminal" className="text-primary hover:underline">
            Open Terminal →
          </Link>
        </div>
      )}

      {result?.rows && result.rows.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] text-muted-foreground">
              {result.count} row{result.count !== 1 ? 's' : ''}
              {result.truncated ? ` (truncated)` : ''}
            </div>
            <div className="flex gap-2">
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
                  <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground">
                    When
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((entry, index) => (
                  <tr key={index} className="hover:bg-secondary/40">
                    <td className="max-w-xs px-4 py-2 font-mono text-[10px]">
                      <button
                        type="button"
                        className="w-full truncate text-left"
                        onClick={() => {
                          if (isEntityGraphScenarioId(entry.scenario)) {
                            const resolved = resolveDataPageSelection(
                              entry.scenario,
                              isEntityGraphEntityId(entry.entity) ? entry.entity : null
                            );
                            setScenario(resolved.scenarioId);
                            setEntity(resolved.entityId);
                          }
                          setSql(entry.sql);
                        }}
                        title={entry.sql}
                        aria-label="Restore query"
                      >
                        {entry.sql}
                      </button>
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
