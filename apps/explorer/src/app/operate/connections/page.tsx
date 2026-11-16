'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';

type ConnectionType = 'bigquery' | 'snowflake' | 'postgres' | 'duckdb' | 's3' | 'gcs';

interface Connection {
  id: string;
  type: ConnectionType;
  name: string;
  createdAt: number;
  config: Record<string, string>;
}

const CONNECTION_STORAGE_KEY = 'bobsled-explorer-connections';
const SECRETS_STORAGE_KEY = 'bobsled-explorer-connection-secrets';

const CONNECTION_TYPES: {
  type: ConnectionType;
  label: string;
  description: string;
  fields: { key: string; label: string; placeholder?: string; sensitive?: boolean }[];
}[] = [
  {
    type: 'bigquery',
    label: 'BigQuery',
    description: 'Google Cloud data warehouse',
    fields: [
      { key: 'project', label: 'Project ID', placeholder: 'my-gcp-project' },
      { key: 'dataset', label: 'Dataset ID', placeholder: 'analytics' },
      { key: 'keyFilename', label: 'Service account key path', placeholder: '/path/to/key.json' },
      { key: 'location', label: 'Location (optional)', placeholder: 'US' },
    ],
  },
  {
    type: 'snowflake',
    label: 'Snowflake',
    description: 'Cloud data platform',
    fields: [
      { key: 'account', label: 'Account', placeholder: 'myorg-myaccount' },
      { key: 'username', label: 'Username', placeholder: 'MYUSER' },
      { key: 'password', label: 'Password', sensitive: true },
      { key: 'database', label: 'Database', placeholder: 'ANALYTICS' },
      { key: 'schema', label: 'Schema', placeholder: 'PUBLIC' },
    ],
  },
  {
    type: 'postgres',
    label: 'PostgreSQL',
    description: 'Relational database',
    fields: [
      { key: 'host', label: 'Host', placeholder: 'localhost' },
      { key: 'port', label: 'Port', placeholder: '5432' },
      { key: 'database', label: 'Database', placeholder: 'mydb' },
      { key: 'user', label: 'Username', placeholder: 'postgres' },
      { key: 'password', label: 'Password', sensitive: true },
    ],
  },
  {
    type: 'duckdb',
    label: 'DuckDB',
    description: 'Local analytics database',
    fields: [{ key: 'path', label: 'File path', placeholder: './pipeline.duckdb' }],
  },
  {
    type: 's3',
    label: 'S3',
    description: 'AWS object storage',
    fields: [
      { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket' },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access key ID' },
      { key: 'secretAccessKey', label: 'Secret access key', sensitive: true },
    ],
  },
  {
    type: 'gcs',
    label: 'GCS',
    description: 'Google Cloud Storage',
    fields: [
      { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket' },
      { key: 'keyFilename', label: 'Service account key path', placeholder: '/path/to/key.json' },
    ],
  },
];

function sensitiveKeysFor(type: ConnectionType): Set<string> {
  const definition = CONNECTION_TYPES.find((t) => t.type === type);
  return new Set(
    definition?.fields.filter((field) => field.sensitive).map((field) => field.key) ?? []
  );
}

function splitConfig(
  type: ConnectionType,
  config: Record<string, string>
): { nonSensitive: Record<string, string>; sensitive: Record<string, string> } {
  const sensitiveKeys = sensitiveKeysFor(type);
  const nonSensitive: Record<string, string> = {};
  const sensitive: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (sensitiveKeys.has(key)) sensitive[key] = value;
    else nonSensitive[key] = value;
  }
  return { nonSensitive, sensitive };
}

interface LoadResult {
  connections: Connection[];
  missingSecretIds: Set<string>;
}

