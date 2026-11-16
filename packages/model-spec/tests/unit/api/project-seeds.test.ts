import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverProjectSeeds } from '../../../src/api/project-seeds.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-project-seeds-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string | Buffer): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function spec(name: string, payloadPath: string): string {
  return [
    "spec_version: '0.2'",
    `name: ${name}`,
    'payload:',
    '  format: csv',
    `  path: ${payloadPath}`,
    'schema:',
    '  columns:',
    '    - name: id',
    '      type: STRING',
    '',
  ].join('\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverProjectSeeds', () => {
  it('discovers nested bare CSVs by path and loads untyped specs in memory', () => {
    const root = project();
    write(root, 'golf/datagolf/pga/seeds/events.csv', 'id\n1\n2\n');
    write(root, 'golf/datagolf/pga/seeds/specs/events.yml', spec('pga_events', '../events.csv'));
    write(root, 'notseeds/ignored.csv', 'value\n1\n');
    write(root, 'notion/seeds/keyword_headers.csv', 'header,value\nx,1\n');

    const result = discoverProjectSeeds(root);

    expect(result.specs.get('pga_events')).toMatchObject({
      spec: { type: 'seed', name: 'pga_events' },
      csvPath: realpathSync(path.join(root, 'golf/datagolf/pga/seeds/events.csv')),
    });
    expect(result.bareCsvFiles).toEqual([
      { path: 'notion/seeds/keyword_headers.csv', headers: ['header', 'value'], rowCount: 1 },
    ]);
  });

  it('reports malformed bare CSV and invalid UTF-8 without assigning names', () => {
    const root = project();
    write(root, 'golf/seeds/broken.csv', 'id,value\n1\n');
    write(root, 'golf/seeds/invalid-utf8.csv', Buffer.from([0xff, 0xfe]));

    const result = discoverProjectSeeds(root);

    expect(result.specs.size).toBe(0);
    expect(result.bareCsvFiles).toEqual([
      { path: 'golf/seeds/broken.csv', error: 'Row 2 has 1 fields but header has 2 columns.' },
      {
        path: 'golf/seeds/invalid-utf8.csv',
        error: 'golf/seeds/invalid-utf8.csv: invalid UTF-8; re-encode the file as UTF-8.',
      },
    ]);
  });

  it('rejects malformed CSV quoting', () => {
    const root = project();
    write(root, 'golf/seeds/unterminated.csv', 'id,value\n1,"unfinished\n');
    write(root, 'golf/seeds/quote-in-field.csv', 'id,value\n1,not"quoted\n');

    const result = discoverProjectSeeds(root);

    expect(result.bareCsvFiles).toEqual([
      {
        path: 'golf/seeds/quote-in-field.csv',
        error: 'Invalid CSV at line 2: quote must begin a field.',
      },
      {
        path: 'golf/seeds/unterminated.csv',
        error: 'Invalid CSV at line 2: unterminated quoted field.',
      },
    ]);
  });

  it('rejects duplicate spec names and duplicate CSV assignments', () => {
    const duplicateNames = project();
    write(duplicateNames, 'golf/seeds/a.csv', 'id\n1\n');
    write(duplicateNames, 'golf/seeds/a.yml', spec('same', 'a.csv'));
    write(duplicateNames, 'notion/seeds/b.csv', 'id\n1\n');
    write(duplicateNames, 'notion/seeds/b.yml', spec('same', 'b.csv'));
    expect(() => discoverProjectSeeds(duplicateNames)).toThrow('Duplicate seed name "same"');

    const duplicateCsv = project();
    write(duplicateCsv, 'seeds/a.csv', 'id\n1\n');
    write(duplicateCsv, 'seeds/a.yml', spec('first', 'a.csv'));
    write(duplicateCsv, 'seeds/b.yml', spec('second', 'a.csv'));
    expect(() => discoverProjectSeeds(duplicateCsv)).toThrow(
      'already assigned to another seed spec'
    );
  });

  it('rejects payload paths escaping the Project root and symlinks below seed folders', () => {
    const escaped = project();
    write(escaped, 'golf/seeds/events.yml', spec('events', '../../../outside.csv'));
    expect(() => discoverProjectSeeds(escaped)).toThrow('escapes the Project root');

    const linked = project();
    const outsideFile = path.join(os.tmpdir(), `outside-seed-${Date.now()}.csv`);
    writeFileSync(outsideFile, 'id\n1\n');
    const seedDir = path.join(linked, 'golf', 'seeds');
    mkdirSync(seedDir, { recursive: true });
    symlinkSync(outsideFile, path.join(seedDir, 'linked.csv'));
    expect(() => discoverProjectSeeds(linked)).toThrow('symbolic links are not allowed');
    rmSync(outsideFile, { force: true });
  });

  it('limits CSV discovery to the explicit folder override', () => {
    const root = project();
    write(root, 'golf/datagolf/pga/seeds/events.csv', 'id\n1\n');
    write(root, 'notion/seeds/keywords.csv', 'id\n1\n');

    const result = discoverProjectSeeds(root, { seedsDir: 'golf/datagolf/pga/seeds' });

    expect(result.bareCsvFiles.map(({ path: filePath }) => filePath)).toEqual([
      'golf/datagolf/pga/seeds/events.csv',
    ]);
  });
});
