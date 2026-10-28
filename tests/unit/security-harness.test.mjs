import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adapterNames, normalizeToolOutput } from '../../scripts/security/adapters.mjs';
import {
  captureCommand,
  createFinding,
  redactText,
  repoRoot,
  sha256,
  sha256File,
  writeJson,
} from '../../scripts/security/lib.mjs';
import { buildPacket, recommend } from '../../scripts/security/packet.mjs';

const emptyFixtures = {
  actionlint: '',
  gitleaks: '[]',
  metadata: '{}',
  osv: '{"results":[]}',
  'pnpm-audit': '{"advisories":{}}',
  policy: '{"findings":[]}',
  sarif: '{"version":"2.1.0","runs":[]}',
  secretlint: '[]',
  semgrep: '{"results":[]}',
  vitest: '{"success":true}',
};

const findingFixtures = {
  actionlint: JSON.stringify([
    {
      filepath: '.github/workflows/ci.yml',
      line: 1,
      column: 2,
      message: 'example',
      kind: 'syntax-check',
    },
  ]),
  gitleaks:
    '[{"RuleID":"generic-api-key","Description":"secret","File":"config.yml","StartLine":2,"StartColumn":1}]',
  metadata: '{"fileCount":10}',
  osv: JSON.stringify({
    results: [
      {
        source: { path: 'pnpm-lock.yaml' },
        packages: [
          {
            package: { name: 'example' },
            vulnerabilities: [{ id: 'GHSA-example', summary: 'example advisory' }],
          },
        ],
      },
    ],
  }),
  'pnpm-audit': JSON.stringify({
    advisories: {
      1: {
        id: 1,
        github_advisory_id: 'GHSA-example',
        module_name: 'example',
        title: 'example advisory',
        severity: 'high',
      },
    },
  }),
  policy: JSON.stringify({
    findings: [{ rule: 'policy-example', severity: 'medium', message: 'example' }],
  }),
  sarif: JSON.stringify({
    version: '2.1.0',
    runs: [{ results: [{ ruleId: 'zizmor/example', message: { text: 'example' } }] }],
  }),
  secretlint: JSON.stringify([
    {
      filePath: 'config.yml',
      messages: [{ ruleId: 'secret-example', severity: 2, message: 'example', line: 2 }],
    },
  ]),
  semgrep: JSON.stringify({
    results: [
      {
        check_id: 'semgrep.example',
        path: 'src/example.ts',
        start: { line: 2, col: 1 },
        extra: { severity: 'WARNING', message: 'example' },
      },
    ],
  }),
  vitest: JSON.stringify({
    success: false,
    testResults: [{ name: 'property', status: 'failed', message: 'counterexample' }],
  }),
};

const partialFixtures = {
  actionlint: 'not an actionlint diagnostic',
  gitleaks: '{}',
  metadata: '[]',
  osv: '{}',
  'pnpm-audit': '{}',
  policy: '{}',
  sarif: '{"version":"2.0.0"}',
  secretlint: '{}',
  semgrep: '{}',
  vitest: '{}',
};

describe('security scanner adapters', () => {
  it('has explicit fixtures for every adapter', () => {
    expect(Object.keys(emptyFixtures).sort()).toEqual(adapterNames);
    expect(Object.keys(findingFixtures).sort()).toEqual(adapterNames);
    expect(Object.keys(partialFixtures).sort()).toEqual(adapterNames);
  });

  it.each(adapterNames)('%s accepts a successful empty report', (adapter) => {
    expect(normalizeToolOutput(adapter, emptyFixtures[adapter], { tool: adapter })).toEqual([]);
  });

  it.each(adapterNames)('%s accepts its documented report shape', (adapter) => {
    const findings = normalizeToolOutput(adapter, findingFixtures[adapter], { tool: adapter });
    if (adapter === 'metadata') {
      expect(findings).toEqual([]);
    } else {
      expect(findings).toHaveLength(1);
    }
  });

  it.each(adapterNames)('%s rejects malformed JSON or diagnostics', (adapter) => {
    if (adapter === 'actionlint') {
      expect(() => normalizeToolOutput(adapter, '{', { tool: adapter })).toThrow();
      return;
    }
    expect(() => normalizeToolOutput(adapter, '{', { tool: adapter })).toThrow('not valid JSON');
  });

  it.each(adapterNames)('%s rejects a partial report', (adapter) => {
    expect(() =>
      normalizeToolOutput(adapter, partialFixtures[adapter], { tool: adapter })
    ).toThrow();
  });

  it('normalizes portable scanner paths and ignores placeholder fingerprints', () => {
    const findings = normalizeToolOutput(
      'semgrep',
      JSON.stringify({
        results: [
          {
            check_id: 'semgrep.example',
            path: '/src/src/one.ts',
            start: { line: 2, col: 1 },
            extra: { severity: 'ERROR', message: 'one', fingerprint: 'requires login' },
          },
          {
            check_id: 'semgrep.example',
            path: '/src/src/two.ts',
            start: { line: 2, col: 1 },
            extra: { severity: 'ERROR', message: 'two', fingerprint: 'requires login' },
          },
        ],
      }),
      { tool: 'semgrep' }
    );
    expect(findings.map((finding) => finding.location.path)).toEqual(['src/one.ts', 'src/two.ts']);
    expect(findings[0].fingerprint).not.toBe(findings[1].fingerprint);
  });
});

