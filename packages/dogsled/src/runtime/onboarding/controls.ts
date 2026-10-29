import { iconPaths } from './assets.generated.js';
import { escapeHtml as e } from './html.js';

export type Icon = keyof typeof iconPaths;
export function icon(name: Icon, className = ''): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}
export function iconButton(name: Icon, label: string, attributes = ''): string {
  return `<button class="icon-button" type="button" aria-label="${e(label)}" title="${e(label)}" ${attributes}>${icon(name)}</button>`;
}
export function emptyState(title: string, description: string, action = ''): string {
  return `<div class="empty-state">${icon('Table')}<h3>${e(title)}</h3><p>${e(description)}</p>${action}</div>`;
}
export const passageColumns = ['article_text', 'support_excerpt', 'input_passages', 'passages'];
export function renderValue(key: string, value: unknown): string {
  const text = e(value == null ? 'Unknown' : String(value));
  return passageColumns.includes(key)
    ? `<details><summary>Show passage (may contain spoilers)</summary><p>${text}</p></details>`
    : text;
}
export function codeBlock(text: string, id: string): string {
  return `<div class="code-block"><div class="code-heading"><span>text</span>${iconButton('Copy', 'Copy request', `data-copy-target="${id}"`)}</div><pre id="${id}" tabindex="0">${e(text)}</pre></div>`;
}
