import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEEP_LIST, maskedKeepList, RULES, selectRules } from '../../scripts/rename/mapping.mjs';
import { renameState, syncMain } from '../../scripts/rename/sync-main.mjs';
import {
  globToRegExp,
  isMovable,
  isProtectedPath,
  isSelfPath,
  renameText,
  transformPath,
  translatePatch,
} from '../../scripts/rename/rename.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rename = (text, file = 'docs/example.md') => renameText(text, { file, rules: RULES }).text;
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|wasm|zip|gz|tgz)$/i;
const trackedTextFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && file !== 'pnpm-lock.yaml' && !isProtectedPath(file))
    .filter((file) => !BINARY.test(file))
    .filter((file) => lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile())
    .map((file) => ({ file, text: readFileSync(path.join(repoRoot, file), 'utf8') }));

describe('rename mapping', () => {
  it('has unique, well-formed rules', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) {
      expect(rule.category).toMatch(/^BC-\d{2}$/);
      expect(['path', 'content']).toContain(rule.kind);
      expect(typeof rule.replace).toBe('string');
      if (rule.kind === 'content' && rule.match instanceof RegExp)
        expect(rule.match.flags).toContain('g');
    }
  });

  it.each([
    ['npm install @bobsled-inc/dogsled', 'npm install @bobsled-inc/bobsled-core'],
    ['@bobsled-inc/dogsled-preview', '@bobsled-inc/bobsled-core-preview'],
    ['packages/dogsled/src/index.ts', 'packages/bobsled-core/src/index.ts'],
    ['Run `dogsled extract --help`.', 'Run `bobsled extract --help`.'],
    ['export DOGSLED_MATCH_KEY_SECRET=x', 'export BOBSLED_CORE_MATCH_KEY_SECRET=x'],
    ['DOGSLED_<OFFERING>_CREDENTIALS_*', 'BOBSLED_CORE_<OFFERING>_CREDENTIALS_*'],
    ['Use the dogsled-init skill.', 'Use the bobsled-init skill.'],
    ['plugins/dogsled-core/skills', 'plugins/bobsled-core/skills'],
    [
      'SELECT _dogsled_loaded_at FROM __dogsled_cp_x',
      'SELECT _bobsled_loaded_at FROM __bobsled_cp_x',
    ],
    ['dogsled.yml and .dogsled/lake', 'bobsled.yml and .bobsled/lake'],
    ['dogsled_connection_ref: wh', 'bobsled_connection_ref: wh'],
    ['type: dogsled_managed', 'type: bobsled_managed'],
    ['kind: dogsled.pipeline.dag', 'kind: bobsled.pipeline.dag'],
    ['new DogsledRuntimeError()', 'new BobsledRuntimeError()'],
    ['openDogsledProject()', 'openBobsledProject()'],
    ['Dogsled Core runs pipelines.', 'Bobsled Core runs pipelines.'],
    ['Dogsled runs pipelines.', 'Bobsled Core runs pipelines.'],
    ['see guides/dogsled-cloud.md', 'see guides/hosted-runs.md'],
    ['github.com/bobsled-inc/dogsled-core/issues', 'github.com/bobsled-inc/bobsled-core/issues'],
    ['@bobsled-inc/dogsled-maintainers', '@bobsled-inc/bobsled-core-maintainers'],
    [
      "semanticModelName: options.name ?? 'track_export',",
      "semanticModelName: options.name ?? 'bobsled_export',",
    ],
    [
      'return `track_${slugForPipelineName(name)}`;',
      'return `bobsled_${slugForPipelineName(name)}`;',
    ],
    ["graph_id: 'track_orders'", "graph_id: 'bobsled_orders'"],
    ["kind: 'dogsled.runner.run_resource'", "kind: 'bobsled.runner.run_resource'"],
    ["kind: 'dogsled.entity_graph.run'", "kind: 'bobsled.entity_graph.run'"],
    ['const MAX_DOGSLED_CONFIG_BYTES = 1;', 'const MAX_BOBSLED_CORE_CONFIG_BYTES = 1;'],
    ['CI_DOGSLED_TOKEN', 'CI_BOBSLED_CORE_TOKEN'],
    ['run_dogsled_with_npx() {', 'run_bobsled_with_npx() {'],
    ['"sql": "x\\n_dogsled_stg_y"', '"sql": "x\\n_bobsled_stg_y"'],
    [
      'table __dogsled_live_x and _DOGSLED_LOADED_AT',
      'table __bobsled_live_x and _BOBSLED_LOADED_AT',
    ],
    ['"vendor": "DOGSLED"', '"vendor": "BOBSLED"'],
    ['USE DATABASE DOGSLED_RAW;', 'USE DATABASE BOBSLED_CORE_RAW;'],
    ['raw.replace(/\\bdogsled\\b/g, cli)', 'raw.replace(/\\bbobsled\\b/g, cli)'],
  ])('renames %s', (input, expected) => {
    expect(rename(input)).toBe(expected);
  });

  it.each([
    'bobsled_api source with BOBSLED_API_HOST and BOBSLED_CLIENT_ID',
    'destination type bobsled_managed_snowflake',
    'Copyright Bobsled, Inc.',
    'Hosted on Dogsled Cloud at https://main.dogsled.it',
    'docs.bobsled.com',
    'Vercel bobsled-dogsled',
    'comment about @dogsled/lakehouse-execution',
    '<img src="/dogsled-logo.png">',
    'pg slot track_customers_slot and track_total_hits',
  ])('keeps %s', (text) => {
    expect(rename(text)).toBe(text);
  });

  it('keeps the app domains only where the policy and guard need them', () => {
    expect(rename("'https://dogsledai.com'", 'tests/unit/security-runtime-policy.test.mjs')).toBe(
      "'https://dogsledai.com'"
    );
    expect(rename('/\\.dogsled\\.it\\b/', 'scripts/guards/privacy.mjs')).toBe(
      '/\\.dogsled\\.it\\b/'
    );
    expect(rename('Email security@dogsledai.com', 'SECURITY.md')).toBe('Email security@bobsled.co');
    const policy = String.raw`(?:bobsled\.(?:co|ai|cloud)|dogsledai\.com|dogsled\.(?:co|ai|cloud|com|it))`;
    expect(rename(policy, 'scripts/security/policy.mjs')).toBe(policy);
  });

  it('keeps the CI unit legs and their scripts in step', () => {
    expect(rename('leg: [model, graph, dogsled, rest]', '.github/workflows/ci.yml')).toBe(
      'leg: [model, graph, bobsled, rest]'
    );
    expect(rename('"test:unit:ci:dogsled": "x"', 'package.json')).toBe(
      '"test:unit:ci:bobsled": "x"'
    );
    expect(rename("const legs = ['model', 'graph', 'dogsled', 'rest'];", 'tests/a.mjs')).toBe(
      "const legs = ['model', 'graph', 'bobsled', 'rest'];"
    );
  });

  it('keeps the app wording in the privacy guard and the bounded app database name', () => {
    const fragment = String.raw`proprietary)${'${WORD_SEPARATOR}'}(?:dogsled${'${WORD_SEPARATOR}'})?app`;
    expect(rename(fragment, 'scripts/guards/privacy.mjs')).toBe(fragment);
    expect(rename('SELECT * FROM _DOGSLED_LIVE.x')).toBe('SELECT * FROM _DOGSLED_LIVE.x');
    expect(rename("osi.json: 'DOGSLED'", 'packages/model-spec/src/a.ts')).toBe(
      "osi.json: 'BOBSLED'"
    );
  });

  it('keeps the preview tooling pointed at the current repository', () => {
    const guard = "github.repository == 'bobsled-inc/dogsled-core'";
    expect(rename(guard, '.github/workflows/preview-publish.yml')).toBe(guard);
    expect(rename(guard, '.github/workflows/ci.yml')).toBe(
      "github.repository == 'bobsled-inc/bobsled-core'"
    );
  });

  it('masks only keep-list entries that contain an old name, per profile', () => {
    const toolkit = maskedKeepList('toolkit').map((entry) => entry.pattern);
    expect(toolkit).toContain('Dogsled Cloud');
    expect(toolkit).not.toContain('dogsled_write');
    expect(maskedKeepList('app').map((entry) => entry.pattern)).toContain('dogsled_write');
    expect(KEEP_LIST.filter((entry) => !/dogsled/i.test(entry.pattern)).length).toBeGreaterThan(0);
  });

  it('moves paths, including skill folders, without touching bobsled-api names', () => {
    expect(transformPath('packages/dogsled/package.json', RULES)).toBe(
      'packages/bobsled-core/package.json'
    );
    expect(transformPath('plugins/dogsled-core/skills/dogsled-init/SKILL.md', RULES)).toBe(
      'plugins/bobsled-core/skills/bobsled-init/SKILL.md'
    );
    expect(transformPath('docs/guides/dogsled-cloud.md', RULES)).toBe('docs/guides/hosted-runs.md');
    expect(transformPath('examples/x/dogsled.yml', RULES)).toBe('examples/x/bobsled.yml');
    expect(transformPath('docs/guides/run-pipelines.md', RULES)).toBeNull();
    const skills = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((file) => transformPath(file, RULES))
      .filter(Boolean);
    expect(skills.filter((file) => /(^|\/)bobsled-api-/.test(file))).toEqual([]);
  });

  it('translates patches for the per-commit fallback', () => {
    const patch = [
      'diff --git a/packages/dogsled/src/a.ts b/packages/dogsled/src/a.ts',
      '--- a/packages/dogsled/src/a.ts',
      '+++ b/packages/dogsled/src/a.ts',
      '@@ -1 +1 @@',
      "-const name = 'dogsled';",
      '-dogsled run',
      '+dogsled run --all',
      '+const name = DOGSLED_PACKAGE_NAME;',
      'diff --git a/scripts/rename/mapping.mjs b/scripts/rename/mapping.mjs',
      '+// dogsled stays here',
    ].join('\n');
    expect(translatePatch(patch, RULES).split('\n')).toEqual([
      'diff --git a/packages/bobsled-core/src/a.ts b/packages/bobsled-core/src/a.ts',
      '--- a/packages/bobsled-core/src/a.ts',
      '+++ b/packages/bobsled-core/src/a.ts',
      '@@ -1 +1 @@',
      "-const name = 'bobsled';",
      '-bobsled run',
      '+bobsled run --all',
      '+const name = BOBSLED_CORE_PACKAGE_NAME;',
      'diff --git a/scripts/rename/mapping.mjs b/scripts/rename/mapping.mjs',
      '+// dogsled stays here',
    ]);
  });

  it('selects rules by id or category and rejects unknown names', () => {
    expect(selectRules('BC-22').every((rule) => rule.category === 'BC-22')).toBe(true);
    expect(selectRules('all')).toHaveLength(RULES.length);
    expect(() => selectRules('BC-99')).toThrow(/Unknown rule/);
  });

  it('matches globs by folder', () => {
    expect(globToRegExp('scripts/rename/**').test('scripts/rename/mapping.mjs')).toBe(true);
    expect(globToRegExp('docs/solutions/**').test('docs/solutions/a/b.md')).toBe(true);
    expect(globToRegExp('**/package.json').test('package.json')).toBe(true);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/a/b.yml')).toBe(false);
    expect(isSelfPath('scripts/rename/rename.mjs')).toBe(true);
    expect(isSelfPath('scripts/release/publish.mjs')).toBe(false);
  });

  it('is idempotent on every tracked text file, so catch-up replays are safe', () => {
    const notIdempotent = [];
    for (const { file, text } of trackedTextFiles()) {
      const once = renameText(text, { file, rules: RULES });
      const twice = renameText(once.text, { file, rules: RULES });
      if (twice.text !== once.text) notIdempotent.push(file);
    }
    expect(notIdempotent).toEqual([]);
  }, 60_000);

  it('creates no bare BOBSLED_* names (D2): only BOBSLED_CORE_* or warehouse prefixes', () => {
    const bare = [];
    for (const { file, text } of trackedTextFiles()) {
      if (!text.includes('DOGSLED')) continue;
      const before = new Set(text.match(/BOBSLED_[A-Z0-9_]*/g) ?? []);
      const after = renameText(text, { file, rules: RULES }).text;
      for (const match of after.matchAll(/BOBSLED_[A-Z0-9_]*/g)) {
        const token = match[0];
        if (token.startsWith('BOBSLED_CORE_') || before.has(token)) continue;
        let start = match.index;
        while (after[start - 1] === '_') start--;
        const underscores = match.index - start;
        const warehousePrefix =
          underscores >= 1 && underscores <= 2 && !/[A-Za-z0-9]/.test(after[start - 1] ?? '');
        if (!warehousePrefix)
          bare.push(`${file}: ${after.slice(start - 4, match.index + token.length)}`);
      }
    }
    expect(bare).toEqual([]);
  }, 60_000);

  it('gives the same result for a subset run followed by the full run as for the full run', () => {
    expect(rename('@bobsled-inc/dogsled')).toBe('@bobsled-inc/bobsled-core');
    const only = (text, selector) => renameText(text, { rules: selectRules(selector) }).text;
    expect(only('npm install @bobsled-inc/dogsled', 'BC-04')).toBe(
      'npm install @bobsled-inc/dogsled'
    );
    expect(only('see packages/dogsled/src', 'BC-04')).toBe('see packages/dogsled/src');
    expect(only('run dogsled extract', 'BC-04')).toBe('run bobsled extract');
    expect(only('dogsled_connection_ref: wh', 'BC-21')).toBe('dogsled_connection_ref: wh');
    expect(
      transformPath('plugins/dogsled-core/skills/dogsled-init/SKILL.md', selectRules('BC-01'))
    ).toBeNull();
    const categories = [...new Set(RULES.map((rule) => rule.category))];
    const sample = trackedTextFiles()
      .filter(({ text }) => /dogsled|track_/i.test(text))
      .filter((_, index) => index % 10 === 0);
    const mismatches = [];
    for (const { file, text } of sample) {
      const full = renameText(text, { file, rules: RULES }).text;
      for (const category of categories) {
        const partial = renameText(text, { file, rules: selectRules(category) }).text;
        if (renameText(partial, { file, rules: RULES }).text !== full)
          mismatches.push(`${category} ${file}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 60_000);

  it('never rewrites compatibility readers or lines marked rename:keep, even with --apply --all', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rename-compat-'));
    try {
      const legacy = [
        "export const RUN_KINDS = ['track.model.run', 'dogsled.model.run', 'bobsled.model.run'];",
        "export const OLD_COLUMNS = ['_dogsled_loaded_at', '_dogsled_run_id'];",
        "export const LEGACY_CURSORS_TABLE = '__dogsled_cursors';",
        "export const OLD_SETTINGS = ['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];",
        '',
      ].join('\n');
      const reader = [
        "const OLD_KIND = 'dogsled.model.run'; // rename:keep",
        "const NEW_KIND = 'dogsled.model.run';",
        '',
      ].join('\n');
      const files = {
        'packages/dogsled/src/legacy-names.ts': legacy,
        'packages/model-spec/src/legacy-names.ts': legacy,
        'packages/model-spec/tests/unit/legacy-names.test.ts': legacy,
        'examples/old-formats/fixtures/dogsled.yml': 'dogsled_connection_ref: wh\n',
        'packages/model-spec/src/reader.ts': reader,
      };
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      }
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts/rename/rename.mjs'), '--apply', '--all', '--root', root],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      // Protected contents stay as they are, but the file moves with its folder.
      expect(
        readFileSync(path.join(root, 'packages/bobsled-core/src/legacy-names.ts'), 'utf8')
      ).toBe(legacy);
      for (const file of Object.keys(files).slice(1, 4))
        expect(readFileSync(path.join(root, file), 'utf8')).toBe(files[file]);
      expect(readFileSync(path.join(root, 'packages/model-spec/src/reader.ts'), 'utf8')).toBe(
        "const OLD_KIND = 'dogsled.model.run'; // rename:keep\nconst NEW_KIND = 'bobsled.model.run';\n"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('moves the guard allow-list paths with their files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rename-guard-paths-'));
    try {
      const allow = {
        version: 1,
        keep: [],
        exceptions: [
          {
            path: 'packages/dogsled/tests/unit/a.test.ts',
            patternId: 'track-env',
            pattern: 'TRACK_X',
            reason: 'Old-format test.',
          },
        ],
      };
      mkdirSync(path.join(root, 'scripts/guards'), { recursive: true });
      mkdirSync(path.join(root, 'packages/dogsled/tests/unit'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/guards/old-names-allow.json'), JSON.stringify(allow));
      writeFileSync(path.join(root, 'packages/dogsled/tests/unit/a.test.ts'), 'TRACK_X\n');
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts/rename/rename.mjs'),
        '--apply',
        '--all',
        '--root',
        root,
      ]);
      const moved = JSON.parse(
        readFileSync(path.join(root, 'scripts/guards/old-names-allow.json'), 'utf8')
      );
      expect(moved.exceptions[0].path).toBe('packages/bobsled-core/tests/unit/a.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  describe('catch-up with main (sync-main.mjs)', () => {
    const identity = {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const saved = {};
    let root;
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const write = (file, text) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };
    const read = (file) => readFileSync(path.join(root, file), 'utf8');
    const commitAll = (message) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    };
    const rename = (...selection) =>
      execFileSync(process.execPath, [
        path.join(repoRoot, 'scripts/rename/rename.mjs'),
        '--apply',
        ...selection,
        '--root',
        root,
      ]);
    const onMain = (change) => {
      git('switch', '-q', 'main');
      change();
      commitAll('main change');
      git('switch', '-q', 'rename');
    };

    beforeEach(() => {
      for (const key of Object.keys(identity)) saved[key] = process.env[key];
      Object.assign(process.env, identity);
      root = mkdtempSync(path.join(os.tmpdir(), 'rename-sync-'));
      git('init', '-q', '-b', 'main');
      write(
        'packages/dogsled/src/warehouse-row-state.ts',
        "export const LEGACY_CURSORS_TABLE = '__dogsled_cursors';\nexport const cli = 'dogsled';\n"
      );
      write('packages/dogsled/src/b.ts', "export const b = 'dogsled run';\n");
      commitAll('main 0');
      git('switch', '-q', '-c', 'rename');
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    });

    it('merges main as it is while the branch is not renamed yet', () => {
      // A design PR (readers first) may already be on the branch.
      write('packages/dogsled/src/legacy-names.ts', "export const OLD = 'dogsled.model.run';\n");
      commitAll('design');
      onMain(() =>
        write('packages/dogsled/src/c.ts', 'export const s = process.env.DOGSLED_NEW;\n')
      );
      const result = syncMain({ root, main: 'main' });
      expect(result).toMatchObject({ mode: 'plain', merged: true });
      expect(read('packages/dogsled/src/c.ts')).toBe('export const s = process.env.DOGSLED_NEW;\n');
      expect(read('packages/dogsled/src/b.ts')).toBe("export const b = 'dogsled run';\n");
      expect(git('branch', '--list', 'sync/main-renamed')).toBe('');
      expect(syncMain({ root, main: 'main' }).merged).toBe(false);
    }, 60_000);

    it('refuses while the branch is only partly renamed', () => {
      rename('--rules', 'BC-01');
      commitAll('rename BC-01 only');
      onMain(() =>
        write('packages/dogsled/src/c.ts', 'export const s = process.env.DOGSLED_NEW;\n')
      );
      const head = git('rev-parse', 'HEAD');
      expect(() => syncMain({ root, main: 'main' })).toThrow(/partly renamed.*back to back/);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('branch', '--list', 'sync/main-renamed')).toBe('');
    }, 60_000);

    it('reads a fully renamed branch that keeps the Explorer logo as renamed', () => {
      write('apps/explorer/public/dogsled-logo.png', 'png');
      commitAll('logo');
      const base = git('rev-parse', 'HEAD');
      rename('--all');
      commitAll('rename');
      expect(isMovable('apps/explorer/public/dogsled-logo.png')).toBe(false);
      expect(read('apps/explorer/public/dogsled-logo.png')).toBe('png');
      expect(renameState(root, base).state).toBe('renamed');
    }, 60_000);

    it('merges renamed main through the mirror once fully renamed, keeping design edits', () => {
      rename('--all');
      commitAll('rename');
      write(
        'packages/bobsled-core/src/legacy-names.ts',
        "export const LEGACY_CURSORS_TABLE = '__dogsled_cursors';\n"
      );
      write(
        'packages/bobsled-core/src/warehouse-row-state.ts',
        "export { LEGACY_CURSORS_TABLE } from './legacy-names.js';\nexport const cli = 'bobsled';\n"
      );
      commitAll('design');
      const design = read('packages/bobsled-core/src/warehouse-row-state.ts');

      onMain(() => write('packages/dogsled/src/c.ts', "export const c = 'dogsled';\n"));
      const first = syncMain({ root, main: 'main' });
      expect(first).toMatchObject({ mode: 'mirror', merged: true });
      expect(first.seeded).toBeTruthy();
      expect(read('packages/bobsled-core/src/c.ts')).toBe("export const c = 'bobsled';\n");
      expect(read('packages/bobsled-core/src/warehouse-row-state.ts')).toBe(design);

      onMain(() => {
        write('packages/dogsled/src/b.ts', "export const b = 'dogsled run --all';\n");
        write('packages/dogsled/src/d.ts', "export const d = 'dogsled';\n");
      });
      const second = syncMain({ root, main: 'main' });
      expect(second).toMatchObject({ mode: 'mirror', merged: true, seeded: null });
      expect(git('rev-parse', `${second.mirror}^1`)).toBe(first.mirror);
      expect(read('packages/bobsled-core/src/b.ts')).toBe(
        "export const b = 'bobsled run --all';\n"
      );
      expect(read('packages/bobsled-core/src/d.ts')).toBe("export const d = 'bobsled';\n");
      expect(read('packages/bobsled-core/src/warehouse-row-state.ts')).toBe(design);
      expect(read('packages/bobsled-core/src/legacy-names.ts')).toContain('__dogsled_cursors');
      expect(syncMain({ root, main: 'main' }).merged).toBe(false);
    }, 90_000);
  });

  it('refuses --apply without a rule selection', () => {
    const result = spawnSync(process.execPath, ['scripts/rename/rename.mjs', '--apply'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--apply needs --rules/);
  });
});
