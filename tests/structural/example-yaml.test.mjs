import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('keeps public example YAML document roots in block style', () => {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(file);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        const content = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const meaningful = content
          .split('\n')
          .filter((line) => line.trim() && !/^\s*(?:#|---\s*$)/.test(line));
        expect(meaningful[0] ?? '', file).not.toMatch(/^\s*\{/);
      }
    }
  }
  visit(path.resolve(import.meta.dirname, '../../examples'));
});
