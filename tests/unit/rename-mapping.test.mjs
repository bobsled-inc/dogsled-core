import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { KEEP_LIST, maskedKeepList, RULES, selectRules } from '../../scripts/rename/mapping.mjs';
import {
  globToRegExp,
  isSelfPath,
  renameText,
  transformPath,
  translatePatch,
} from '../../scripts/rename/rename.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rename = (text, file = 'docs/example.md') => renameText(text, { file, rules: RULES }).text;

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
    const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && file !== 'pnpm-lock.yaml' && !isSelfPath(file))
      .filter((file) => !/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|wasm|zip|gz|tgz)$/i.test(file))
      .filter((file) => lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile());
    const notIdempotent = [];
    for (const file of files) {
      const once = renameText(readFileSync(path.join(repoRoot, file), 'utf8'), {
        file,
        rules: RULES,
      });
      const twice = renameText(once.text, { file, rules: RULES });
      if (twice.text !== once.text) notIdempotent.push(file);
    }
    expect(notIdempotent).toEqual([]);
  }, 60_000);

  it('refuses --apply without a rule selection', () => {
    const result = spawnSync(process.execPath, ['scripts/rename/rename.mjs', '--apply'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--apply needs --rules/);
  });
});
