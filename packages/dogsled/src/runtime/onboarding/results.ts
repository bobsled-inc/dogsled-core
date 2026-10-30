import { escapeHtml as e } from './html.js';
import { emptyState, icon, iconButton, renderValue } from './controls.js';
import type { OnboardingSnapshot } from './schema.js';
import type { Chapter } from './content.js';

export function resultTables(chapter: Chapter): OnboardingSnapshot['tables'] {
  // Evidence belongs to its own chapter, including when the check needs attention.
  return chapter.evidence?.tables ?? [];
}
export function renderResults(chapter: Chapter): string {
  const tables = resultTables(chapter);
  if (!tables.length) {
    return emptyState(
      'No results yet',
      'Work through this chapter with your agent to see results here.',
      `<button type="button" data-return-current>${icon('ArrowLeft')}Return to current chapter</button>`
    );
  }
  return renderTableSet(tables, chapter.id);
}
function columnWidth(key: string): number {
  if (['name', 'title', 'show', 'genres'].includes(key)) return 280;
  if (['article_text', 'support_excerpt', 'input_passages', 'passages'].includes(key)) return 384;
  return ['id', 'show_id'].includes(key) ? 112 : 176;
}

export function renderTableSet(tables: OnboardingSnapshot['tables'], id: string): string {
  if (!tables.length) return emptyState('No data fetched yet', 'Connect to TVmaze to begin.');
  const header =
    tables.length > 1
      ? `<div class="result-tabs" role="tablist" aria-label="Saved tables">${tables.map((table, i) => `<button type="button" role="tab" id="tab-${id}-${i}" aria-controls="table-${id}-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-result-tab="${i}">${icon('Table')}${e(table.name)}</button>`).join('')}</div>`
      : `<h3>${icon('Table')}${e(tables[0]!.name)}</h3>`;
  return `<section class="result-preview" data-results="${id}"><div class="result-toolbar">${header}<div class="result-actions"><span class="row-count" aria-live="polite">${icon('Row')}<span data-row-count>${Math.min(tables[0]!.rows.length, 20)}/${tables[0]!.totalRows}</span></span>${iconButton('Search', 'Search saved rows', `data-search-toggle aria-expanded="false" aria-controls="search-${id}"`)}</div></div><div class="result-search" id="search-${id}" hidden><input type="search" data-search aria-label="Search all saved columns" placeholder="Search saved rows…">${iconButton('Clear', 'Close search', 'data-search-close')}</div>${tables
    .map(
      (table, i) =>
        `<div id="table-${id}-${i}" class="result-panel" ${tables.length > 1 ? `role="tabpanel" aria-labelledby="tab-${id}-${i}"` : `role="region" aria-label="${e(table.name)}"`} data-result-panel="${i}"${i ? ' hidden' : ''}><div class="table-scroll" tabindex="0" role="region" aria-label="${e(table.name)} saved preview"><table style="min-width:${table.columns.reduce((width, key) => width + columnWidth(key), 96)}px"><colgroup>${table.columns.map((key) => `<col style="width:${columnWidth(key)}px">`).join('')}<col style="width:96px"></colgroup><thead><tr>${table.columns.map((key) => `<th scope="col" aria-sort="none"><button type="button" data-sort="${e(key)}">${e(key.replaceAll('_', ' '))}</button></th>`).join('')}<th scope="col" class="details-column" aria-label="Record actions"></th></tr></thead><tbody>${table.rows
          .slice(0, 20)
          .map(
            (row, rowIndex) =>
              `<tr>${table.columns.map((key) => `<td${typeof row[key] === 'number' ? ' class="numeric"' : ''}>${renderValue(key, row[key])}</td>`).join('')}<td class="details-column">${iconButton('ExpandAlt', `Inspect ${row.name ?? row.id ?? `row ${rowIndex + 1}`}`, `data-inspect="${rowIndex}"`)}</td></tr>`
          )
          .join('')}</tbody></table></div></div>`
    )
    .join(
      ''
    )}<div class="table-pagination" hidden><button type="button" data-page="previous">${icon('ArrowLeft')}Previous rows</button><button type="button" data-page="next">Next rows${icon('ArrowRight')}</button></div><div class="no-matches" hidden>${emptyState('No matching rows', 'Try another search.')}</div></section><section class="record-inspection" data-record hidden tabindex="-1" aria-label="Selected record"><div class="pane-heading"><h3 data-record-title></h3>${iconButton('Clear', 'Close record', 'data-close-record')}</div><dl class="record-fields" data-record-fields></dl></section>`;
}
