import { type ResolutionSpec, type ResolutionThresholds } from '@/lib/entity-graph-design-spec';
import { previewStandardizeTransforms } from '@/lib/entity-graph-standardize-preview';

export interface OverviewStepProps {
  spec: ResolutionSpec;
  specName: string;
  workspaceHint: string;
}

export function sampleValueForField(field: string): string {
  const normalized = field.toLowerCase();
  if (normalized.includes('email')) return '  ALEX.READER+booking@Example.COM  ';
  if (normalized.includes('phone')) return '  +1 (202) 555-0199  ';
  if (normalized.includes('website')) return '  https://www.example.com/location  ';
  if (normalized.includes('store') || normalized.includes('location')) {
    return '  North Market Store  ';
  }
  if (normalized.includes('name')) return '  Alex  Reader  ';
  if (normalized.includes('status')) return '  Active Member  ';
  return `  ${field || 'source value'} Example  `;
}

interface OutcomeRecord {
  source: string;
  fields: Array<{ label: string; value: string; emphasize?: boolean }>;
}

interface OutcomeSample {
  band: 'auto_merge' | 'review' | 'auto_reject';
  title: string;
  rangeLabel: string;
  description: string;
  score: number;
  reason: string;
  recordA: OutcomeRecord;
  recordB: OutcomeRecord;
}

