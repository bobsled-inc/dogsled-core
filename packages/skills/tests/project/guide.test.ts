import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { indexProjectFiles } from '@bobsled-inc/project-index';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_GUIDE_MAX_FILE_BYTES,
  ProjectDocumentValidationError,
  ProjectGuideValidationError,
  loadProjectGuideDocument,
  loadIndexedProjectGuides,
  parseProjectGuide,
  projectGuideChainForAsset,
} from '../../src/project/index.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-guide-'));
  roots.push(root);
  return root;
}

function writeGuide(root: string, content: string | Buffer): string {
  const guidePath = path.join(root, 'AGENTS.md');
  writeFileSync(guidePath, content);
  return guidePath;
}

function issuesOf(run: () => unknown): Array<{ path: string; message: string }> {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectGuideValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected a ProjectGuideValidationError');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('parseProjectGuide', () => {
  it('strips explicit guide front matter while keeping path-specific identity', () => {
    const guide = parseProjectGuide('---\ntype: guide\n---\n\n# Golf context\n', 'golf/AGENTS.md');

    expect(guide.path).toBe('golf/AGENTS.md');
    expect(guide.content).toBe('# Golf context');
  });

  it('normalizes CRLF line endings before hashing', () => {
    const unix = parseProjectGuide('# Guide\n\nBody.\n');
    const windows = parseProjectGuide('# Guide\r\n\r\nBody.\r\n');

    expect(windows.content).toBe(unix.content);
    expect(windows.contentHash).toBe(unix.contentHash);
  });

  it('derives byteLength from the original document bytes', () => {
    const raw = '# Guide\n\nRevenue is USD — naïve.\n';
    const trailingRaw = `${raw}\n\n`;
    const frontRaw = `---\ndescription: Guide.\n---\n\n${raw}`;
    const guide = parseProjectGuide(raw);
    const trailing = parseProjectGuide(trailingRaw);
    const front = parseProjectGuide(frontRaw);

    expect(guide.byteLength).toBe(Buffer.byteLength(raw, 'utf8'));
    expect(trailing.contentHash).toBe(guide.contentHash);
    expect(trailing.byteLength).toBe(Buffer.byteLength(trailingRaw, 'utf8'));
    expect(front.byteLength).toBe(Buffer.byteLength(frontRaw, 'utf8'));
  });

  it('strips a UTF-8 byte order mark before detecting front matter', () => {
    const guide = parseProjectGuide('﻿---\ndescription: What the data means.\n---\n\n# Guide\n');

    expect(guide.description).toBe('What the data means.');
    expect(guide.content).toBe('# Guide');
  });

  it('recognizes a closing delimiter followed by trailing spaces', () => {
    const guide = parseProjectGuide('---\ndescription: What the data means.\n--- \t\n\n# Guide\n');

    expect(guide.description).toBe('What the data means.');
    expect(guide.content).toBe('# Guide');
  });

  it('keeps a leading thematic break followed by a heading in the content', () => {
    const guide = parseProjectGuide('---\n# Overview\n---\n\n## Rest\n');
    const withoutOpeningSection = parseProjectGuide('## Rest\n');

    expect(guide.description).toBeUndefined();
    expect(guide.content).toBe('---\n# Overview\n---\n\n## Rest');
    expect(guide.contentHash).not.toBe(withoutOpeningSection.contentHash);
  });

  it('keeps a leading thematic break followed by prose and a later rule', () => {
    const guide = parseProjectGuide('---\nSome intro prose\n---\n\n## Rest\n');

    expect(guide.description).toBeUndefined();
    expect(guide.content).toBe('---\nSome intro prose\n---\n\n## Rest');
  });

  it('keeps an empty --- block as Markdown', () => {
    const guide = parseProjectGuide('---\n---\n\n# Guide\n');

    expect(guide.description).toBeUndefined();
    expect(guide.content).toBe('---\n---\n\n# Guide');
  });

  it('treats an unterminated front matter block as Markdown', () => {
    const guide = parseProjectGuide('---\ndescription: broken\n\n# Guide\n');

    expect(guide.description).toBeUndefined();
    expect(guide.content).toBe('---\ndescription: broken\n\n# Guide');
  });

  it('treats a leading block that is not valid YAML as Markdown', () => {
    const guide = parseProjectGuide('---\nkey: [unterminated\n---\n\n# Guide\n');

    expect(guide.description).toBeUndefined();
    expect(guide.content).toBe('---\nkey: [unterminated\n---\n\n# Guide');
  });

  it('preserves unknown-only metadata and tolerates extra keys beside a description', () => {
    const plain = parseProjectGuide(
      '---\nname: guide\napplyTo: "**"\nalwaysApply: true\n---\n\n# Guide\n'
    );
    const described = parseProjectGuide(
      '---\napplyTo: "**"\ndescription: What the data means.\n---\n\n# Guide\n'
    );

    expect(plain.description).toBeUndefined();
    expect(plain.content).toBe(
      '---\nname: guide\napplyTo: "**"\nalwaysApply: true\n---\n\n# Guide'
    );
    expect(described.description).toBe('What the data means.');
    expect(described.content).toBe('# Guide');
  });

  it('reports an invalid description with a bounded issue path', () => {
    expect(issuesOf(() => parseProjectGuide('---\ndescription: 42\n---\n\n# Guide\n'))).toEqual([
      expect.objectContaining({ path: 'AGENTS.md:description' }),
    ]);
    expect(
      issuesOf(() => parseProjectGuide(`---\ndescription: ${'x'.repeat(501)}\n---\n\n# Guide\n`))
    ).toEqual([expect.objectContaining({ path: 'AGENTS.md:description' })]);
  });

  it('rejects an empty body', () => {
    expect(
      issuesOf(() => parseProjectGuide('---\ndescription: Only front matter.\n---\n'))
    ).toEqual([{ path: 'AGENTS.md', message: 'Markdown body must not be empty' }]);
    expect(issuesOf(() => parseProjectGuide('\n\n'))).toEqual([
      { path: 'AGENTS.md', message: 'Markdown body must not be empty' },
    ]);
  });

  it('throws the shared document validation error', () => {
    expect(() => parseProjectGuide('')).toThrow(ProjectDocumentValidationError);
  });
});

