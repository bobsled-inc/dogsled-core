import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import { compileShopModel, listShopModelFiles, readShopModelYaml } from '@/lib/shop-demo-workspace';
import yaml from 'yaml';

export const dynamic = 'force-dynamic';

// ---- lightweight SQL formatter -----------------------------------------------

function splitAtDepth0(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0 && text.startsWith(delimiter, i)) {
      parts.push(current.trim());
      current = '';
      i += delimiter.length;
      continue;
    }
    current += text[i++];
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function formatSqlBlock(block: string): string {
  // Each compiled block: comment lines + CREATE + SELECT...FROM line + );
  const lines = block.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('SELECT ')) {
      result.push(line);
      continue;
    }

    // Separate SELECT columns from FROM onward
    const selectBody = trimmed.slice('SELECT '.length);

    // Find FROM at depth 0
    let depth = 0;
    let fromIdx = -1;
    for (let i = 0; i < selectBody.length; i++) {
      if (selectBody[i] === '(') depth++;
      else if (selectBody[i] === ')') depth--;
      if (depth === 0 && selectBody.startsWith(' FROM ', i)) {
        fromIdx = i;
        break;
      }
    }

    if (fromIdx === -1) {
      result.push(line);
      continue;
    }

    const columnsPart = selectBody.slice(0, fromIdx);
    const fromPart = selectBody.slice(fromIdx + 1); // trim leading space

    const cols = splitAtDepth0(columnsPart, ', ');
    result.push('SELECT');
    result.push(cols.map((c) => `  ${c}`).join(',\n'));

    // Break FROM, LEFT JOIN, GROUP BY, WHERE at depth 0
    let rest = fromPart;
    const keywords = [
      'LEFT JOIN ',
      'INNER JOIN ',
      'RIGHT JOIN ',
      'GROUP BY ',
      'WHERE ',
      'ORDER BY ',
      'HAVING ',
    ];
    let formatted = '';
    let remaining = rest;
    while (remaining.length > 0) {
      let nextKeywordIdx = -1;
      let nextKeyword = '';
      for (const kw of keywords) {
        depth = 0;
        for (let i = 0; i < remaining.length - kw.length; i++) {
          if (remaining[i] === '(') depth++;
          else if (remaining[i] === ')') depth--;
          if (depth === 0 && remaining.startsWith(kw, i)) {
            if (nextKeywordIdx === -1 || i < nextKeywordIdx) {
              nextKeywordIdx = i;
              nextKeyword = kw;
            }
            break;
          }
        }
      }
      if (nextKeywordIdx === -1) {
        formatted += remaining;
        break;
      }
      formatted += remaining.slice(0, nextKeywordIdx) + '\n' + nextKeyword;
      remaining = remaining.slice(nextKeywordIdx + nextKeyword.length);
    }
    result.push(formatted);
  }

  return result.join('\n');
}

function formatModelSpecSql(raw: string, modelName: string): string {
  const blocks = raw.split(/\n(?=-- )/).map((b) => b.trim());
  const viewPattern = `"main"."${modelName}"`;
  const target = blocks.find((b) => b.includes(viewPattern)) ?? blocks[blocks.length - 1] ?? raw;
  return formatSqlBlock(target);
}

// ---- column metadata extraction ----------------------------------------------

interface ColumnRow {
  name: string;
  expr: string;
  semantic_role?: string;
  primary_key?: boolean;
  pii?: boolean;
  unit?: string;
  format?: string;
  embedding_candidate?: boolean;
  references?: string;
}

interface ExpectRow {
  kind: string;
  columns?: string[];
  column?: string;
  values?: string[];
}

interface ModelDoc {
  columns?: ColumnRow[];
  expect?: ExpectRow[];
}

function extractColumns(yamlText: string): ColumnRow[] {
  try {
    const doc = yaml.parse(yamlText) as ModelDoc;
    return doc.columns ?? [];
  } catch (e) {
    console.error('Failed to parse model YAML for columns:', e);
    return [];
  }
}

