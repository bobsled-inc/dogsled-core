import { pathToFileURL } from 'node:url';

import {
  auditQueryResources,
  QUERY_RESOURCE_AUDIT_BUCKETS,
  type QueryResourceAuditEntry,
  type QueryResourceAuditReport,
  type QueryResourceCandidateFilter,
  type SuggestedQuerySpec,
} from '../src/query-resources/audit.js';

export function renderQueryResourceAuditJson(
  report: QueryResourceAuditReport = auditQueryResources()
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderQueryResourceAuditMarkdown(
  report: QueryResourceAuditReport = auditQueryResources()
): string {
  const lines: string[] = [
    '# Query Resource Catalog Audit',
    '',
    '## Summary',
    '',
    `Schema version: ${report.schemaVersion}`,
    '',
  ];

  lines.push(...renderSummaryTable(report));

  lines.push('');
  lines.push('## Current Query Catalog');
  lines.push('');
  lines.push(`- Total query resources: ${report.summary.queryResources.total}`);
  lines.push(`- Wrapper-backed: ${report.summary.queryResources.wrapperBacked}`);
  lines.push(`- Discovery-only: ${report.summary.queryResources.discoveryOnly}`);

  for (const bucket of QUERY_RESOURCE_AUDIT_BUCKETS) {
    const entries = report.entries.filter((entry) => entry.bucket === bucket);
    lines.push('');
    lines.push(`## ${bucket} (${entries.length})`);
    lines.push('');

    if (entries.length === 0) {
      lines.push('_No resources._');
      continue;
    }

    entries.forEach((entry, index) => {
      renderEntry(lines, entry);
      if (index < entries.length - 1 && entry.suggestedQuery) {
        lines.push('');
      }
    });
  }

  return `${lines.join('\n')}\n`;
}

function renderSummaryTable(report: QueryResourceAuditReport): string[] {
  const rows = QUERY_RESOURCE_AUDIT_BUCKETS.map(
    (bucket) => [`\`${bucket}\``, String(report.summary.buckets[bucket])] as const
  );
  rows.push(['**Total resources**', `**${report.summary.totalResources}**`]);

  const bucketWidth = Math.max('Bucket'.length, ...rows.map(([bucket]) => bucket.length));
  const countWidth = Math.max('Count'.length, ...rows.map(([, count]) => count.length));
  const lines = [
    `| ${'Bucket'.padEnd(bucketWidth)} | ${'Count'.padStart(countWidth)} |`,
    `| ${'-'.repeat(bucketWidth)} | ${`${'-'.repeat(countWidth - 1)}:`} |`,
  ];

  for (const [bucket, count] of rows) {
    lines.push(`| ${bucket.padEnd(bucketWidth)} | ${count.padStart(countWidth)} |`);
  }
  return lines;
}

function renderEntry(lines: string[], entry: QueryResourceAuditEntry): void {
  const parts = [`- \`${entry.integration}.${entry.resource}\``];
  if (entry.typedWrapper) {
    parts.push(`typed wrapper \`${entry.typedWrapper}\``);
  }
  parts.push(`reasons: ${entry.reasonCodes.map((code) => `\`${code}\``).join(', ')}`);
  lines.push(parts.join(' - '));

  if (entry.candidateFilters && entry.candidateFilters.length > 0) {
    lines.push(`  - candidate filters: ${formatCandidateFilters(entry.candidateFilters)}`);
  }

  if (entry.candidateSearch) {
    lines.push(
      `  - candidate search: \`${entry.candidateSearch.input}\` (${entry.candidateSearch.dialect})`
    );
  }

  if (entry.blockers && entry.blockers.length > 0) {
    lines.push(
      `  - blockers: ${entry.blockers
        .map(
          (blocker) =>
            `\`${blocker.input}->${blocker.field}.${blocker.operator}:${blocker.reason}\``
        )
        .join(', ')}`
    );
  }

  if (
    entry.suggestedQuery &&
    (entry.bucket === 'query_ready' || entry.bucket === 'query_ready_after_scalar_cleanup')
  ) {
    lines.push('');
    lines.push('```yaml');
    lines.push(...renderSuggestedQuery(entry.suggestedQuery));
    lines.push('```');
  }
}

function formatCandidateFilters(filters: QueryResourceCandidateFilter[]): string {
  return filters
    .map((filter) => {
      const operators = filter.operators.map((operator) => `$${operator}`).join('/');
      return `${filter.field} (${filter.type}; ${operators})`;
    })
    .join('; ');
}

function renderSuggestedQuery(suggestedQuery: SuggestedQuerySpec): string[] {
  const lines: string[] = ['query:'];

  if (suggestedQuery.filters) {
    lines.push('  filters:');
    for (const [field, filter] of Object.entries(suggestedQuery.filters)) {
      lines.push(`    ${field}:`);
      lines.push('      operators:');
      for (const operator of filter.operators) {
        lines.push(`        - ${operator}`);
      }
      if (filter.enum) {
        lines.push('      enum:');
        for (const value of filter.enum) {
          lines.push(`        - ${formatYamlString(value)}`);
        }
      }
      if (filter.description) {
        lines.push(`      description: ${formatYamlString(filter.description)}`);
      }
      lines.push('      bind:');
      for (const operator of filter.operators) {
        const binding = filter.bind[operator];
        if (binding) {
          lines.push(`        ${operator}:`);
          lines.push(`          input: ${binding.input}`);
        }
      }
    }
  }

  if (suggestedQuery.search) {
    lines.push('  search:');
    lines.push(`    dialect: ${suggestedQuery.search.dialect}`);
    lines.push('    bind:');
    lines.push(`      input: ${suggestedQuery.search.bind.input}`);
  }

  return lines;
}

function formatYamlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\n', '\\n')}'`;
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes('--json');
  process.stdout.write(
    jsonMode ? renderQueryResourceAuditJson() : renderQueryResourceAuditMarkdown()
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