describe('indexed Project guides', () => {
  it('loads nested guides and resolves the ordered ancestor chain', () => {
    const index = indexProjectFiles([
      { path: 'AGENTS.md', content: '# Root\n' },
      { path: 'golf/AGENTS.md', content: '# Golf\n' },
      { path: 'golf/datagolf/AGENTS.md', content: '# DataGolf\n' },
      { path: 'golf/datagolf/pga/AGENTS.md', content: '# PGA\n' },
      { path: 'golf/datagolf/notion/AGENTS.md', content: '# Notion\n' },
    ]);
    const guides = loadIndexedProjectGuides(index);

    expect(
      projectGuideChainForAsset(guides, 'golf/datagolf/pga/models/events.yml').map(
        (guide) => guide.path
      )
    ).toEqual([
      'AGENTS.md',
      'golf/AGENTS.md',
      'golf/datagolf/AGENTS.md',
      'golf/datagolf/pga/AGENTS.md',
    ]);
  });
});

describe('loadProjectGuideDocument', () => {
  it('returns undefined when AGENTS.md is missing', () => {
    expect(loadProjectGuideDocument(project())).toBeUndefined();
  });

  it('returns undefined when the project root does not exist or is a file', () => {
    const root = project();
    writeFileSync(path.join(root, 'file.txt'), 'x');

    expect(loadProjectGuideDocument(path.join(root, 'missing'))).toBeUndefined();
    expect(loadProjectGuideDocument(path.join(root, 'file.txt'))).toBeUndefined();
  });

  it('loads a plain Markdown guide with its byte length and hash', () => {
    const root = project();
    writeGuide(root, '# Acme data\n\nRevenue is USD.\n');

    const guide = loadProjectGuideDocument(root);

    expect(guide).toEqual({
      path: 'AGENTS.md',
      content: '# Acme data\n\nRevenue is USD.',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      byteLength: 29,
    });
    expect(guide).not.toHaveProperty('description');
  });

  it('accepts a description front matter', () => {
    const root = project();
    writeGuide(root, '---\ndescription: What the Acme data means.\n---\n\n# Acme data\n');

    const guide = loadProjectGuideDocument(root);

    expect(guide?.description).toBe('What the Acme data means.');
    expect(guide?.content).toBe('# Acme data');
  });

  it('counts a UTF-8 byte order mark in the source byte length', () => {
    const root = project();
    const document = '\uFEFF---\ndescription: What the data means.\n---\n\n# Guide\n';
    writeGuide(root, document);

    expect(loadProjectGuideDocument(root)?.byteLength).toBe(Buffer.byteLength(document, 'utf8'));
  });

  it('ignores a file whose directory entry is not exactly AGENTS.md', () => {
    const root = project();
    writeFileSync(path.join(root, 'agents.md'), '# Guide\n', 'utf8');

    expect(readdirSync(root)).toEqual(['agents.md']);
    expect(loadProjectGuideDocument(root)).toBeUndefined();
  });

  it('follows a symbolic link to a regular file inside the project root', () => {
    const root = project();
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Linked guide\n', 'utf8');
    symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));

    const guide = loadProjectGuideDocument(root);

    expect(guide?.path).toBe('AGENTS.md');
    expect(guide?.content).toBe('# Linked guide');
    expect(guide?.byteLength).toBe(15);
  });

  it('accepts an in-root symbolic-link target whose name starts with two dots', () => {
    const root = project();
    writeFileSync(path.join(root, '..guide.md'), '# Linked guide\n', 'utf8');
    symlinkSync('..guide.md', path.join(root, 'AGENTS.md'));

    expect(loadProjectGuideDocument(root)?.content).toBe('# Linked guide');
  });

  it('rejects a symbolic link that escapes the project root', () => {
    const root = project();
    const outside = project();
    writeFileSync(path.join(outside, 'real.md'), '# Outside\n', 'utf8');
    symlinkSync(path.join(outside, 'real.md'), path.join(root, 'AGENTS.md'));

    expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
      { path: 'AGENTS.md', message: 'resolved path escapes the project root' },
    ]);
  });

  it('rejects a symbolic link to a directory', () => {
    const root = project();
    mkdirSync(path.join(root, 'docs'));
    symlinkSync('docs', path.join(root, 'AGENTS.md'));

    expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
      { path: 'AGENTS.md', message: 'symbolic link must point to a regular file' },
    ]);
  });

  it('rejects a dangling symbolic link as a validation error', () => {
    const root = project();
    symlinkSync('missing.md', path.join(root, 'AGENTS.md'));

    expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
      { path: 'AGENTS.md', message: 'symbolic link target cannot be read' },
    ]);
  });

  it('rejects a directory at the guide path', () => {
    const root = project();
    mkdirSync(path.join(root, 'AGENTS.md'));

    expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
      { path: 'AGENTS.md', message: 'expected a regular file' },
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable guide as a validation error instead of crashing',
    () => {
      const root = project();
      const guidePath = writeGuide(root, '# Guide\n');
      chmodSync(guidePath, 0o000);

      try {
        expect(() => loadProjectGuideDocument(root)).toThrow(ProjectGuideValidationError);
        expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
          { path: 'AGENTS.md', message: expect.stringContaining('cannot read file') },
        ]);
      } finally {
        chmodSync(guidePath, 0o644);
      }
    }
  );

  it('enforces the default and a custom byte limit', () => {
    const root = project();
    writeGuide(root, `# Guide\n\n${'x'.repeat(PROJECT_GUIDE_MAX_FILE_BYTES)}\n`);
    expect(issuesOf(() => loadProjectGuideDocument(root))[0]?.message).toMatch(/maximum is 32768/);

    const small = project();
    writeGuide(small, '# Guide\n\nShort body.\n');
    expect(issuesOf(() => loadProjectGuideDocument(small, { maxFileBytes: 8 }))).toEqual([
      { path: 'AGENTS.md', message: 'file is 21 bytes; maximum is 8' },
    ]);
    expect(loadProjectGuideDocument(small, { maxFileBytes: 21 })?.byteLength).toBe(21);
  });

  it('rejects invalid UTF-8', () => {
    const root = project();
    writeGuide(root, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));

    expect(issuesOf(() => loadProjectGuideDocument(root))).toEqual([
      { path: 'AGENTS.md', message: 'file must contain valid UTF-8' },
    ]);
  });
});