function formatThreshold(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatRange(low: number, high?: number): string {
  if (typeof high === 'number') {
    return `${low.toFixed(2)} – ${high.toFixed(2)}`;
  }
  return `≥ ${low.toFixed(2)}`;
}

// Review band is exclusive of the auto-merge threshold — that score belongs in
// the auto-merge card, not both. Render as "low – < high" so equal thresholds
// don't render a phantom review band either.
function formatReviewRange(low: number, high: number): string {
  return `${low.toFixed(2)} – < ${high.toFixed(2)}`;
}

function formatBelow(value: number): string {
  return `< ${value.toFixed(2)}`;
}

function buildOutcomeSamples(
  thresholds: ResolutionThresholds | undefined,
  entityType: 'customer' | 'location' | 'generic'
): OutcomeSample[] {
  const autoMerge = formatThreshold(thresholds?.auto_merge, 0.85);
  const review = formatThreshold(thresholds?.review, 0.65);
  const autoReject = formatThreshold(thresholds?.auto_reject, review);

  const autoMergeScore = Math.min(0.99, Math.max(autoMerge + 0.01, (1 + autoMerge) / 2));
  const reviewUpper = Math.max(review, autoMerge - 0.001);
  const reviewScore = review + (reviewUpper - review) / 2;
  const rejectUpper = Math.max(0, autoReject - 0.001);
  const rejectScore = rejectUpper / 2;

  if (entityType === 'location') {
    return [
      {
        band: 'auto_merge',
        title: 'Auto-merge',
        rangeLabel: formatRange(autoMerge),
        description: 'Strong evidence — collapse to one mastered location.',
        score: autoMergeScore,
        reason: 'Same website + phone + ZIP. Name variant only.',
        recordA: {
          source: 'shopify_locations',
          fields: [
            { label: 'name', value: 'Example Retail Jacksonville', emphasize: true },
            { label: 'website', value: 'retail.example.com/jax' },
            { label: 'phone', value: '+1 904 555 0142' },
            { label: 'zip', value: '32202' },
          ],
        },
        recordB: {
          source: 'pos_stores',
          fields: [
            { label: 'name', value: 'Example Retail — Jacksonville', emphasize: true },
            { label: 'website', value: 'retail.example.com/jax' },
            { label: 'phone', value: '+1 904 555 0142' },
            { label: 'zip', value: '32202' },
          ],
        },
      },
      {
        band: 'review',
        title: 'Needs review',
        rangeLabel: formatReviewRange(review, autoMerge),
        description: 'Ambiguous — agent drafts evidence, human decides.',
        score: reviewScore,
        reason: 'Names align, but website + ownership diverge.',
        recordA: {
          source: 'crm_accounts',
          fields: [
            { label: 'name', value: 'Example Retail New York' },
            { label: 'website', value: 'retail.example.com/ny', emphasize: true },
            { label: 'phone', value: '+1 212 555 0188' },
            { label: 'owner', value: 'Region East', emphasize: true },
          ],
        },
        recordB: {
          source: 'pos_stores',
          fields: [
            { label: 'name', value: 'Example Retail NYC Flagship' },
            { label: 'website', value: 'retail.example.org', emphasize: true },
            { label: 'phone', value: '+1 212 555 0188' },
            { label: 'owner', value: 'Flagship LLC', emphasize: true },
          ],
        },
      },
      {
        band: 'auto_reject',
        title: 'Auto-reject',
        rangeLabel: formatBelow(autoReject),
        description: 'Different stores — no review needed.',
        score: rejectScore,
        reason: 'Different phone, different ZIP, name overlap only.',
        recordA: {
          source: 'shopify_locations',
          fields: [
            { label: 'name', value: 'Example Retail Boston' },
            { label: 'website', value: 'retail.example.com/bos' },
            { label: 'phone', value: '+1 617 555 0101', emphasize: true },
            { label: 'zip', value: '02108', emphasize: true },
          ],
        },
        recordB: {
          source: 'pos_stores',
          fields: [
            { label: 'name', value: 'Example Retail Brooklyn' },
            { label: 'website', value: 'retail.example.com/bk' },
            { label: 'phone', value: '+1 718 555 0944', emphasize: true },
            { label: 'zip', value: '11201', emphasize: true },
          ],
        },
      },
    ];
  }

  // Default = customer-shaped examples (also used for generic).
  return [
    {
      band: 'auto_merge',
      title: 'Auto-merge',
      rangeLabel: formatRange(autoMerge),
      description: 'Strong evidence — collapse into one golden record.',
      score: autoMergeScore,
      reason: 'Same email + phone. Name spelling variant only.',
      recordA: {
        source: 'crm_contacts',
        fields: [
          { label: 'name', value: 'John Doe', emphasize: true },
          { label: 'email', value: 'john.doe@example.com' },
          { label: 'phone', value: '+1 415 555 0188' },
          { label: 'store', value: 'San Francisco' },
        ],
      },
      recordB: {
        source: 'pos_customers',
        fields: [
          { label: 'name', value: 'J. Doe', emphasize: true },
          { label: 'email', value: 'john.doe@example.com' },
          { label: 'phone', value: '+1 415 555 0188' },
          { label: 'store', value: 'San Francisco' },
        ],
      },
    },
    {
      band: 'review',
      title: 'Needs review',
      rangeLabel: formatReviewRange(review, autoMerge),
      description: 'Ambiguous — agent drafts evidence, human decides.',
      score: reviewScore,
      reason: 'Phone + store match, but email + nickname diverge.',
      recordA: {
        source: 'crm_contacts',
        fields: [
          { label: 'name', value: 'Jane Doe', emphasize: true },
          { label: 'email', value: 'jane.doe@example.com', emphasize: true },
          { label: 'phone', value: '+1 312 555 0177' },
          { label: 'store', value: 'Chicago' },
        ],
      },
      recordB: {
        source: 'booking_app',
        fields: [
          { label: 'name', value: 'Janie Doe', emphasize: true },
          { label: 'email', value: 'janie.doe@example.org', emphasize: true },
          { label: 'phone', value: '+1 312 555 0177' },
          { label: 'store', value: 'Chicago' },
        ],
      },
    },
    {
      band: 'auto_reject',
      title: 'Auto-reject',
      rangeLabel: formatBelow(autoReject),
      description: 'Different people — no review needed.',
      score: rejectScore,
      reason: 'Same store, but email + phone + name all diverge.',
      recordA: {
        source: 'crm_contacts',
        fields: [
          { label: 'name', value: 'Alex Doe', emphasize: true },
          { label: 'email', value: 'alex.doe@example.com', emphasize: true },
          { label: 'phone', value: '+1 646 555 0119', emphasize: true },
          { label: 'store', value: 'New York' },
        ],
      },
      recordB: {
        source: 'pos_customers',
        fields: [
          { label: 'name', value: 'Sam Roe', emphasize: true },
          { label: 'email', value: 'sam.roe@example.org', emphasize: true },
          { label: 'phone', value: '+1 917 555 0155', emphasize: true },
          { label: 'store', value: 'New York' },
        ],
      },
    },
  ];
}

interface OutcomeBandStyle {
  card: string;
  header: string;
  pill: string;
  score: string;
}

const BAND_STYLES: Record<OutcomeSample['band'], OutcomeBandStyle> = {
  auto_merge: {
    card: 'border-emerald-500/40 bg-emerald-500/5',
    header: 'text-emerald-700 dark:text-emerald-300',
    pill: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    score: 'text-emerald-700 dark:text-emerald-300',
  },
  review: {
    card: 'border-amber-500/40 bg-amber-500/5',
    header: 'text-amber-700 dark:text-amber-300',
    pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    score: 'text-amber-700 dark:text-amber-300',
  },
  auto_reject: {
    card: 'border-red-500/40 bg-red-500/5',
    header: 'text-red-700 dark:text-red-300',
    pill: 'bg-red-500/15 text-red-600 dark:text-red-300',
    score: 'text-red-700 dark:text-red-300',
  },
};

function detectEntityType(
  spec: ResolutionSpec,
  specName: string
): 'customer' | 'location' | 'generic' {
  const haystack = `${spec.name ?? ''} ${specName} ${spec.type ?? ''}`.toLowerCase();
  if (haystack.includes('location') || haystack.includes('store') || haystack.includes('site')) {
    return 'location';
  }
  if (
    haystack.includes('customer') ||
    haystack.includes('person') ||
    haystack.includes('contact')
  ) {
    return 'customer';
  }
  return 'generic';
}

function OutcomeSampleCard({ sample }: { sample: OutcomeSample }) {
  const styles = BAND_STYLES[sample.band];
  return (
    <div className={`flex flex-col rounded-md border p-3 ${styles.card}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-sm font-semibold ${styles.header}`}>{sample.title}</div>
          <div
            className={`mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${styles.pill}`}
          >
            {sample.rangeLabel}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Score</div>
          <div className={`text-base font-semibold tabular-nums ${styles.score}`}>
            {sample.score.toFixed(2)}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{sample.description}</p>

      <div className="mt-3 space-y-2">
        <RecordCard label="A" record={sample.recordA} />
        <RecordCard label="B" record={sample.recordB} />
      </div>

      <div className="mt-3 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[11px] leading-snug">
        <span className="font-medium text-foreground">Why: </span>
        <span className="text-muted-foreground">{sample.reason}</span>
      </div>
    </div>
  );
}

function RecordCard({ label, record }: { label: string; record: OutcomeRecord }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-2">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Record {label}</span>
        <span className="truncate font-mono normal-case text-foreground">{record.source}</span>
      </div>
      <dl className="mt-1.5 space-y-0.5">
        {record.fields.map((field) => (
          <div
            key={field.label}
            className="grid grid-cols-[64px_1fr] gap-2 text-[11px] leading-snug"
          >
            <dt className="truncate text-muted-foreground">{field.label}</dt>
            <dd
              className={`truncate ${field.emphasize ? 'font-medium text-foreground' : 'text-foreground'}`}
              title={field.value}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function OverviewStep({ spec, specName, workspaceHint }: OverviewStepProps) {
  const entityLabel = spec.name ?? specName;
  const inputs = spec.inputs ?? [];
  const inputCount = inputs.length;
  const standardizeRules = spec.standardize ?? [];
  const blockingRules = spec.blocking?.rules ?? [];
  const scoringFeatures = spec.scoring?.features ?? [];
  const thresholds = spec.thresholds;
  const standardizeExamples = standardizeRules.slice(0, 4).map((rule) => {
    const input = sampleValueForField(rule.field);
    return {
      field: rule.field,
      input,
      preview: previewStandardizeTransforms(input, rule.transforms),
    };
  });
  const entityType = detectEntityType(spec, specName);
  const outcomeSamples = buildOutcomeSamples(thresholds, entityType);
  const sourceSummary = inputs.map((input) => input.ref).join(' + ');

  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Outcome preview</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {spec.description ??
            `Resolve ${entityLabel} records into a review queue, then sample agent review proposals for human decisions.`}
        </p>
      </div>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Sources</div>
          <div className="mt-1 text-sm font-semibold">{inputCount}</div>
          <div className="mt-1 break-words text-[11px] leading-snug text-muted-foreground">
            {sourceSummary || 'Add sources in the next step.'}
          </div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Clean fields
          </div>
          <div className="mt-1 text-sm font-semibold">{standardizeRules.length}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">before scoring</div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Score features
          </div>
          <div className="mt-1 text-sm font-semibold">{scoringFeatures.length}</div>
          <div className="mt-1 break-words text-[11px] leading-snug text-muted-foreground">
            weighted evidence · {workspaceHint || specName}
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            What will your spec do?
          </h3>
          <span className="text-[11px] text-muted-foreground">Sample pairs at each threshold</span>
        </div>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          {outcomeSamples.map((sample) => (
            <OutcomeSampleCard key={sample.band} sample={sample} />
          ))}
        </div>
      </section>

      {standardizeExamples.length > 0 && (
        <section>
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Standardization examples
          </h3>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {standardizeExamples.map((example, index) => (
              <div key={`standardize-${index}`} className="rounded-md border border-border p-3">
                <div className="mb-2 font-mono text-xs text-foreground">{example.field}</div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
                  <span className="truncate rounded bg-secondary/50 px-2 py-1 font-mono text-muted-foreground">
                    {example.input}
                  </span>
                  <span className="text-muted-foreground">{'->'}</span>
                  <span className="truncate rounded bg-primary/10 px-2 py-1 font-mono text-foreground">
                    {example.preview.output}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Blocking
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {blockingRules.length > 0 ? (
              blockingRules.slice(0, 5).map((rule, index) => (
                <span
                  key={`blocking-${index}`}
                  className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-300"
                >
                  {rule.name || 'unnamed'}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No blocking keys</span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Scoring
          </h3>
          <div className="mt-2 space-y-1.5">
            {scoringFeatures.slice(0, 4).map((feature, index) => (
              <div key={`scoring-${index}`} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono">{feature.field}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {(feature.weight ?? 0).toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.max(0, Math.min(1, feature.weight ?? 0)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Thresholds
          </h3>
          <div className="mt-2 space-y-1 text-xs">
            {[
              ['Auto merge', thresholds?.auto_merge],
              ['Review', thresholds?.review],
              ['Reject floor', thresholds?.auto_reject],
            ].map(([label, value]) => (
              <div key={label as string} className="flex items-center justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-mono tabular-nums">
                  {typeof value === 'number' ? value.toFixed(2) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
