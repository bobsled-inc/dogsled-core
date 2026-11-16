import type { TableDisplay } from './tutorial.js';
import { iconPaths } from './assets.generated.js';
import { escapeHtml as e } from './html.js';

/** Same SVG paint definition used by the Dogsled brand icon primitive. */
export const brandPaint =
  '<svg class="brand-paint" width="0" height="0" aria-hidden="true" focusable="false"><defs><linearGradient id="bobsled-gradient-brand" x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform="rotate(210, 0.5, 0.5)"><stop offset="0%" style="stop-color:var(--branded-gradient-blue)"></stop><stop offset="94%" style="stop-color:var(--branded-gradient-purple)"></stop></linearGradient></defs></svg>';

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
export function renderValue(key: string, value: unknown, display: TableDisplay): string {
  const text = e(value == null ? 'Unknown' : String(value));
  return display.passageColumns.includes(key)
    ? `<details><summary>${e(display.passageLabel)}</summary><p>${text}</p></details>`
    : text;
}
export function codeBlock(text: string, id: string): string {
  return `<div class="code-block"><div class="code-heading"><span>text</span>${iconButton('Copy', 'Copy request', `data-copy-target="${id}"`)}</div><pre id="${id}" tabindex="0">${e(text)}</pre></div>`;
}
