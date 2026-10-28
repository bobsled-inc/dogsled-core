'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { LoadingSkeleton } from '@/components/ui/loading-skeleton';
import { PageHeader } from '@/components/ui/page-header';

interface ModelPackageSummary {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  resourceCount: number;
  stagingCount: number;
  martCount: number;
  totalFiles: number;
}

function ModelsLoadingState() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="rounded-2xl border border-border bg-card p-4">
          <LoadingSkeleton className="h-4 w-40" />
          <LoadingSkeleton className="mt-2 h-3 w-full" />
          <LoadingSkeleton className="mt-1 h-3 w-3/4" />
          <div className="mt-4 flex gap-2">
            <LoadingSkeleton className="h-5 w-16 rounded-full" />
            <LoadingSkeleton className="h-5 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ModelsPage() {
  const [packages, setPackages] = useState<ModelPackageSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/models')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load models');
        return response.json();
      })
      .then((data: { packages: ModelPackageSummary[] }) => {
        setPackages(data.packages);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  const filtered = search
    ? packages.filter(
        (pkg) =>
          pkg.name.toLowerCase().includes(search.toLowerCase()) ||
          pkg.displayName.toLowerCase().includes(search.toLowerCase()) ||
          pkg.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()))
      )
    : packages;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Model Bundles"
        description={`Pre-built analytics models for ${packages.length} integrations, with DAG and file inspection built in.`}
      />

      <input
        type="text"
        placeholder="Search model bundles..."
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="w-64 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {loading ? (
        <ModelsLoadingState />
      ) : error ? (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4">
          <div className="text-xs text-destructive">{error}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((pkg) => (
            <Link
              key={pkg.name}
              href={`/models/${pkg.name}`}
              className="group rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
            >
              <div className="text-sm font-medium transition-colors group-hover:text-primary">
                {pkg.displayName}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                {pkg.description}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span>Sources: {pkg.resourceCount}</span>
                <span>Staging: {pkg.stagingCount}</span>
                <span>Marts: {pkg.martCount}</span>
                <span>Files: {pkg.totalFiles}</span>
              </div>

              {pkg.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {pkg.tags.slice(0, 3).map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