function loadConnections(): LoadResult {
  if (typeof window === 'undefined') {
    return { connections: [], missingSecretIds: new Set() };
  }

  let persisted: Connection[] = [];
  try {
    const raw = window.localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        persisted = parsed.filter(
          (item): item is Connection =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Connection).id === 'string' &&
            typeof (item as Connection).type === 'string' &&
            typeof (item as Connection).name === 'string'
        );
      }
    }
  } catch {
    // Ignore parse failures — start from empty.
  }

  let secretsById: Record<string, Record<string, string>> = {};
  try {
    const rawSecrets = window.sessionStorage.getItem(SECRETS_STORAGE_KEY);
    if (rawSecrets) {
      const parsed = JSON.parse(rawSecrets) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        secretsById = parsed as Record<string, Record<string, string>>;
      }
    }
  } catch {
    // Ignore secret-load failures.
  }

  const missingSecretIds = new Set<string>();
  const connections = persisted.map((conn) => {
    const sensitiveKeys = sensitiveKeysFor(conn.type);
    if (sensitiveKeys.size === 0) return conn;
    const secrets = secretsById[conn.id] ?? {};
    const anyMissing = [...sensitiveKeys].some((key) => !secrets[key]);
    if (anyMissing) missingSecretIds.add(conn.id);
    return { ...conn, config: { ...conn.config, ...secrets } };
  });

  return { connections, missingSecretIds };
}

