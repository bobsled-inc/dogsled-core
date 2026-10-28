'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { buildTerminalHref } from '@/lib/command-links';
import { inferCodeLanguage } from '@/lib/code-highlighting';
import { buildModelGraph } from '@/lib/model-graph';
import { Badge } from '@/components/ui/badge';
import { LineageGraph } from '@/components/lineage-graph';
import { LoadingSkeleton } from '@/components/ui/loading-skeleton';
import { ModelDag } from '@/components/model-dag';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';

interface ColumnSpec {
  name: string;
  type?: string;
  description?: string;
  expr?: string;
  primary_key?: boolean;
  semantic_role?: string;
}

interface ModelSpec {
  name: string;
  type?: string;
  description?: string;
  materialization?: { type: string } | string;
  source_type?: string;
  connection?: string;
  columns?: ColumnSpec[] | Record<string, ColumnSpec>;
}

interface ModelFile {
  path: string;
  content: string;
  type: 'source' | 'staging' | 'mart' | 'package';
}

interface IntegrationRef {
  name: string;
  displayName: string;
  resourceCount: number;
}

interface ModelPackage {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  sourceSpecs: ModelSpec[];
  stagingSpecs: ModelSpec[];
  martSpecs: ModelSpec[];
  files: ModelFile[];
  integration?: IntegrationRef | null;
}

const EMPTY_MODEL_FILES: ModelFile[] = [];
const EMPTY_MODEL_SPECS: ModelSpec[] = [];

type TabKey = 'overview' | 'sources' | 'staging' | 'marts' | 'files' | 'lineage';

function getFileBadge(file: ModelFile): string {
  if (file.type === 'package') return 'PKG';
  const language = inferCodeLanguage(file.path);
  if (language === 'yaml') return 'YAML';
  if (language === 'sql') return 'SQL';
  return file.type.toUpperCase();
}

function getColumns(spec: ModelSpec): ColumnSpec[] {
  if (!spec.columns) return [];
  if (Array.isArray(spec.columns)) return spec.columns;
  return Object.entries(spec.columns).map(([name, column]) => ({
    name,
    ...(typeof column === 'object' ? column : {}),
  }));
}

