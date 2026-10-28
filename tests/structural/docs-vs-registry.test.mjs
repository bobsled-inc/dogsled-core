import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../../scripts/ci/shared.mjs';

function outputTableRegistry() {
  const dir = path.join(repoRoot, 'packages/entity-graph/src/compiler/output-tables');
  const tables = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const content = readFileSync(path.join(dir, file), 'utf8');
    for (const match of content.matchAll(
      /suffix:\s*['"](__[A-Za-z0-9_]+)['"][\s\S]*?columns:\s*\[([\s\S]*?)\]\s*,?\n\s*\}/g
    )) {
      const suffix = match[1];
      const columnBlock = match[2];
      tables.set(
        suffix,
        new Set([...columnBlock.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
      );
    }
  }
  return tables;
}

function documentedContractColumns(doc) {
  const contracts = new Map();
  const headingPattern = /^### `(__[A-Za-z0-9_]+)`/gm;
  const headings = [...doc.matchAll(headingPattern)];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const suffix = heading[1];
    if (!suffix) continue;
    const start = heading.index ?? 0;
    const afterHeading = start + heading[0].length;
    const nextPeerOrParentHeading = doc.slice(afterHeading).search(/\n#{1,3} /);
    const end =
      nextPeerOrParentHeading === -1 ? doc.length : afterHeading + nextPeerOrParentHeading;
    const section = doc.slice(start, end);
    const columns = new Set();
    for (const row of section.split('\n')) {
      if (!row.startsWith('| `')) continue;
      const firstCell = row.split('|')[1] ?? '';
      for (const col of firstCell.matchAll(/`([^`]+)`/g)) {
        columns.add(col[1]);
      }
    }
    if (columns.size > 0) contracts.set(suffix, columns);
  }
  return contracts;
}

describe('public Entity Graph docs vs output table registry', () => {
  it('keeps shipped table claims backed by output-table definitions', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs/guides/entity-graph.md'), 'utf8');
    const claimed = new Set(
      [...doc.matchAll(/`(__[A-Za-z0-9_]+)`/g)]
        .map((match) => match[1])
        .filter((name) => name.startsWith('__entity_') || name.startsWith('__document_mentions'))
    );
    const registry = outputTableRegistry();
    const missing = [...claimed].filter((name) => !registry.has(name));

    expect(missing).toEqual([]);
  });

  it('keeps documented entity graph contract columns backed by output-table definitions', () => {
    const doc = readFileSync(path.join(repoRoot, 'docs/guides/entity-graph.md'), 'utf8');
    const documented = documentedContractColumns(doc);
    const registry = outputTableRegistry();

    const missing = [];
    for (const [table, columns] of documented) {
      const registered = registry.get(table);
      if (!registered) {
        missing.push(`${table}: <table missing>`);
        continue;
      }
      for (const column of columns) {
        if (!registered.has(column)) missing.push(`${table}.${column}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
