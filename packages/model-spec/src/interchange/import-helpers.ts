import { identity } from './common.js';
import type { OssiePhysicalSchema } from './import-types.js';

export function normalizeSqlType(value: string): string {
  return value.trim().toUpperCase().replaceAll(/\s+/g, ' ');
}

export function physicalColumn(
  fieldName: string,
  schema: OssiePhysicalSchema
): { name: string; sqlType: string } | undefined | 'ambiguous' {
  const exact = schema.columns.filter((column) => column.name === fieldName);
  if (exact.length === 1) return exact[0];
  const folded = schema.dialect === 'snowflake' ? fieldName.toUpperCase() : fieldName.toLowerCase();
  const matches = schema.columns.filter((column) => {
    const name =
      schema.dialect === 'snowflake' ? column.name.toUpperCase() : column.name.toLowerCase();
    return name === folded;
  });
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

export function remapReferences(value: unknown, aliases: Record<string, string> | undefined): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && 'ref' in value && typeof value.ref === 'string') {
    const dot = value.ref.indexOf('.');
    if (dot > 0) {
      const mapped = aliases?.[value.ref.slice(0, dot)];
      if (mapped) value.ref = mapped + value.ref.slice(dot);
    }
  }
  for (const child of Object.values(value)) remapReferences(child, aliases);
}

export function remapMetricExpression(
  expression: string,
  aliases: Record<string, string> | undefined
): string {
  return expression.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\./g, (match, handle: string) =>
    aliases?.[handle] ? `{${aliases[handle]}.` : match
  );
}

export function outputPath(
  kind: 'source' | 'model' | 'metric' | 'relationship' | 'vq',
  key: string
): string {
  const folder = kind === 'vq' ? 'verified_queries' : kind === 'source' ? 'sources' : `${kind}s`;
  return `${folder}/${identity(`${kind}\0${key}`)}.yml`;
}
