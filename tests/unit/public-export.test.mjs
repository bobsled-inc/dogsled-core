import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  verifyExport,
  assertExport,
  assertManifest,
  exportCommit,
  createPublicRootCommit,
  main,
  parseExclusions,
  PUBLIC_ROOT_IDENTITY,
} from '../../scripts/release/public-export.mjs';
import { loadGuardSidecar } from '../../scripts/guards/lib.mjs';
import { sourceFiles } from '../../scripts/ci/source-files.mjs';

const policyPath = 'scripts/release/public-export-exclude.txt';
const toolPath = 'scripts/release/public-export.mjs';
const roots = [];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function write(root, relative, text) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function fixture(extraPolicy = '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'export-fixture-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  write(root, 'README.md', 'Public source\n');
  write(root, 'private/data.txt', 'Staging data\n');
  write(root, toolPath, 'Private tool\n');
  write(
    root,
    policyPath,
    `private/ # Private staging inputs.\n${toolPath} # Private exporter.\n${policyPath} # Private policy.\n${extraPolicy}`
  );
  return root;
}
function commit(root) {
  git(root, ['add', '.']);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture']);
  return git(root, ['rev-parse', 'HEAD']);
}
function output(root) {
  return path.join(root, 'export');
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact public source export', () => {
  it('exports only the exact commit and its committed policy, preserving bytes, modes and symlinks', () => {
    const root = fixture();
    write(root, 'bin/run.sh', '#!/bin/sh\nexit 0\n');
    write(root, 'app/[id]/page.ts', 'export default {};\n');
    chmodSync(path.join(root, 'bin/run.sh'), 0o755);
    symlinkSync('README.md', path.join(root, 'readme-link'));
    const sha = commit(root);
    write(root, 'README.md', 'Dirty worktree\n');
    write(root, 'untracked.txt', 'Untracked\n');
    write(root, policyPath, 'README.md # Dirty policy must not affect the archive.\n');
    const { manifest } = exportCommit({ root, commit: sha, output: output(root) });
    expect(readFileSync(path.join(output(root), 'README.md'), 'utf8')).toBe('Public source\n');
    expect(existsSync(path.join(output(root), 'untracked.txt'))).toBe(false);
    expect(existsSync(path.join(output(root), 'private'))).toBe(false);
    expect(existsSync(path.join(output(root), policyPath))).toBe(false);
    expect(existsSync(path.join(output(root), toolPath))).toBe(false);
    expect(manifest.commit).toBe(sha);
    expect(manifest.files.find((entry) => entry.path === 'bin/run.sh')).toMatchObject({
      mode: '100755',
      type: 'file',
    });
    expect(manifest.files.find((entry) => entry.path === 'readme-link')).toMatchObject({
      mode: '120000',
      type: 'symlink',
      sha256: sha256('README.md'),
    });
    expect(manifest.files.find((entry) => entry.path === 'README.md').sha256).toBe(
      sha256('Public source\n')
    );
  });

  it.each(['HEAD', 'a'.repeat(7), '--all', '0'.repeat(39)])(
    'rejects an inexact revision %s',
    (value) => {
      const root = fixture();
      commit(root);
      expect(() => exportCommit({ root, commit: value, output: output(root) })).toThrow(/exact/);
    }
  );
  it('rejects a full SHA for a non-commit object', () => {
    const root = fixture();
    const sha = commit(root);
    const tree = git(root, ['rev-parse', `${sha}^{tree}`]);
    expect(() => exportCommit({ root, commit: tree, output: output(root) })).toThrow(
      /commit object/
    );
  });
  it('refuses to overwrite an existing directory', () => {
    const root = fixture();
    const sha = commit(root);
    mkdirSync(output(root));
    write(root, 'export/keep.txt', 'Keep\n');
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /must not exist/
    );
    expect(readFileSync(path.join(output(root), 'keep.txt'), 'utf8')).toBe('Keep\n');
  });
  it.each(['../outside', '/tmp/outside'])('rejects escaping symlink target %s', (target) => {
    const root = fixture();
    symlinkSync(target, path.join(root, 'link'));
    const sha = commit(root);
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /symlink escapes/
    );
    expect(existsSync(output(root))).toBe(false);
  });
  it('rejects links to excluded files', () => {
    const root = fixture();
    symlinkSync('private/data.txt', path.join(root, 'link'));
    const sha = commit(root);
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /excluded path|ENOENT/
    );
    expect(existsSync(output(root))).toBe(false);
  });
  it('rejects archive attributes that change committed bytes', () => {
    const root = fixture();
    write(root, 'README.md', '$Format:%H$\n');
    write(root, '.gitattributes', 'README.md export-subst\n');
    const sha = commit(root);
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /Archive bytes differ/
    );
  });
  it.each([
    'README.md',
    '.github/workflows/retained.yml',
    'src/consumer.mjs',
    '.hidden',
    'binary.bin',
  ])('scans every retained file for excluded references: %s', (file) => {
    const root = fixture();
    write(root, file, Buffer.from('\0reference: private/data.txt\n'));
    const sha = commit(root);
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /Retained file references/
    );
  });
  it('rejects basename references to excluded files', () => {
    const root = fixture();
    write(root, 'README.md', 'Run public-export.mjs\n');
    const sha = commit(root);
    expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
      /excluded path/
    );
  });
  it('permits only the exact policy file to contain exclusion records', () => {
    const root = fixture();
    const sha = commit(root);
    const result = exportCommit({ root, commit: sha, output: output(root) });
    expect(() =>
      assertExport(output(root), result.manifest.files, result.exclusions)
    ).not.toThrow();
    write(root, 'export/README.md', 'private/data.txt');
    expect(() => assertExport(output(root), result.manifest.files, result.exclusions)).toThrow(
      /excluded path/
    );
  });
  it.each(['old-names-exceptions.json', 'privacy-exceptions.json'])(
    'rejects orphan guard exceptions in %s',
    (file) => {
      const root = fixture();
      const entry = file.startsWith('old-') ? { path: 'missing.txt' } : { files: ['missing.txt'] };
      write(root, `scripts/guards/${file}`, JSON.stringify({ exceptions: [entry] }));
      const sha = commit(root);
      expect(() => exportCommit({ root, commit: sha, output: output(root) })).toThrow(
        /Guard exception points at a missing file/
      );
    }
  );
  it('detects source-byte, executable-mode and manifest changes after verification', () => {
    const root = fixture();
    const sha = commit(root);
    const { manifest } = exportCommit({ root, commit: sha, output: output(root) });
    expect(() => assertManifest(output(root), manifest)).not.toThrow();
    const file = path.join(output(root), 'README.md');
    writeFileSync(file, 'Changed source bytes');
    expect(() => assertManifest(output(root), manifest)).toThrow(/source bytes/);
    writeFileSync(file, 'Public source\n');
    chmodSync(file, 0o755);
    expect(() => assertManifest(output(root), manifest)).toThrow(/mode or type/);
    chmodSync(file, 0o644);
    writeFileSync(path.join(output(root), 'EXPORT-MANIFEST.json'), '{}');
    expect(() => assertManifest(output(root), manifest)).toThrow(/export manifest/);
  });

  it('detects an excluded file reintroduced after export', () => {
    const root = fixture();
    const sha = commit(root);
    const result = exportCommit({ root, commit: sha, output: output(root) });
    write(root, 'export/private/data.txt', 'Reintroduced');
    expect(() => assertExport(output(root), result.manifest.files, result.exclusions)).toThrow(
      /Excluded path remains/
    );
  });
});

