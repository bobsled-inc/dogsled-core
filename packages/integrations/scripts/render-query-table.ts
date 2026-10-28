import { pathToFileURL } from 'node:url';

import { listQueryResources, type QueryResourceSummary } from '../src/query-resources/catalog.js';

export function renderQueryCapabilityTable(
  resources: QueryResourceSummary[] = listQueryResources()
): string {
  const headerRow = [
    'Source',
    'Resource',
    'Filters (field · ops · enum)',
    'Search',
    'Client surface',
  ];
  const bodyRows = resources.map((resource) => [
    resource.integration,
    resource.resource,
    formatFilterCell(resource),
    formatSearchCell(resource),
    formatClientSurfaceCell(resource),
  ]);
  const rows = [headerRow, ...bodyRows];

  const widths = headerRow.map((_, columnIndex) =>
    Math.max(0, ...rows.map((row) => row[columnIndex]?.length ?? 0))
  );

  const header = formatTableRow(headerRow, widths);
  const separator = formatTableRow(
    widths.map((width) => '-'.repeat(width)),
    widths
  );
  const body = bodyRows.map((row) => formatTableRow(row, widths));

  return [header, separator, ...body].join('\n');
}

function formatFilterCell(resource: QueryResourceSummary): string {
  if (resource.filters.length === 0) {
    return '—';
  }

  return resource.filters
    .map((filter) => {
      const operators = filter.operators.map((operator) => `$${operator}`).join('/');
      const enumValues = filter.enum ? ` · ${filter.enum.join('/')}` : '';
      return `${filter.field} · ${operators}${enumValues}`;
    })
    .join('; ');
}

function formatSearchCell(resource: QueryResourceSummary): string {
  if (!resource.search) {
    return '—';
  }

  if (resource.search.dialect === 'jira_jql') {
    return 'JQL';
  }

  return resource.search.dialect;
}

function formatClientSurfaceCell(resource: QueryResourceSummary): string {
  const clientSurface =
    resource.typedWrapper ??
    `queryIntegrationResource('${resource.integration}', '${resource.resource}', ...)`;
  return `\`${clientSurface}\``;
}

function formatTableRow(row: string[], widths: number[]): string {
  return `| ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(' | ')} |`;
}

async function main(): Promise<void> {
  process.stdout.write(`${renderQueryCapabilityTable()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
