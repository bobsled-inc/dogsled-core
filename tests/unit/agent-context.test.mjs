import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentContextError,
  buildAgentContext,
  discoverChangedPaths,
  normalizeRepoPath,
  parseNameStatus,
  serializeContext,
} from '../../scripts/agent/context-lib.mjs';

const fixtures = [];

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-agent-context-'));
  fixtures.push(root);
  write(root, 'AGENTS.md', '# Fixture\n');
  write(root, 'packages/extractor/AGENTS.md', '# Extractor\n');
  write(
    root,
    'packages/extractor/package.json',
    JSON.stringify({ name: '@fixture/extractor', scripts: { 'test:unit': 'true' } })
  );
  write(
    root,
    '.agents/skills/extractor/SKILL.md',
    '---\nname: extractor\ndescription: Extract data\n---\n\n# Extractor\n'
  );
  write(
    root,
    '.agents/skills/open-source-security-review/SKILL.md',
    '---\nname: open-source-security-review\ndescription: Review security\n---\n\n# Review\n'
  );
  write(root, 'README.md', 'initial\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
}

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('agent context Git discovery', () => {
  it('parses additions, deletions, and both sides of renames', () => {
    expect(parseNameStatus('A\0new.ts\0D\0old.ts\0R100\0before.ts\0after.ts\0')).toEqual([
      'new.ts',
      'old.ts',
      'before.ts',
      'after.ts',
    ]);
  });

  it('combines committed, staged, unstaged, and untracked changes', () => {
    const root = createFixture();
    git(root, 'switch', '-c', 'feature');
    write(root, 'packages/extractor/src/http-client.ts', 'export const request = true;\n');
    git(root, 'add', 'packages/extractor/src/http-client.ts');
    git(root, 'commit', '-m', 'add client');
    write(root, 'packages/extractor/src/staged.ts', 'export const staged = true;\n');
    git(root, 'add', 'packages/extractor/src/staged.ts');
    write(root, 'README.md', 'unstaged\n');
    write(root, 'packages/extractor/src/untracked.ts', 'export const untracked = true;\n');

    const result = discoverChangedPaths({ repoRoot: root, baseRef: 'main' });
    expect(result.mode).toBe('diff');
    expect(result.paths).toEqual([
      'README.md',
      'packages/extractor/src/http-client.ts',
      'packages/extractor/src/staged.ts',
      'packages/extractor/src/untracked.ts',
    ]);
  });

  it('supports staged-only and clean-tree discovery', () => {
    const root = createFixture();
    expect(discoverChangedPaths({ repoRoot: root, baseRef: 'main' }).paths).toEqual([]);
    write(root, 'README.md', 'staged\n');
    git(root, 'add', 'README.md');
    write(root, 'untracked.txt', 'not staged\n');
    expect(discoverChangedPaths({ repoRoot: root, staged: true }).paths).toEqual(['README.md']);
  });

  it('reports invalid base refs as incomplete discovery', () => {
    const root = createFixture();
    expect(() => discoverChangedPaths({ repoRoot: root, baseRef: 'missing-ref' })).toThrow(
      AgentContextError
    );
  });
});

describe('agent context routing and output', () => {
  it('routes package, security, workspace, guide, and check context deterministically', () => {
    const root = createFixture();
    const context = buildAgentContext({
      repoRoot: root,
      discovery: {
        baseRef: null,
        mode: 'paths',
        paths: ['packages/extractor/src/http-client.ts'],
      },
    });

    expect(context.guides.map((guide) => guide.path)).toEqual([
      'AGENTS.md',
      'packages/extractor/AGENTS.md',
    ]);
    expect(context.skills.map((skill) => skill.name)).toEqual([
      'extractor',
      'open-source-security-review',
    ]);
    expect(context.workspaces).toEqual([
      { name: '@fixture/extractor', path: 'packages/extractor' },
    ]);
    expect(context.riskSurfaces.map((risk) => risk.name)).toEqual(['network_input']);
    expect(context.checks.focused.map((check) => check.command)).toContain('pnpm security:fast');
    expect(JSON.stringify(context)).not.toContain(root);
  });

  it('produces semantically equivalent JSON and YAML', () => {
    const root = createFixture();
    const context = buildAgentContext({
      repoRoot: root,
      discovery: { baseRef: null, mode: 'paths', paths: ['README.md'] },
    });
    const fromJson = JSON.parse(serializeContext(context, 'json'));
    const fromYaml = parseYaml(serializeContext(context, 'yaml'));
    expect(fromYaml).toEqual(fromJson);
    expect(serializeContext(context, 'text')).toContain('Final check:');
  });

  it('rejects explicit paths outside the repository', () => {
    const root = createFixture();
    expect(() => normalizeRepoPath(root, '../outside.ts')).toThrow(AgentContextError);
    expect(() => normalizeRepoPath(root, 'unsafe\npath.ts')).toThrow(AgentContextError);
  });

  it('returns structured exit code 2 errors from the CLI', () => {
    const cliPath = path.resolve('scripts/agent/context.mjs');
    const result = spawnSync(
      process.execPath,
      [cliPath, '--base', 'definitely-missing-agent-context-ref', '--json'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'AGENT_CONTEXT_INVALID' },
    });
  });

  it('keeps explicit path results sorted and deduplicated', () => {
    const root = createFixture();
    const context = buildAgentContext({
      repoRoot: root,
      discovery: {
        baseRef: null,
        mode: 'paths',
        paths: ['README.md', 'packages/extractor/src/http-client.ts', 'README.md'],
      },
    });
    expect(context.changedPaths).toEqual(
      ['packages/extractor/src/http-client.ts', 'README.md'].sort()
    );
  });
});
