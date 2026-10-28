import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import { listShopRelationshipFiles, readShopRelationshipYaml } from '@/lib/shop-demo-workspace';
import yaml from 'yaml';

export const dynamic = 'force-dynamic';

interface RelationshipDoc {
  name: string;
  left_model: string;
  right_model: string;
  join_columns: { left: string; right: string }[];
  relationship_type: string;
}

function parseRelationship(yamlText: string): RelationshipDoc | null {
  try {
    return yaml.parse(yamlText) as RelationshipDoc;
  } catch {
    return null;
  }
}

function RelTypeLabel({ type }: { type: string }) {
  const display =
    type === 'many_to_one'
      ? 'many → one'
      : type === 'one_to_many'
        ? 'one → many'
        : type === 'one_to_one'
          ? 'one → one'
          : type === 'many_to_many'
            ? 'many → many'
            : type;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
      {display}
    </span>
  );
}

export default async function ShopRelationshipsPage() {
  const files = await listShopRelationshipFiles();
  const rels = await Promise.all(
    files.map(async (f) => {
      const text = await readShopRelationshipYaml(f);
      return { text, doc: parseRelationship(text) };
    })
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Relationships' },
        ]}
        title="Shop Relationships"
        description="Named joins between models that BI tools and agents use for automatic query construction."
      />

      <div className="rounded-lg border border-border bg-card p-4 text-xs">
        <p className="mb-1 font-semibold">What relationships enable</p>
        <p className="text-muted-foreground">
          A relationship declares a named, typed join between two models. BI tools and agents use
          these to construct multi-table queries automatically — no hand-written JOIN clauses
          needed. The <code className="font-mono">relationship_type</code> (many-to-one,
          one-to-many, etc.) tells the query engine which side is the grain and prevents fan-out on
          aggregations.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {rels.map(({ text, doc }, i) => (
          <div key={i} className="rounded-lg border border-border bg-card">
            {doc && (
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <span className="font-mono text-sm font-semibold">{doc.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{doc.left_model}</span>
                  <span>→</span>
                  <span className="font-mono">{doc.right_model}</span>
                </span>
                <RelTypeLabel type={doc.relationship_type} />
                <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  {(doc.join_columns ?? []).map((jc, j) => (
                    <span key={j} className="font-mono">
                      {j > 0 && ', '}
                      {jc.left} = {jc.right}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="p-4">
              <SyntaxBlock code={text} language="yaml" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
