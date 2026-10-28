import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import { renderQueryCapabilityTable } from '../scripts/render-query-table.js';
import { clearCache } from '../src/loader.js';

describe('query capability table docs', () => {
  beforeEach(() => {
    clearCache();
  });

  it('keeps README query capability table in sync with the renderer', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
    const match = readme.match(
      /<!-- query-capability-table:start -->\n([\s\S]*?)\n<!-- query-capability-table:end -->/
    );

    expect(normalizeMarkdownTable(match?.[1] ?? '')).toBe(
      normalizeMarkdownTable(renderQueryCapabilityTable())
    );
  }, 30_000);
});

function normalizeMarkdownTable(table: string): string {
  return table
    .trim()
    .split('\n')
    .map((row) => {
      const cells = row
        .trim()
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll('\\_', '_'));
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
        return cells.map(() => '---').join('|');
      }
      return cells.join('|');
    })
    .join('\n');
}
