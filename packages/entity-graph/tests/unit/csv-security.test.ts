import { describe, expect, it } from 'vitest';
import { escapeCsv } from '../../src/commands/review-export-utils.js';
import { formatCsv } from '../../src/compiler/identity/review-export.js';
describe('review CSV formula cells', () => {
  it.each(['=HYPERLINK("https://example.com")', '+1+1', '-1+1', '@SUM(A1:A2)'])(
    'neutralizes %s',
    (value) => {
      expect(escapeCsv(value)).toMatch(/^"?'/);
      const csv = formatCsv([{ pair_id: value } as Parameters<typeof formatCsv>[0][number]]);
      expect(csv).toContain(escapeCsv(value));
    }
  );
});