function SpecCard({ spec, specType }: { spec: ModelSpec; specType: string }) {
  const [expanded, setExpanded] = useState(false);
  const columns = getColumns(spec);

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium">{spec.name}</span>
          {spec.materialization && (
            <Badge variant="primary">
              {typeof spec.materialization === 'string'
                ? spec.materialization
                : spec.materialization.type}
            </Badge>
          )}
          {spec.source_type && <Badge>{spec.source_type}</Badge>}
          {specType === 'mart' && <Badge variant="accent">mart</Badge>}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{columns.length} columns</span>
          <span>{expanded ? '−' : '+'}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border p-4">
          {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
          {spec.connection && (
            <div className="text-[10px]">
              <span className="text-muted-foreground">Connection:</span>{' '}
              <code className="rounded bg-secondary px-1 py-0.5">{spec.connection}</code>
            </div>
          )}

          {columns.length > 0 && (
            <div className="overflow-hidden rounded-2xl bg-secondary/50">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                      Column
                    </th>
                    <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                      Type
                    </th>
                    <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                      Key
                    </th>
                    <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {columns.map((column) => (
                    <tr key={column.name}>
                      <td className="px-3 py-1.5 font-mono text-[11px]">{column.name}</td>
                      <td className="px-3 py-1.5">
                        {column.type && <Badge variant="primary">{column.type}</Badge>}
                      </td>
                      <td className="px-3 py-1.5 text-[10px]">
                        {column.primary_key && <Badge variant="accent">PK</Badge>}
                        {column.semantic_role && <Badge>{column.semantic_role}</Badge>}
                      </td>
                      <td className="max-w-xs px-3 py-1.5 text-[10px] text-muted-foreground">
                        {column.expr ? (
                          <code className="rounded bg-secondary px-1 py-0.5">{column.expr}</code>
                        ) : (
                          (column.description ?? '')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelDetailLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <LoadingSkeleton className="h-3 w-28" />
      <LoadingSkeleton className="h-8 w-56" />
      <LoadingSkeleton className="h-5 w-full max-w-xl" />
      <LoadingSkeleton className="h-36 w-full rounded-3xl" />
      <LoadingSkeleton className="h-72 w-full rounded-3xl" />
    </div>
  );
}

export default function ModelDetailPage() {
  const params = useParams();
  const router = useRouter();
  const name = params.name as string;
  const [data, setData] = useState<ModelPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [selectedFile, setSelectedFile] = useState<ModelFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const requestedTab = searchParams.get('tab');
    if (
      requestedTab === 'overview' ||
      requestedTab === 'sources' ||
      requestedTab === 'staging' ||
      requestedTab === 'marts' ||
      requestedTab === 'files' ||
      requestedTab === 'lineage'
    ) {
      setActiveTab(requestedTab);
    }
  }, []);

  useEffect(() => {
    fetch(`/api/models/${name}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Model bundle "${name}" not found`);
        return response.json();
      })
      .then((detail: ModelPackage) => {
        setData(detail);
        setSelectedFile(detail.files[0] ?? null);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [name]);

  const files = data?.files ?? EMPTY_MODEL_FILES;
  const martSpecs = data?.martSpecs ?? EMPTY_MODEL_SPECS;
  const sourceSpecs = data?.sourceSpecs ?? EMPTY_MODEL_SPECS;
  const stagingSpecs = data?.stagingSpecs ?? EMPTY_MODEL_SPECS;
  const graph = useMemo(
    () =>
      buildModelGraph({
        files,
        marts: martSpecs,
        sources: sourceSpecs,
        staging: stagingSpecs,
      }),
    [files, martSpecs, sourceSpecs, stagingSpecs]
  );
  const copySelectedFile = () => {
    if (!selectedFile) return;
    void navigator.clipboard.writeText(selectedFile.content).catch(() => {});
  };

  if (loading) return <ModelDetailLoading />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader
          title="Model bundle not found"
          description={error ?? 'The requested model bundle could not be loaded.'}
          breadcrumbs={[{ label: 'Models', href: '/models' }, { label: 'Missing Bundle' }]}
        />
        <Link href="/models" className="text-sm text-primary hover:underline">
          Back to Models
        </Link>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'sources', label: 'Sources', count: data.sourceSpecs.length },
    { key: 'staging', label: 'Staging', count: data.stagingSpecs.length },
    { key: 'marts', label: 'Marts', count: data.martSpecs.length },
    { key: 'lineage', label: 'Lineage' },
    { key: 'files', label: 'Files', count: data.files.length },
  ];

  const dagFallback = (
    <div className="mt-4 grid gap-4 md:grid-cols-3">
      <div className="space-y-1">
        {data.sourceSpecs.map((spec) => (
          <div
            key={spec.name}
            className="truncate font-mono text-[10px] text-info"
            title={spec.name}
          >
            {spec.name}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        {data.stagingSpecs.map((spec) => (
          <div
            key={spec.name}
            className="truncate font-mono text-[10px] text-warning"
            title={spec.name}
          >
            {spec.name}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        {data.martSpecs.map((spec) => (
          <div
            key={spec.name}
            className="truncate font-mono text-[10px] text-accent"
            title={spec.name}
          >
            {spec.name}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={data.displayName}
        description={data.description}
        breadcrumbs={[{ label: 'Models', href: '/models' }, { label: data.displayName }]}
      />

      <div className="flex flex-wrap items-center gap-2">
        {data.tags.map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>

      {data.integration && (
        <Link
          href={`/integrations/${data.integration.name}`}
          className="flex items-center gap-3 rounded-[24px] border border-primary/20 bg-primary/10 p-4 transition-colors hover:bg-primary/15"
        >
          <div className="flex-1">
            <div className="text-sm font-medium text-primary">
              Data source integration: {data.integration.displayName}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {data.integration.resourceCount} extractable resources with schemas and auth setup.
            </div>
          </div>
          <span className="text-xs text-primary">Open →</span>
        </Link>
      )}

      <div className="rounded-[28px] border border-border bg-card p-4">
        <div className="mb-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Pipeline DAG
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-secondary p-3 text-center">
            <div className="text-lg font-semibold text-info">{data.sourceSpecs.length}</div>
            <div className="text-[10px] text-muted-foreground">Sources</div>
          </div>
          <div className="rounded-2xl bg-secondary p-3 text-center">
            <div className="text-lg font-semibold text-warning">{data.stagingSpecs.length}</div>
            <div className="text-[10px] text-muted-foreground">Staging</div>
          </div>
          <div className="rounded-2xl bg-secondary p-3 text-center">
            <div className="text-lg font-semibold text-accent">{data.martSpecs.length}</div>
            <div className="text-[10px] text-muted-foreground">Marts</div>
          </div>
        </div>

        <div className="mt-4">
          <ModelDag edges={graph.edges} nodes={graph.nodes} fallback={dagFallback} />
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`border-b-2 px-3 py-2 text-xs transition-colors ${
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.count !== undefined ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-[10px] text-muted-foreground">Total Specs</div>
            <div className="mt-2 text-2xl font-semibold">
              {data.sourceSpecs.length + data.stagingSpecs.length + data.martSpecs.length}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-[10px] text-muted-foreground">Total Files</div>
            <div className="mt-2 text-2xl font-semibold">{data.files.length}</div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-[10px] text-muted-foreground">Bundle Name</div>
            <div className="mt-2 font-mono text-sm">{data.name}</div>
          </div>
        </div>
      )}

      {(activeTab === 'sources' || activeTab === 'staging' || activeTab === 'marts') && (
        <div className="space-y-2">
          {(activeTab === 'sources'
            ? data.sourceSpecs
            : activeTab === 'staging'
              ? data.stagingSpecs
              : data.martSpecs
          ).map((spec) => (
            <SpecCard
              key={spec.name}
              spec={spec}
              specType={
                activeTab === 'marts' ? 'mart' : activeTab === 'staging' ? 'staging' : 'source'
              }
            />
          ))}
        </div>
      )}

      {activeTab === 'lineage' && (
        <LineageGraph
          edges={graph.edges}
          nodes={graph.nodes}
          onNodeSelect={(node) => {
            const targetFile = node.filePath
              ? data.files.find((file) => file.path === node.filePath)
              : null;
            if (targetFile) {
              setSelectedFile(targetFile);
              setActiveTab('files');
              return;
            }

            if (node.layer === 'source' && data.integration) {
              router.push(`/integrations/${data.integration.name}`);
            }
          }}
        />
      )}

      {activeTab === 'files' && (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-2xl border border-border bg-card">
            {data.files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedFile(file)}
                className={`block w-full px-3 py-2 text-left text-[10px] transition-colors ${
                  selectedFile?.path === file.path
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{file.path}</span>
                  <Badge variant="muted">{getFileBadge(file)}</Badge>
                </div>
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{selectedFile.path}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {getFileBadge(selectedFile)} file
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={copySelectedFile}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    Copy file
                  </button>
                </div>

                <SyntaxBlock
                  code={selectedFile.content}
                  language={inferCodeLanguage(selectedFile.path)}
                  className="max-h-[calc(100vh-200px)]"
                />
              </>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
                Select a file to view its contents.
              </div>
            )}
          </div>
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        {data.integration && (
          <Link
            href={`/integrations/${data.integration.name}`}
            className="rounded-[24px] border border-border bg-card p-4 transition-colors hover:border-primary/50"
          >
            <div className="text-sm font-medium">View the data source integration</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Compare the marts to the extraction layer that feeds them.
            </p>
          </Link>
        )}

        <Link
          href={buildTerminalHref({ command: 'model', args: ['run', '--help'] })}
          className="rounded-[24px] border border-border bg-card p-4 transition-colors hover:border-primary/50"
        >
          <div className="text-sm font-medium">Run models in terminal</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Jump into the CLI so you can move from bundle browsing to execution commands.
          </p>
        </Link>
      </section>
    </div>
  );
}