describe('security evidence primitives', () => {
  it('preserves repository-contained compatibility symlinks in clean exports', () => {
    const reviewRoot = path.join(repoRoot, '.security-review');
    mkdirSync(reviewRoot, { recursive: true });
    const tempDir = mkdtempSync(path.join(reviewRoot, 'dogsled-security-export-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts/security/export-worktree.mjs'),
          '--out',
          path.relative(repoRoot, tempDir),
        ],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      const exportedLink = path.join(tempDir, '.claude/skills');
      expect(lstatSync(exportedLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(exportedLink)).toBe('../.agents/skills');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('security snapshots keep every recorded hash valid when source has a public manifest', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dogsled-snapshot-manifest-')));
    try {
      for (const relative of ['scripts/security/export-worktree.mjs', 'scripts/security/lib.mjs']) {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repoRoot, relative), destination);
      }
      writeFileSync(path.join(root, '.gitignore'), '.security-review/\n');
      writeFileSync(path.join(root, 'README.md'), 'Public source\n');
      writeJson(path.join(root, 'EXPORT-MANIFEST.json'), { files: [{ path: 'README.md' }] });
      writeJson(path.join(root, 'docs/EXPORT-MANIFEST.json'), { fixture: true });
      symlinkSync('README.md', path.join(root, 'readme-link'));
      expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
      expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0);
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'scripts/security/export-worktree.mjs'),
          '--out',
          '.security-review/snapshot',
        ],
        { cwd: root, encoding: 'utf8', timeout: 20_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      const output = path.join(root, '.security-review/snapshot');
      const manifest = JSON.parse(readFileSync(path.join(output, 'EXPORT-MANIFEST.json'), 'utf8'));
      expect(manifest.files.map((entry) => entry.path)).toContain('README.md');
      expect(manifest.files.map((entry) => entry.path)).toContain('docs/EXPORT-MANIFEST.json');
      for (const entry of manifest.files) {
        const file = path.join(output, entry.path);
        const actual = lstatSync(file).isSymbolicLink()
          ? sha256(readlinkSync(file))
          : sha256File(file);
        expect(actual, entry.path).toBe(entry.sha256);
      }
      expect(manifest.files.map((entry) => entry.path)).not.toContain('EXPORT-MANIFEST.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates stable fingerprints and sanitizes repository paths', () => {
    const input = {
      tool: 'scanner',
      rule: 'rule',
      severity: 'high',
      message: 'same issue',
      location: { path: path.join(repoRoot, 'src/example.ts'), line: 3 },
    };
    expect(createFinding(input).fingerprint).toBe(createFinding(input).fingerprint);
    expect(createFinding(input).location.path).toBe('src/example.ts');
  });

  it('redacts bearer tokens, query secrets, and local paths', () => {
    const redacted = redactText(
      `${repoRoot} Bearer super-secret-value https://example.test?token=secret-value`
    );
    expect(redacted).toContain('<repo>');
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('secret-value');
  });

  it('records a timed-out command as failed rather than passed', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-security-timeout-'));
    try {
      const result = captureCommand({
        id: 'timeout',
        tool: 'node',
        adapter: 'metadata',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)'],
        outputDir: tempDir,
        timeoutMs: 20,
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records an explicit tool version for wrapped scanners', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-security-version-'));
    try {
      const result = captureCommand({
        id: 'version',
        tool: 'wrapped-tool',
        adapter: 'metadata',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("{}")'],
        outputDir: tempDir,
        versionOverride: 'wrapped-tool 1.2.3 (immutable image)',
      });
      expect(result.status).toBe('passed');
      expect(result.version).toBe('wrapped-tool 1.2.3 (immutable image)');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalization marks an unavailable tool as incomplete', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-security-normalize-'));
    const rawDir = path.join(tempDir, 'raw');
    try {
      writeFileSync(path.join(tempDir, 'placeholder'), '');
      writeJson(path.join(tempDir, 'run.json'), {
        schemaVersion: 1,
        runId: path.basename(tempDir),
        repositoryCommit: 'abc123',
        publicationModel: 'clean-export-new-root',
        privateHistoryWillRemainPrivate: true,
        stages: {
          code: {
            status: 'incomplete',
            commands: [
              {
                id: 'missing',
                tool: 'missing',
                adapter: 'metadata',
                command: 'missing',
                version: 'unavailable',
                exitCode: null,
                status: 'unavailable',
                stdoutPath: 'missing.stdout',
                stderrPath: 'missing.stderr',
                stdoutSha256: 'none',
                stderrSha256: 'none',
              },
            ],
          },
        },
      });
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts/security/normalize.mjs'), '--run', tempDir],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      expect(result.status).toBe(2);
      const normalized = JSON.parse(readFileSync(path.join(tempDir, 'normalized.json'), 'utf8'));
      expect(normalized.stages.code.status).toBe('incomplete');
      expect(normalized.stages.code.commands[0].parseStatus).toBe('unavailable');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalization preserves verified remediation records', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-security-remediation-'));
    const rawDir = path.join(tempDir, 'raw');
    try {
      writeFileSync(path.join(tempDir, 'placeholder'), '');
      writeJson(path.join(tempDir, 'run.json'), {
        schemaVersion: 1,
        runId: path.basename(tempDir),
        repositoryCommit: 'abc123',
        publicationModel: 'clean-export-new-root',
        privateHistoryWillRemainPrivate: true,
        stages: {},
      });
      writeJson(path.join(tempDir, 'triage.json'), {
        findings: {},
        resolvedFindings: [
          {
            tool: 'codex',
            rule: 'fixed-example',
            severity: 'medium',
            message: 'fixed',
            classification: 'confirmed',
            disposition: 'fixed',
            verification: ['focused test'],
          },
        ],
      });
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts/security/normalize.mjs'), '--run', tempDir],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      const normalized = JSON.parse(readFileSync(path.join(tempDir, 'normalized.json'), 'utf8'));
      expect(normalized.findings).toHaveLength(1);
      expect(normalized.findings[0].disposition).toBe('fixed');
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function normalizedFixture(overrides = {}) {
  return {
    runId: 'run',
    repositoryCommit: 'abc123',
    publicationModel: 'clean-export-new-root',
    stages: {
      disclosure: { status: 'complete', commands: [] },
    },
    findings: [],
    ...overrides,
  };
}

describe('maintainer decision packet', () => {
  it('forces NO-GO for incomplete coverage or unresolved P1 findings', () => {
    expect(
      recommend(
        normalizedFixture({
          stages: { disclosure: { status: 'incomplete', commands: [] } },
        })
      )
    ).toBe('NO-GO');
    expect(
      recommend(
        normalizedFixture({
          findings: [createFinding({ severity: 'high', message: 'blocker' })],
        })
      )
    ).toBe('NO-GO');
  });

  it('reports accepted risk separately and renders deterministically', () => {
    const accepted = createFinding({
      severity: 'medium',
      message: 'accepted risk',
      classification: 'confirmed',
      disposition: 'accepted',
      codexRationale: 'Maintainer approved compatibility risk.',
    });
    const fixture = normalizedFixture({ findings: [accepted] });
    expect(recommend(fixture)).toBe('GO WITH ACCEPTED RISKS');
    const verification = { verified: true, violations: [] };
    expect(buildPacket(fixture, verification)).toBe(buildPacket(fixture, verification));
  });

  it('summarizes dismissed findings without exposing their scanner evidence', () => {
    const dismissed = createFinding({
      severity: 'high',
      message: 'fake token ghp_abcdefghijklmnopqrstuvwxyz',
      evidence: 'private scanner excerpt',
      classification: 'false_positive',
      disposition: 'not_applicable',
      codexRationale: 'A test fixture, not a credential.',
    });
    const packet = buildPacket(normalizedFixture({ findings: [dismissed] }), {
      verified: true,
      violations: [],
    });
    expect(packet).toContain('1 dismissed with code evidence');
    expect(packet).not.toContain('fake token');
    expect(packet).not.toContain('private scanner excerpt');
    expect(packet).not.toContain('A test fixture');
  });

  it('omits dismissed P3 findings from post-launch recommendations', () => {
    const dismissed = createFinding({
      severity: 'low',
      message: 'unreachable development-server advisory',
      classification: 'false_positive',
      disposition: 'not_applicable',
    });
    const packet = buildPacket(normalizedFixture({ findings: [dismissed] }), {
      verified: true,
      violations: [],
    });
    expect(packet).toContain('No unresolved P3 recommendation was produced.');
    expect(packet).not.toContain('unreachable development-server advisory');
  });

  it('marks the retired GAR configuration complete only when the finding is absent', () => {
    const verification = { verified: true, violations: [] };
    const cleanPacket = buildPacket(normalizedFixture(), verification);
    expect(cleanPacket).toContain(
      '- [x] Retired GAR settings are absent from user npm configuration; Dogsled Next uses npmjs.org.'
    );

    const staleGar = createFinding({
      rootCause: 'npm-config-audit:stale-user-private-registry-auth',
      severity: 'medium',
      message: 'stale GAR configuration',
      classification: 'confirmed',
      disposition: 'deferred',
    });
    const blockedPacket = buildPacket(normalizedFixture({ findings: [staleGar] }), verification);
    expect(blockedPacket).toContain(
      '- [ ] Maintainer removes the retired GAR user npm configuration and confirms the credential owner action.'
    );
  });
});

describe('secret scanner source selection', () => {
  it.each([true, false])('uses current Git files only when Git exists: %s', (withGit) => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dogsled-secretlint-source-')));
    try {
      for (const relative of [
        'scripts/security/secretlint-tracked.mjs',
        'scripts/security/lib.mjs',
        'scripts/ci/source-files.mjs',
      ]) {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repoRoot, relative), destination);
      }
      writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(path.join(root, '.secretlintrc.json'), '{}');
      writeJson(path.join(root, 'package.json'), { private: true, type: 'commonjs' });
      writeFileSync(path.join(root, 'README.md'), 'Public source\n');
      writeFileSync(path.join(root, 'new-source.ts'), 'export const value = 1;\n');
      writeFileSync(path.join(root, 'untracked-source.ts'), 'export const value = 2;\n');
      writeJson(path.join(root, 'EXPORT-MANIFEST.json'), { files: [{ path: 'README.md' }] });
      if (withGit) {
        expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
        expect(spawnSync('git', ['add', 'README.md', 'new-source.ts'], { cwd: root }).status).toBe(
          0
        );
      }
      const scanner = path.join(root, 'node_modules/.bin/secretlint');
      mkdirSync(path.dirname(scanner), { recursive: true });
      writeFileSync(
        scanner,
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
const reports = args.filter((arg) => !arg.startsWith('--')).map((filePath) => ({ filePath, messages: [] }));
writeFileSync(output, JSON.stringify(reports));
`
      );
      chmodSync(scanner, 0o755);
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/security/secretlint-tracked.mjs'), '--json'],
        { cwd: root, encoding: 'utf8', timeout: 20_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      const files = JSON.parse(result.stdout).map((entry) => entry.filePath);
      expect(files).toContain(path.join(root, 'README.md'));
      if (withGit) {
        expect(files).toContain(path.join(root, 'new-source.ts'));
        expect(files).toContain(path.join(root, 'untracked-source.ts'));
      } else {
        expect(files).not.toContain(path.join(root, 'new-source.ts'));
        expect(files).not.toContain(path.join(root, 'untracked-source.ts'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