describe('export policy and CLI validation', () => {
  it.each([
    '../escape # reason',
    '/absolute # reason',
    'src/* # reason',
    'README.md',
    'a # reason\na # reason',
  ])('rejects unsafe or unexplained policy: %s', (text) => {
    expect(() => parseExclusions(text)).toThrow();
  });
  it('requires known complete CLI arguments', () => {
    expect(() => main(['--out'])).toThrow(/Missing value/);
    expect(() => main(['--unknown'])).toThrow(/Unknown argument/);
    expect(() => main([])).toThrow(/--out/);
  });
});

describe('optional exact guard sidecar', () => {
  it('needs no sidecar in a public tree', () => {
    const root = fixture();
    expect(loadGuardSidecar(path.join(root, 'lib.mjs'), root)).toEqual({
      exceptions: [],
      selfReferences: [],
    });
  });
  it('validates exact old-name exception records and rejects missing targets', () => {
    const root = fixture();
    const module = path.join(root, 'lib.mjs');
    const data = {
      version: 1,
      selfReferences: [],
      exceptions: [
        {
          path: 'README.md',
          patternId: 'removed-helper-bin',
          pattern: 'fixture',
          reason: 'Exact fixture match.',
        },
      ],
    };
    writeFileSync(`${module}.private.json`, JSON.stringify(data));
    expect(loadGuardSidecar(module, root).exceptions).toHaveLength(1);
    data.exceptions[0].path = 'missing.txt';
    writeFileSync(`${module}.private.json`, JSON.stringify(data));
    expect(() => loadGuardSidecar(module, root)).toThrow(/missing file/);
    data.exceptions[0].path = 'README.md';
    data.exceptions[0].extra = true;
    writeFileSync(`${module}.private.json`, JSON.stringify(data));
    expect(() => loadGuardSidecar(module, root)).toThrow(/Invalid old-name exceptions/);
  });

  it('loads exact present entries and rejects missing files, directories and wildcards', () => {
    const root = fixture();
    const module = path.join(root, 'lib.mjs');
    const data = {
      version: 1,
      selfReferences: [{ path: 'README.md', reason: 'Fixture metadata.' }],
      exceptions: [],
    };
    writeFileSync(`${module}.private.json`, JSON.stringify(data));
    expect(loadGuardSidecar(module, root).selfReferences).toContain('README.md');
    for (const invalid of ['missing.txt', 'private/', 'src/*']) {
      data.selfReferences[0].path = invalid;
      writeFileSync(`${module}.private.json`, JSON.stringify(data));
      expect(() => loadGuardSidecar(module, root)).toThrow();
    }
  });
});

