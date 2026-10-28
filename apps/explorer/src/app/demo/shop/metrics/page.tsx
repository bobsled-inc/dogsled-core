import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import {
  isShopDemoReady,
  listShopMetricFiles,
  readShopMetricYaml,
} from '@/lib/shop-demo-workspace';
import yaml from 'yaml';

export const dynamic = 'force-dynamic';

interface MetricSummary {
  name: string;
  description: string;
  expression: string;
  model: string;
  yamlSource: string;
}

export default async function ShopDemoMetricsPage() {
  const ready = isShopDemoReady();
  const files = await listShopMetricFiles();

  const metrics: MetricSummary[] = await Promise.all(
    files.map(async (file) => {
      const yamlSource = await readShopMetricYaml(file);
      const parsed = yaml.parse(yamlSource) as {
        name?: string;
        description?: string;
        expression?: string;
        model?: string;
      };
      if (!parsed.name || !parsed.expression || !parsed.model) {
        console.error(`Metric file ${file} is missing required fields`);
      }
      return {
        name: parsed.name ?? file,
        description: parsed.description ?? '',
        expression: parsed.expression ?? '',
        model: parsed.model ?? '',
        yamlSource,
      };
    })
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Metrics' },
        ]}
        title="Shop Metrics"
        description="Semantic metric definitions that make the project agent-readable and BI-tool-ready."
      />

      {!ready && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Build the demo database first.{' '}
          <Link href="/demo/shop" className="underline underline-offset-2">
            See the overview
          </Link>{' '}
          for instructions.
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4 text-xs">
        <p className="mb-1 font-semibold">What metrics enable</p>
        <p className="text-muted-foreground">
          Each metric is a named, versioned formula attached to a model. An agent answering
          &ldquo;what was our average order value last month?&rdquo; resolves{' '}
          <code className="font-mono">avg_order_value</code> to its expression and model, then
          applies a time filter — without writing SQL from scratch. The{' '}
          <code className="font-mono">synonyms</code> list lets agents match casual phrasing like
          &ldquo;aov&rdquo; or &ldquo;revenue&rdquo; to the canonical definition.
        </p>
      </div>

      <div className="grid gap-4">
        {metrics.map((m) => (
          <div key={m.name} className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <div className="font-semibold">{m.name}</div>
              <p className="mt-0.5 text-sm text-muted-foreground">{m.description}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground/60">
                {m.expression} — from {m.model}
              </p>
            </div>
            <div className="p-4">
              <SyntaxBlock code={m.yamlSource} language="yaml" className="max-h-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