function extractContracts(yamlText: string): ExpectRow[] {
  try {
    const doc = yaml.parse(yamlText) as ModelDoc;
    return doc.expect ?? [];
  } catch (e) {
    console.error('Failed to parse model YAML for contracts:', e);
    return [];
  }
}

// ---- model name normalization ------------------------------------------------

function safeModel(value: string | undefined, models: string[]): string {
  const names = models.map((file) => file.replace(/\.yml$/, ''));
  return names.includes(value ?? '') ? value! : (names[0] ?? 'stg_customers');
}

// ---- page -------------------------------------------------------------------

export default async function ShopDemoModelsPage({
  searchParams,
}: {
  searchParams?: Promise<{ model?: string }>;
}) {
  const params = await searchParams;
  const files = await listShopModelFiles();
  const selected = safeModel(params?.model, files);
  const yamlText = await readShopModelYaml(`${selected}.yml`);
  const rawSql = await compileShopModel(selected);
  const formattedSql = formatModelSpecSql(rawSql, selected);
  const columns = extractColumns(yamlText);
  const contracts = extractContracts(yamlText);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Models' },
        ]}
        title="Shop Models"
        description="Inspect column metadata, the model YAML, and the SQL Model Spec compiles for DuckDB."
        actions={
          <Link
            href="/demo/shop/lineage"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            View Lineage
          </Link>
        }
      />

      <section className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Model nav */}
        <nav className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2">
          {files.map((file) => {
            const name = file.replace(/\.yml$/, '');
            return (
              <Link
                key={file}
                href={`/demo/shop/models?model=${encodeURIComponent(name)}`}
                className={`rounded-md px-3 py-2 text-xs ${
                  name === selected
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {name}
              </Link>
            );
          })}
        </nav>

        {/* Model detail */}
        <div className="flex flex-col gap-5">
          {/* Columns table */}
          {columns.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Columns</h2>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">name</th>
                      <th className="px-3 py-2 font-medium">expression</th>
                      <th className="px-3 py-2 font-medium">semantic_role</th>
                      <th className="px-3 py-2 font-medium">flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((col, i) => {
                      const flags: string[] = [];
                      if (col.primary_key) flags.push('pk');
                      if (col.pii) flags.push('pii');
                      if (col.embedding_candidate) flags.push('embed');
                      if (col.unit) flags.push(col.unit);
                      if (col.format) flags.push(col.format);
                      return (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-2 font-mono font-medium">{col.name}</td>
                          <td
                            className="px-3 py-2 font-mono text-muted-foreground max-w-xs truncate"
                            title={col.expr}
                          >
                            {col.expr}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {col.semantic_role ?? ''}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {flags.map((f) => (
                                <span
                                  key={f}
                                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* YAML + SQL */}
          <div className="grid gap-4 xl:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold">YAML</h2>
              <SyntaxBlock code={yamlText} language="yaml" className="max-h-[560px]" />
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold">Compiled SQL</h2>
              <SyntaxBlock code={formattedSql} language="sql" className="max-h-[560px]" />
            </div>
          </div>

          {/* Contracts */}
          {contracts.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Contracts</h2>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">kind</th>
                      <th className="px-3 py-2 font-medium">column(s)</th>
                      <th className="px-3 py-2 font-medium">constraint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contracts.map((c, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-2 font-mono">{c.kind}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">
                          {c.columns ? c.columns.join(', ') : (c.column ?? '—')}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {c.values ? c.values.join(', ') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* CLI */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">CLI</h2>
            <div className="flex flex-col gap-3 text-xs">
              <div>
                <p className="mb-1 text-muted-foreground">
                  Compile this model to see the SQL Model Spec generates for DuckDB:
                </p>
                <SyntaxBlock
                  code={`dogsled model compile ${selected} --integration duckdb`}
                  language="bash"
                />
              </div>
              <div>
                <p className="mb-1 text-muted-foreground">
                  Run all contract checks (primary key, accepted values, row counts) against the
                  live database:
                </p>
                <SyntaxBlock code={`dogsled model validate --integration duckdb`} language="bash" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