describe('manifest-aware source enumeration', () => {
  it('does not let a worktree manifest hide tracked Git source', () => {
    const root = fixture();
    commit(root);
    write(root, 'EXPORT-MANIFEST.json', JSON.stringify({ files: [] }));
    expect(sourceFiles(root)).toContain('README.md');
  });

  it('enumerates a Git-free archive and rejects manifest traversal', () => {
    const root = fixture();
    rmSync(path.join(root, '.git'), { recursive: true, force: true });
    write(root, 'EXPORT-MANIFEST.json', JSON.stringify({ files: [{ path: 'README.md' }] }));
    expect(sourceFiles(root)).toEqual(['README.md']);
    write(root, 'EXPORT-MANIFEST.json', JSON.stringify({ files: [{ path: '../outside' }] }));
    expect(() => sourceFiles(root)).toThrow(/Invalid source manifest path/);
  });
});

import { deepStrictEqual, doesNotMatch, match, ok } from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';

const verificationRepoRoot = path.resolve(import.meta.dirname, '../..');

describe('complete export verification', () => {
  it('export verification keeps generated build outputs out of Turbo inputs and retains all checks', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'public-export-verify-'));
    const originalPath = process.env.PATH;
    const manifest = { files: [] };
    const save = (name, value) => writeFileSync(path.join(root, name), value);
    try {
      save('EXPORT-MANIFEST.json', `${JSON.stringify(manifest, null, 2)}\n`);
      save('.gitignore', 'dist/\nnode_modules/\n.turbo/\n');
      save(
        'package.json',
        JSON.stringify({
          name: 'verify-fixture',
          packageManager: 'pnpm@10.30.2',
          scripts: { build: 'echo build' },
        })
      );
      save('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
      save('pnpm-workspace.yaml', 'packages: []\n');
      save(
        'turbo.json',
        JSON.stringify({ tasks: { build: { inputs: ['$TURBO_DEFAULT$'], outputs: ['dist/**'] } } })
      );
      const turbo = path.join(verificationRepoRoot, 'node_modules/.bin/turbo');
      save(
        'pnpm',
        `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync('commands', args.join(' ') + '\\n');
if (args[0] === 'build' || args[0].startsWith('test:unit')) {
  const summary = JSON.parse(execFileSync(${JSON.stringify(turbo)}, ['run', 'build', '--dry=json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  appendFileSync('hashes', summary.tasks[0].hash + '\\n');
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/index.js', 'generated');
}
`
      );
      chmodSync(path.join(root, 'pnpm'), 0o755);
      process.env.PATH = `${root}${path.delimiter}${originalPath}`;
      save('.gitignore', 'dist/\nnode_modules/\n.turbo/\npnpm\ncommands\nhashes\n');
      verifyExport(root, manifest, []);
      deepStrictEqual(readFileSync(path.join(root, 'commands'), 'utf8').trim().split('\n'), [
        'install --frozen-lockfile',
        'run setup:sqlite',
        'build',
        'test:unit',
        'security:fast',
      ]);
      const hashes = readFileSync(path.join(root, 'hashes'), 'utf8').trim().split('\n');
      deepStrictEqual(hashes.length, 2);
      deepStrictEqual(hashes[0], hashes[1]);
      for (const leg of ['model', 'graph', 'bobsled', 'rest']) {
        verifyExport(root, manifest, [], leg);
        ok(readFileSync(path.join(root, 'commands'), 'utf8').includes(`test:unit:ci:${leg}`));
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('exported-tree unit legs match the exhaustive CI partition and aggregate under the existing check name', () => {
    const source = readFileSync(
      path.join(verificationRepoRoot, '.github/workflows/public-export.yml'),
      'utf8'
    );
    const exported = parseYaml(source);
    const ci = parseYaml(
      readFileSync(path.join(verificationRepoRoot, '.github/workflows/ci.yml'), 'utf8')
    );
    deepStrictEqual(
      exported.jobs['public-export'].strategy.matrix.leg,
      ci.jobs.unit.strategy.matrix.leg
    );
    deepStrictEqual(exported.jobs['public-export'].strategy['fail-fast'], false);
    const verify = exported.jobs['public-export'].steps.find((step) =>
      step.run?.includes('public-export.mjs')
    );
    match(verify.run, /--verify --unit-leg "\$UNIT_LEG"$/);
    deepStrictEqual(verify.env.UNIT_LEG, '${{ matrix.leg }}');
    deepStrictEqual(exported.jobs['public-export-ok'].name, 'public export dry run');
    deepStrictEqual(exported.jobs['public-export-ok'].needs, 'public-export');
    deepStrictEqual(exported.jobs['public-export-ok'].if, 'always()');
    ok(
      exported.jobs['public-export-ok'].steps.some(
        (step) =>
          step.run === 'test "$EXPORT" = success' &&
          step.env.EXPORT === '${{ needs.public-export.result }}'
      )
    );
    deepStrictEqual(Object.keys(exported.on).sort(), ['pull_request', 'push']);
    for (const file of ['ci.yml', 'public-export.yml']) {
      const source = readFileSync(
        path.join(verificationRepoRoot, '.github/workflows', file),
        'utf8'
      );
      const workflow = parseYaml(source);
      deepStrictEqual(workflow.permissions, { contents: 'read' });
      ok(workflow.on.pull_request);
      deepStrictEqual(
        workflow.concurrency.group,
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}"
      );
      deepStrictEqual(
        workflow.concurrency['cancel-in-progress'],
        "${{ github.event_name == 'pull_request' }}"
      );
      doesNotMatch(source, /pull_request_target|secrets[.[]|actions\/cache@/);
      for (const job of Object.values(workflow.jobs)) {
        if (job.permissions !== undefined) deepStrictEqual(job.permissions, { contents: 'read' });
        for (const step of job.steps) {
          if (step.uses?.startsWith('actions/checkout@'))
            deepStrictEqual(step.with['persist-credentials'], false);
        }
      }
    }
  });
});

describe('public scripts and root commit', () => {
  it('creates the reviewed public root after successful combined verification', () => {
    const root = fixture();
    const bin = path.join(root, 'bin');
    write(root, 'bin/pnpm', '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'pnpm'), 0o755);
    const previousPath = process.env.PATH;
    write(
      root,
      toolPath,
      readFileSync(new URL('../../scripts/release/public-export.mjs', import.meta.url), 'utf8')
    );
    const sourceCommit = commit(root);
    const { manifest } = exportCommit({
      root,
      commit: sourceCommit,
      output: path.join(root, 'expected'),
    });
    try {
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      execFileSync(process.execPath, [
        realpathSync(path.join(root, toolPath)),
        '--commit',
        sourceCommit,
        '--out',
        output(root),
        '--verify',
        '--create-root-commit',
      ]);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(git(output(root), ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s%n%P'])).toBe(
      `${PUBLIC_ROOT_IDENTITY.name}\n${PUBLIC_ROOT_IDENTITY.email}\n${PUBLIC_ROOT_IDENTITY.name}\n${PUBLIC_ROOT_IDENTITY.email}\nInitial commit`
    );
    expect(git(output(root), ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(existsSync(path.join(output(root), 'EXPORT-MANIFEST.json'))).toBe(false);
    expect(git(output(root), ['ls-files']).split('\n').sort()).toEqual(
      manifest.files.map((entry) => entry.path).sort()
    );
  }, 30_000);

  it('keeps the private guard implementation, data, coverage and history outside the public tree', () => {
    const policy = parseExclusions(
      readFileSync(
        new URL('../../scripts/release/public-export-exclude.txt', import.meta.url),
        'utf8'
      )
    );
    expect(policy.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'scripts/rename/',
        'tests/unit/rename-mapping.test.mjs',
        'tests/unit/rename-branch-isolation.test.mjs',
        '.github/workflows/preview-publish.yml',
        'scripts/release/preview.mjs',
        'tests/unit/release-preview.test.mjs',
        'scripts/guards/old-names.mjs',
        'scripts/guards/old-names-allow.json',
        'scripts/guards/old-names-baseline.json',
        'tests/unit/guard-old-names.test.mjs',
        'scripts/guards/lib.mjs.private.json',
      ])
    );
  });

  it('removes the staging guard script and its CI step and records both transformations', () => {
    const root = fixture('scripts/guards/old-names.mjs # Staging guard.\n');
    const source = JSON.stringify({
      scripts: {
        'guard:rename': 'node ./scripts/guards/old-names.mjs',
        'guard:privacy': 'node ./scripts/guards/privacy.mjs',
        'security:fast': 'node ./scripts/security/fast.mjs && node ./scripts/guards/privacy.mjs',
      },
    });
    const ci = [
      'jobs:',
      '  checks:',
      '    steps:',
      '      - run: pnpm security:fast',
      '      - name: Report old names (report-only until the rename is done)',
      '        run: pnpm guard:rename',
      '      - name: Build',
      '        run: pnpm build',
      '',
    ].join('\n');
    write(root, 'package.json', source);
    write(root, '.github/workflows/ci.yml', ci);
    write(root, 'scripts/guards/old-names.mjs', 'Private guard\n');
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    const data = JSON.parse(readFileSync(path.join(output(root), 'package.json'), 'utf8'));
    expect(data.scripts['guard:rename']).toBeUndefined();
    expect(data.scripts['guard:privacy']).toBe('node ./scripts/guards/privacy.mjs');
    expect(readFileSync(path.join(output(root), '.github/workflows/ci.yml'), 'utf8')).toBe(
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: pnpm security:fast',
        '      - name: Build',
        '        run: pnpm build',
        '',
      ].join('\n')
    );
    expect(result.manifest.transformations).toEqual([
      expect.objectContaining({ path: 'package.json', sourceSha256: sha256(source) }),
      expect.objectContaining({ path: '.github/workflows/ci.yml', sourceSha256: sha256(ci) }),
    ]);
    expect(existsSync(path.join(output(root), 'scripts/guards/old-names.mjs'))).toBe(false);
    expect(() => assertManifest(output(root), result.manifest)).not.toThrow();
  });

  it('removes the strict guard step too', () => {
    const root = fixture('scripts/guards/old-names.mjs # Staging guard.\n');
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { 'guard:rename': 'node ./scripts/guards/old-names.mjs' } })
    );
    write(
      root,
      '.github/workflows/ci.yml',
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: Check that no old names remain (strict)',
        '        run: pnpm guard:rename --strict',
        '      - name: Build',
        '        run: pnpm build',
        '',
      ].join('\n')
    );
    write(root, 'scripts/guards/old-names.mjs', 'Private guard\n');
    exportCommit({ root, commit: commit(root), output: output(root) });
    expect(readFileSync(path.join(output(root), '.github/workflows/ci.yml'), 'utf8')).toBe(
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: Build',
        '        run: pnpm build',
        '',
      ].join('\n')
    );
  });

  it('runs the public CI on main only and refuses any other rename-branch reference', () => {
    const root = fixture();
    const ci =
      'on:\n  push:\n    branches: [main, rename/bobsled-core]\n  pull_request:\n    branches: [main, rename/bobsled-core]\n';
    write(root, '.github/workflows/ci.yml', ci);
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    expect(readFileSync(path.join(output(root), '.github/workflows/ci.yml'), 'utf8')).toBe(
      'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n'
    );
    expect(result.manifest.transformations).toEqual([
      expect.objectContaining({ path: '.github/workflows/ci.yml', reason: 'Run CI on main only.' }),
    ]);
  });

  it('refuses a retained file that names the private rename branch', () => {
    const root = fixture();
    write(root, 'docs/notes.md', 'Merged from rename/bobsled-core.\n');
    expect(() => exportCommit({ root, commit: commit(root), output: output(root) })).toThrow(
      /names the private rename branch: docs\/notes\.md/
    );
  });

  it('finds the staging guard by its command after the script is renamed', () => {
    const root = fixture('scripts/guards/old-names.mjs # Staging guard.\n');
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { 'guard:renamed': 'node ./scripts/guards/old-names.mjs' } })
    );
    write(root, 'scripts/guards/old-names.mjs', 'Private guard\n');
    exportCommit({ root, commit: commit(root), output: output(root) });
    const data = JSON.parse(readFileSync(path.join(output(root), 'package.json'), 'utf8'));
    expect(data.scripts).toEqual({});
  });

  it.each([
    [{ 'guard:rename': 'node ./scripts/guards/old-names.mjs --strict' }, /package.json/],
    [
      {
        'guard:rename': 'node ./scripts/guards/old-names.mjs',
        'security:fast': 'pnpm guard:rename',
      },
      /security:fast/,
    ],
  ])('refuses an unrecognised staging guard invocation %#', (scripts, error) => {
    const root = fixture();
    write(root, 'package.json', JSON.stringify({ scripts }));
    expect(() => exportCommit({ root, commit: commit(root), output: output(root) })).toThrow(error);
  });

  it('refuses a CI workflow that calls the staging guard outside its own step', () => {
    const root = fixture();
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { 'guard:rename': 'node ./scripts/guards/old-names.mjs' } })
    );
    write(
      root,
      '.github/workflows/ci.yml',
      'jobs:\n  x:\n    steps:\n      - run: pnpm guard:rename\n'
    );
    expect(() => exportCommit({ root, commit: commit(root), output: output(root) })).toThrow(
      /ci.yml/
    );
  });

  it('creates one public root with fixed author and committer despite inherited identity', () => {
    const root = fixture();
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    write(root, 'export/build-output.txt', 'Untracked verification artifact\n');
    const previous = { ...process.env };
    try {
      process.env.GIT_AUTHOR_NAME = 'Unrelated author';
      process.env.GIT_AUTHOR_EMAIL = 'author@example.com';
      process.env.GIT_COMMITTER_NAME = 'Unrelated committer';
      process.env.GIT_COMMITTER_EMAIL = 'committer@example.com';
      const sha = createPublicRootCommit(output(root), result.manifest, result.exclusions);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
      expect(git(output(root), ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s%n%P'])).toBe(
        `${PUBLIC_ROOT_IDENTITY.name}\n${PUBLIC_ROOT_IDENTITY.email}\n${PUBLIC_ROOT_IDENTITY.name}\n${PUBLIC_ROOT_IDENTITY.email}\nInitial commit`
      );
      expect(git(output(root), ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(git(output(root), ['ls-files'])).toBe('README.md');
      expect(existsSync(path.join(output(root), 'EXPORT-MANIFEST.json'))).toBe(false);
    } finally {
      for (const key of [
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it('rejects source mutation or an existing repository before removing evidence', () => {
    const root = fixture();
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    write(root, 'export/README.md', 'Changed\n');
    expect(() => createPublicRootCommit(output(root), result.manifest, result.exclusions)).toThrow(
      /source bytes/
    );
    expect(existsSync(path.join(output(root), 'EXPORT-MANIFEST.json'))).toBe(true);
    write(root, 'export/README.md', 'Public source\n');
    git(output(root), ['init', '--quiet']);
    expect(() => createPublicRootCommit(output(root), result.manifest, result.exclusions)).toThrow(
      /Git-free/
    );
  });
});

describe('publication counsel review', () => {
  it.each([
    'counsel: review',
    'Proposed wording for counsel review',
    'Counsel:review',
    'COUNSEL: \nREVIEW',
    'proposed wording for counsel review',
  ])('blocks the public root commit on %s and lists every affected file', (marker) => {
    const root = fixture();
    write(root, 'README.md', `<!-- ${marker} -->\n`);
    write(root, 'policy/terms.md', `${marker}: pending text\n`);
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    expect(() => createPublicRootCommit(output(root), result.manifest, result.exclusions)).toThrow(
      'Publication blocked by counsel-review markers: README.md, policy/terms.md'
    );
    expect(existsSync(path.join(output(root), '.git'))).toBe(false);
    expect(existsSync(path.join(output(root), 'EXPORT-MANIFEST.json'))).toBe(true);
  });

  it('permits draft verification while blocking subsequent publication', () => {
    const root = fixture();
    write(root, 'README.md', '<!-- counsel: review -->\n');
    write(root, 'bin/pnpm', '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(root, 'bin/pnpm'), 0o755);
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${previousPath}`;
      expect(() => verifyExport(output(root), result.manifest, result.exclusions)).not.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }
    rmSync(path.join(output(root), '.git'), { recursive: true });
    expect(() => createPublicRootCommit(output(root), result.manifest, result.exclusions)).toThrow(
      /README.md/
    );
  });

  it('ignores review markers in files excluded from publication', () => {
    const root = fixture();
    write(root, 'private/data.txt', 'counsel: review\nProposed wording for counsel review\n');
    const result = exportCommit({ root, commit: commit(root), output: output(root) });
    expect(() =>
      createPublicRootCommit(output(root), result.manifest, result.exclusions)
    ).not.toThrow();
  });
});

it('reports marker files and exits unsuccessfully through the publication CLI', () => {
  const root = fixture();
  write(
    root,
    toolPath,
    readFileSync(new URL('../../scripts/release/public-export.mjs', import.meta.url), 'utf8')
  );
  write(root, 'README.md', '<!-- Counsel:review -->\n');
  const sha = commit(root);
  const result = spawnSync(
    process.execPath,
    [
      realpathSync(path.join(root, toolPath)),
      '--commit',
      sha,
      '--out',
      output(root),
      '--create-root-commit',
    ],
    { encoding: 'utf8' }
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Publication blocked by counsel-review markers: README.md');
  expect(existsSync(path.join(output(root), '.git'))).toBe(false);
  expect(existsSync(path.join(output(root), 'EXPORT-MANIFEST.json'))).toBe(true);
});
