import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';

export const dynamic = 'force-static';

const FEATURES = [
  [
    'Locked public schemas',
    '`__entity_profile`, `__entity_relationship`, `__document_mentions`, and SDK IR v1.0 are published as stable contracts. Additive columns are minor; renames or deletions are major.',
  ],
  [
    'Cross-source entity resolution',
    '`bobsled entity-graph resolve` materializes canonical entity tables with declared (not inferred) relationships, no orphan edges, and per-row quality columns.',
  ],
  [
    'Unstructured ↔ structured linking',
    'Two-stage mention extraction — per-dialect candidate lookup, constrained LLM disambiguation, compromise NER fallback — writes `__document_mentions` rows that link chunks to resolved entities.',
  ],
  [
    'Review queue export',
    '`bobsled entity-graph mentions review export` reuses the existing `model review export` envelope — same CSV columns, same `--json` / `--yaml` outputs, mention columns appended.',
  ],
  [
    'Typed SDK codegen',
    '`bobsled sdk generate --lang ts` emits a `tsc --noEmit`-clean SDK with branded IDs, strict per-entity filter shapes, an `EntityQueryBuilder`, and a `createBobsledClient()` factory.',
  ],
  [
    'Executor-backed runtime',
    'Generated SDKs do not embed a database driver. The consumer passes a `BobsledEntityExecutor` so the SDK stays pure transformation and app code owns execution context.',
  ],
] as const;

const STEPS: ReadonlyArray<{
  step: string;
  title: string;
  description: string;
  code: string | null;
  language: 'bash' | 'plaintext';
  href: string | null;
}> = [
  {
    step: '1',
    title: 'Validate the resolution specs',
    description:
      'Offline schema check before any data plane work. Verifies entity, relationship, and survivorship specs in `entity-graph/`.',
    code: 'bobsled entity-graph resolve validate customer deal document --json',
    language: 'bash',
    href: null,
  },
  {
    step: '2',
    title: 'Resolve, cluster, and profile',
    description:
      'Three-step pipeline that materializes `__entity_profile`, `__entity_relationship`, and per-entity quality views. The runner module is local DuckDB by default, no warehouse credentials required.',
    code: [
      'bobsled entity-graph resolve run customer deal document \\',
      '  --runner ./runner.js --json',
      'bobsled entity-graph resolve cluster customer deal document \\',
      '  --runner ./runner.js --json',
      'bobsled entity-graph resolve profile customer deal document \\',
      '  --runner ./runner.js --json',
    ].join('\n'),
    language: 'bash',
    href: null,
  },
  {
    step: '3',
    title: 'Export the mention review queue',
    description:
      'CSV envelope-parity with `model review export`. Rows that need attention by default; pass `--all` for auto-merges. Auto-resolves to JSON in CI / non-TTY.',
    code: [
      'bobsled entity-graph mentions review export \\',
      '  --runner ./runner.js \\',
      '  --schema entity_graph \\',
      '  --csv \\',
      '  > ./review/document_mentions.csv',
    ].join('\n'),
    language: 'bash',
    href: null,
  },
  {
    step: '4',
    title: 'Generate the typed SDK',
    description:
      'Reads the IR via `inventoryEntityGraph()`, emits branded IDs + `Profile` interfaces + `FindFilter` shapes + `EntityQueryBuilder` + `createBobsledClient()` into the consumer repo.',
    code: 'bobsled sdk generate --lang ts --out ./generated/bobsled-sdk --json',
    language: 'bash',
    href: null,
  },
  {
    step: '5',
    title: 'Wire the executor and query',
    description:
      'Provide a `BobsledEntityExecutor` (one `find(request)` function) and call the typed surface. The executor can bridge to Bobsled Core MCP `readSource`, a warehouse runner, or an app API.',
    code: null,
    language: 'plaintext',
    href: null,
  },
  {
    step: '6',
    title: 'Walk the curriculum',
    description:
      'Open the learn module on the Learn surface for a step-by-step walkthrough with linked CLI commands and concept callouts.',
    code: null,
    language: 'plaintext',
    href: '/learn/entity-graph-sdk',
  },
] as const;