function persistConnections(
  connections: Connection[]
): { ok: true } | { ok: false; error: string } {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'Storage is not available in this environment.' };
  }

  const sanitized: Connection[] = [];
  const secretsById: Record<string, Record<string, string>> = {};
  for (const conn of connections) {
    const { nonSensitive, sensitive } = splitConfig(conn.type, conn.config);
    sanitized.push({ ...conn, config: nonSensitive });
    if (Object.keys(sensitive).length > 0) secretsById[conn.id] = sensitive;
  }

  try {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(sanitized));
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === 'QuotaExceededError'
        ? 'Browser storage quota exceeded — remove an existing connection and try again.'
        : `Failed to save connection to browser storage: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, error: message };
  }

  try {
    window.sessionStorage.setItem(SECRETS_STORAGE_KEY, JSON.stringify(secretsById));
  } catch {
    // Session storage failures are recoverable — secrets stay in memory for this session.
  }

  return { ok: true };
}

function generateId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

interface TestState {
  ok: boolean;
  message: string;
  testing?: boolean;
  untested?: boolean;
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [missingSecretIds, setMissingSecretIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [selectedType, setSelectedType] = useState<ConnectionType>('bigquery');
  const [formName, setFormName] = useState('');
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useState<Record<string, TestState>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const { connections: loaded, missingSecretIds: missing } = loadConnections();
    setConnections(loaded);
    setMissingSecretIds(missing);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function resetForm() {
    setShowForm(false);
    setFormName('');
    setFormConfig({});
    setSelectedType('bigquery');
  }

  function persist(next: Connection[]): boolean {
    const outcome = persistConnections(next);
    if (!outcome.ok) {
      setSaveError(outcome.error);
      return false;
    }
    setSaveError(null);
    return true;
  }

  function handleSave() {
    if (!formName.trim()) return;
    const conn: Connection = {
      id: generateId(),
      type: selectedType,
      name: formName.trim(),
      createdAt: Date.now(),
      config: formConfig,
    };
    const next = [...connections, conn];
    if (!persist(next)) return;
    setConnections(next);
    setMissingSecretIds((prev) => {
      if (!prev.has(conn.id)) return prev;
      const copy = new Set(prev);
      copy.delete(conn.id);
      return copy;
    });
    resetForm();
  }

  function handleDelete(id: string) {
    const next = connections.filter((c) => c.id !== id);
    if (!persist(next)) return;
    setConnections(next);
    setTestStatus((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    setMissingSecretIds((prev) => {
      if (!prev.has(id)) return prev;
      const copy = new Set(prev);
      copy.delete(id);
      return copy;
    });
  }

  async function handleTest(conn: Connection) {
    setTestStatus((prev) => ({
      ...prev,
      [conn.id]: { ok: false, message: 'Testing…', testing: true },
    }));
    try {
      const res = await explorerFetch('/api/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: conn.type, config: conn.config }),
      });
      const data = (await res.json()) as { ok: boolean; message: string; untested?: boolean };
      if (!mountedRef.current) return;
      setTestStatus((prev) => ({
        ...prev,
        [conn.id]: { ok: data.ok, message: data.message, untested: data.untested },
      }));
    } catch {
      if (!mountedRef.current) return;
      setTestStatus((prev) => ({
        ...prev,
        [conn.id]: { ok: false, message: 'Request failed — check server logs.' },
      }));
    }
  }

  const typeDefinition = CONNECTION_TYPES.find((t) => t.type === selectedType);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <PageHeader
        breadcrumbs={[{ label: 'Dogsled', href: '/' }, { label: 'Connections' }]}
        title="Connections"
        description="Manage credentials for pipeline destinations. Saved connections can be reused in the pipeline wizard."
        actions={
          !showForm ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Add connection
            </button>
          ) : null
        }
      />

      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-200">
        Secrets (passwords, access keys) are kept only for this browser session and are not written
        to local storage. Close or reload this tab and you&apos;ll be prompted to re-enter them.
      </div>

      {saveError && (
        <div className="rounded-2xl border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
          {saveError}
        </div>
      )}

      {showForm && (
        <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">New Connection</h2>

          <div>
            <label className="text-[10px] text-muted-foreground">Connection name</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="My BigQuery warehouse"
              className="mt-1 w-full max-w-sm rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground">Type</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {CONNECTION_TYPES.map((ct) => (
                <button
                  key={ct.type}
                  type="button"
                  onClick={() => {
                    setSelectedType(ct.type);
                    setFormConfig({});
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    selectedType === ct.type
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                >
                  {ct.label}
                </button>
              ))}
            </div>
          </div>

          {typeDefinition && (
            <div className="grid gap-3 sm:grid-cols-2">
              {typeDefinition.fields.map((field) => (
                <div key={field.key}>
                  <label className="text-[10px] text-muted-foreground">{field.label}</label>
                  <input
                    type={field.sensitive ? 'password' : 'text'}
                    value={formConfig[field.key] ?? ''}
                    onChange={(e) =>
                      setFormConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    className="mt-1 w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!formName.trim()}
              className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save connection
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {connections.length === 0 && !showForm ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card py-16 text-center">
          <div className="text-sm text-muted-foreground">No connections saved yet.</div>
          <p className="text-xs text-muted-foreground max-w-sm">
            Add a connection to store credentials for BigQuery, Snowflake, or other destinations.
            Connections can be reused in the pipeline wizard.
          </p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Add your first connection
          </button>
        </div>
      ) : null}

      {connections.length > 0 && (
        <div className="space-y-3">
          {connections.map((conn) => {
            const typeDef = CONNECTION_TYPES.find((t) => t.type === conn.type);
            const status = testStatus[conn.id];
            const isMissingSecrets = missingSecretIds.has(conn.id);
            return (
              <div key={conn.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{conn.name}</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        {typeDef?.label ?? conn.type}
                      </span>
                      {isMissingSecrets && (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                          Re-enter credentials
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Added {new Date(conn.createdAt).toLocaleDateString()}
                    </div>
                    {status && (
                      <div
                        className={`mt-2 text-xs font-medium ${
                          status.untested
                            ? 'text-muted-foreground'
                            : status.ok
                              ? 'text-accent'
                              : 'text-destructive'
                        }`}
                      >
                        {status.testing ? '⟳ ' : status.untested ? '' : status.ok ? '✓ ' : '✕ '}
                        {status.message}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => void handleTest(conn)}
                      disabled={status?.testing || isMissingSecrets}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(conn.id)}
                      className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
