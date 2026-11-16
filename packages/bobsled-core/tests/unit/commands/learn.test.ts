import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildProgram } from '../../../src/index.js';
import { LESSONS } from '../../../src/commands/lessons.js';

describe('learn command', () => {
  it('stores reset progress under the local Dogsled tutor directory', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'learn-progress-'));
    mkdirSync(path.join(root, '.git'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      await buildProgram().parseAsync(['node', 'dogsled', 'learn', '--reset']);
      const progress = JSON.parse(
        readFileSync(path.join(root, '.bobsled/tutor-lab/.dogsled-tutor-progress.json'), 'utf8')
      );
      expect(progress.completed).toEqual({});
      expect(progress.skipped).toEqual({});
      expect(existsSync(path.join(root, '.context'))).toBe(false);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers with the expected options', () => {
    const program = buildProgram();
    const learn = program.commands.find((c) => c.name() === 'learn');

    expect(learn).toBeDefined();
    expect(learn!.description()).toContain('tutorial');

    const optionNames = learn!.options.map((o) => o.long);
    expect(optionNames).toContain('--list');
    expect(optionNames).toContain('--reset');
    expect(optionNames).toContain('--section');
    expect(optionNames).toContain('--goto');
    expect(optionNames).toContain('--auto');
    expect(optionNames).toContain('--cli');
  });

  it('has a description suitable for --help output', () => {
    const program = buildProgram();
    const learn = program.commands.find((c) => c.name() === 'learn');

    expect(learn!.description().length).toBeGreaterThan(10);
    expect(learn!.description().length).toBeLessThan(120);
  });

  it('covers the expanded tutorial phase structure', () => {
    const sections = [...new Set(LESSONS.map((lesson) => lesson.section))];

    expect(LESSONS).toHaveLength(150);
    expect(sections).toHaveLength(19);
    expect(sections).toContain('Unified Ingest');
    expect(sections.filter((section) => /\bBet \d/.test(section))).toEqual([]);
    expect(sections).toContain('Phase 7: Entity Resolution — Data & Concepts');
    expect(sections).toContain('Phase 9: Survivorship — Golden Records');
    expect(sections).toContain('Phase 13: MCP Server Extraction');
    expect(sections).toContain('Entity Graph + SDK');
    expect(sections[sections.length - 1]).toBe('Phase 16: Wrap Up');
  });

  it('keeps lesson ids unique', () => {
    const ids = LESSONS.map((lesson) => lesson.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes first-ingest lessons with the example cwd', () => {
    const lessons = LESSONS.filter((lesson) => lesson.section === 'Unified Ingest');
    const ids = lessons.map((lesson) => lesson.id);

    expect(ids).toContain('first-ingest-unified-grammar');
    expect(ids).toContain('first-ingest-validate');
    expect(ids).toContain('first-ingest-document-streams');
    expect(ids).toContain('first-ingest-run-walkthrough');
    expect(ids).toContain('first-ingest-chunk-ids');
    expect(ids).toContain('first-ingest-acl-evidence');
    expect(ids).toContain('first-ingest-side-by-side');
    expect(ids).toContain('first-ingest-local-querying');
    expect(lessons.every((lesson) => lesson.cwd === 'first-ingest')).toBe(true);
  });
});