const APP_CODE = `import { createBobsledClient, type BobsledEntityExecutor } from './generated/bobsled-sdk';

const executor: BobsledEntityExecutor = {
  async find(request) {
    // Bridge to Bobsled Core MCP readSource, a warehouse runner, or an app API.
    return queryBobsledEntityGraph(request);
  },
};

const bobsled = createBobsledClient(executor);

const acme = await bobsled.entity.customer
  .findBy({ domain: 'acme.com' })
  .withDocuments()
  .withRelationship('customer_has_deal')
  .first();

if (acme) {
  renderAccountPage({
    customer: acme.profile,
    documents: acme.documents,
    quality: acme.profile._quality,
  });
}`;

const REVIEW_CSV = `review_id,decision,confidence,mention_id,chunk_id,document_id,entity_type,entity_name,resolved_entity_id,resolution_method,notes
m_001,agent_review,0.72,m_001,c_001,d_001,company,Acme,customer_123,llm_disambiguation,"{""review_route"":""agent_review""}"`;

const GUIDES = [
  {
    href: '/docs?path=guides/entity-graph',
    label: 'Entity Graph: Cross-Source Resolution and the Typed SDK',
    description: 'Full walkthrough — public schemas, commands, and app wiring.',
  },
  {
    href: '/docs?path=guides/mention-extraction',
    label: 'Mention Extraction',
    description: 'Two-stage pipeline that links unstructured chunks to resolved entities.',
  },
  {
    href: '/docs?path=guides/sdk-codegen',
    label: 'SDK Codegen',
    description: 'IR contract, emitter outputs, and the executor handoff.',
  },
  {
    href: '/docs?path=guides/mcp-read-source',
    label: 'MCP `read_source`',
    description: 'Agent-native, fail-closed document and chunk reads with citations.',
  },
];

export default function EntityGraphSdkDemoOverviewPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Bobsled Core', href: '/' },
          { label: 'Demo' },
          { label: 'Entity Graph + Typed SDK' },
        ]}
        title="Entity Graph: Cross-Source Resolution and the Typed SDK"
        description="Resolve entities across sources, link them to document mentions, and generate a typed TypeScript SDK that app code can call against the entity graph."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/learn/entity-graph-sdk"
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              Open Learn Module
            </Link>
            <Link
              href="/docs?path=guides/entity-graph"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Read the Guide
            </Link>
          </div>
        }
      />

      <section className="grid gap-3 md:grid-cols-3">
        {FEATURES.map(([title, description]) => (
          <div key={title} className="rounded-lg border border-border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold">End-to-end walkthrough</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(({ step, title, description, code, language, href }) => (
            <div
              key={step}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                  {step}
                </span>
                <span className="text-sm font-medium">{title}</span>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{description}</p>
              {code && (
                <SyntaxBlock code={code} language={language} className="max-h-36 text-[11px]" />
              )}
              {href && (
                <Link
                  href={href}
                  className="mt-auto inline-flex items-center text-xs text-primary hover:underline"
                >
                  Open →
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">App code calls the typed surface</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Generated SDKs ship without a database driver. App code provides a{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">
              BobsledEntityExecutor
            </code>
            and calls <code className="rounded bg-muted px-1 font-mono text-[12px]">findBy()</code>,{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">withDocuments()</code>,{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">withRelationship()</code>,
            and <code className="rounded bg-muted px-1 font-mono text-[12px]">first()</code>. Every
            profile carries{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">_quality</code> so callers
            can branch on confidence, freshness, and source diversity.
          </p>
          <div className="mt-3">
            <SyntaxBlock code={APP_CODE} language="plaintext" className="max-h-[420px]" />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Mention review export envelope</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The CSV reuses the standard{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">model review export</code>{' '}
            envelope columns (
            <code className="rounded bg-muted px-1 font-mono text-[12px]">review_id</code>,{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">decision</code>,{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">confidence</code>) and
            appends mention-specific columns after them. Agents should prefer{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">--json</code> or{' '}
            <code className="rounded bg-muted px-1 font-mono text-[12px]">--yaml</code> when
            consuming the queue programmatically.
          </p>
          <div className="mt-3">
            <SyntaxBlock code={REVIEW_CSV} language="plaintext" className="max-h-[280px]" />
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold">Related guides</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {GUIDES.map(({ href, label, description }) => (
            <Link
              key={href}
              href={href}
              className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30 hover:bg-background/70"
            >
              <div className="text-sm font-semibold">{label}</div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
              <div className="mt-2 text-xs font-medium text-primary">Read →</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
