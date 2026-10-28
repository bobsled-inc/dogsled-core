import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  assertCompleteProjectIndex,
  assertValidProjectIndex,
  configuredObjectFolders,
  configuredResourcesFolder,
  entriesOfKind,
  indexProjectFiles,
  isBlockingProjectIndexIssue,
  ProjectIndexError,
  singleEntryOfKind,
} from '../../src/index.js';

const model = (name: string) => `spec_version: "0.2"\ntype: model\nname: ${name}\n`;
const empty = indexProjectFiles([]);

describe('indexProjectFiles', () => {
  it('keeps files in discovered Skill folders out of the project object index', () => {
    const index = indexProjectFiles([
      {
        path: 'skills/skill-creator/SKILL.md',
        content: '---\nname: skill-creator\ndescription: Create Skills\n---\n',
      },
      {
        path: 'skills/skill-creator/references/example.yaml',
        content: 'type: model\nname: resource-data\n',
      },
      {
        path: 'skills/not-a-skill/models/orders.yml',
        content: 'type: model\nname: orders\n',
      },
    ]);

    expect(entriesOfKind(index, 'skill').map(({ path }) => path)).toEqual([
      'skills/skill-creator/SKILL.md',
    ]);
    expect(entriesOfKind(index, 'model').map(({ path }) => path)).toEqual([
      'skills/not-a-skill/models/orders.yml',
    ]);
    expect(index.issues).toEqual([]);
  });

  it('leaves oversized Markdown without front matter unrecognized', () => {
    const index = indexProjectFiles(
      [
        { path: 'docs/changelog.md', content: `# Changes\n${'x'.repeat(64)}` },
        { path: 'guides/skill.md', content: `---\ntype: skill\n---\n${'x'.repeat(64)}` },
      ],
      { maxFileBytes: 32 }
    );
    expect(index.unrecognized).toEqual([{ path: 'docs/changelog.md', format: 'markdown' }]);
    expect(index.issues).toEqual([
      expect.objectContaining({ path: 'guides/skill.md', code: 'file_too_large' }),
    ]);
  });

  it('keeps the type an oversized file declares so a Dogsled file still stops loaders', () => {
    const padding = 'x'.repeat(64);
    const index = indexProjectFiles(
      [
        {
          path: 'apis/partner.yml',
          content: `type: integration\nname: partner\nnote: ${padding}\n`,
        },
        { path: 'charts/values.yml', content: `type: LoadBalancer\nnote: ${padding}\n` },
        { path: 'guides/huge.md', content: `---\ntype: skill\nname: huge\n---\n${padding}` },
        {
          path: 'guides/ruled.md',
          content: `---\nsummary: part one\n---break---\ntype: skill\nname: ruled\n---\n${padding}`,
        },
        { path: 'notes/big.yml', content: `owner: data\nnote: ${padding}\n` },
      ],
      { maxFileBytes: 32 }
    );
    expect(index.issues).toEqual([
      expect.objectContaining({ path: 'apis/partner.yml', declaredType: 'integration' }),
      expect.objectContaining({ path: 'charts/values.yml', declaredType: 'LoadBalancer' }),
      expect.objectContaining({ path: 'guides/huge.md', declaredType: 'skill' }),
      expect.objectContaining({ path: 'guides/ruled.md', declaredType: 'skill' }),
      { path: 'notes/big.yml', code: 'file_too_large', message: expect.any(String) },
    ]);
    expect(
      index.issues
        .filter((issue) => isBlockingProjectIndexIssue(index, issue))
        .map(({ path }) => path)
    ).toEqual(['apis/partner.yml', 'guides/huge.md', 'guides/ruled.md']);
  });

  it('sorts entries, unrecognized files, and issues by path', () => {
    const index = indexProjectFiles([
      { path: 'z/model.yml', content: model('z') },
      { path: 'notes.yml', content: 'owner: data\n' },
      { path: 'a/model.yml', content: model('a') },
      { path: 'b/bad.yml', content: 'type: nope\n' },
      { path: 'README.md', content: '# Readme\n' },
    ]);
    expect(index.root).toBeUndefined();
    expect(index.entries.map((entry) => entry.path)).toEqual(['a/model.yml', 'z/model.yml']);
    expect(index.unrecognized).toEqual([
      { path: 'README.md', format: 'markdown' },
      { path: 'notes.yml', format: 'yaml' },
    ]);
    expect(index.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['b/bad.yml', 'unknown_type'],
    ]);
  });

  it('skips hidden paths, node_modules, and non-document files', () => {
    const index = indexProjectFiles([
      { path: '.github/workflows/ci.yml', content: 'type: nope\n' },
      { path: 'node_modules/a/b.yml', content: 'type: nope\n' },
      { path: 'seeds/users.csv', content: 'id\n' },
    ]);
    expect(index).toEqual({ root: undefined, entries: [], unrecognized: [], issues: [] });
  });

  it('allows split pipeline configs and reports guide conflicts within one directory', () => {
    const index = indexProjectFiles([
      { path: 'dogsled.yml', content: 'pipelines: {}\n' },
      { path: 'shared/pipelines.yml', content: 'type: pipeline_config\npipelines: {}\n' },
      { path: 'model-spec.yml', content: 'models_dir: models\n' },
      { path: 'golf/AGENTS.md', content: '# Golf\n' },
      { path: 'golf/guide.md', content: '---\ntype: guide\n---\nMore\n' },
      { path: 'golf/pga/AGENTS.md', content: '# PGA\n' },
    ]);
    expect(index.issues).toEqual([
      {
        path: 'golf/AGENTS.md',
        code: 'duplicate_configuration',
        message: 'A directory may contain one guide; found golf/AGENTS.md, golf/guide.md.',
      },
      {
        path: 'golf/guide.md',
        code: 'duplicate_configuration',
        message: 'A directory may contain one guide; found golf/AGENTS.md, golf/guide.md.',
      },
    ]);
  });

  it('allows any number of objects of the same kind', () => {
    const index = indexProjectFiles([
      { path: 'a.yml', content: model('a') },
      { path: 'b.yml', content: model('b') },
    ]);
    expect(index.issues).toEqual([]);
    expect(entriesOfKind(index, 'model')).toHaveLength(2);
  });

  it('reports a path given twice', () => {
    const index = indexProjectFiles([
      { path: 'a.yml', content: model('a') },
      { path: 'a.yml', content: model('b') },
    ]);
    expect(index.issues).toMatchObject([{ path: 'a.yml', code: 'invalid_path' }]);
  });

  it('reports invalid paths even for non-document files', () => {
    const index = indexProjectFiles([{ path: '../escape.csv', content: 'x' }]);
    expect(index.issues).toMatchObject([{ path: '../escape.csv', code: 'invalid_path' }]);
  });

  it('enforces the file count, file size, and total size limits', () => {
    const files = [
      { path: 'a.yml', content: model('a') },
      { path: 'b.yml', content: model('b') },
      { path: 'c.yml', content: model('c') },
    ];
    expect(indexProjectFiles(files, { maxFiles: 2 }).issues).toMatchObject([
      { path: '.', code: 'too_many_files' },
    ]);
    expect(
      indexProjectFiles([{ path: 'big.yml', content: `type: model\nx: ${'y'.repeat(64)}\n` }], {
        maxFileBytes: 32,
      }).issues
    ).toMatchObject([{ path: 'big.yml', code: 'file_too_large' }]);
    expect(indexProjectFiles(files, { maxTotalBytes: 60 }).issues).toMatchObject([
      { path: '.', code: 'total_size_exceeded' },
    ]);
  });

  it('does not count non-document files against the limits', () => {
    const index = indexProjectFiles(
      [
        { path: 'seeds/a.csv', content: 'x'.repeat(100) },
        { path: 'a.yml', content: model('a') },
      ],
      { maxFiles: 1, maxFileBytes: 64 }
    );
    expect(index.issues).toEqual([]);
  });
});

describe('index lookups and errors', () => {
  const index = indexProjectFiles([
    { path: 'dogsled.yml', content: 'pipelines: {}\n' },
    { path: 'm/b.yml', content: model('b') },
    { path: 'm/a.yml', content: model('a') },
  ]);

  it('returns entries of one kind in path order', () => {
    expect(entriesOfKind(index, 'model').map((entry) => entry.path)).toEqual([
      'm/a.yml',
      'm/b.yml',
    ]);
    expect(entriesOfKind(index, 'metric')).toEqual([]);
  });

  it('returns entries of non-singleton config kinds', () => {
    expect(entriesOfKind(index, 'pipeline_config').map((entry) => entry.path)).toEqual([
      'dogsled.yml',
    ]);
    expect(singleEntryOfKind(index, 'model_spec_config')).toBeUndefined();
  });

  it('accepts a valid index', () => {
    expect(() => assertValidProjectIndex(index)).not.toThrow();
  });

  it('raises a validation CommandError that lists every blocking issue with its path', () => {
    const invalid = indexProjectFiles([
      { path: 'models/a.yml', content: 'type: nope\n' },
      { path: 'b.yml', content: 'type: source\nname: x\n' },
    ]);
    let caught: unknown;
    try {
      assertValidProjectIndex(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectIndexError);
    expect(caught).toBeInstanceOf(CommandError);
    const error = caught as ProjectIndexError;
    expect(error.exitCode).toBe(2);
    expect(error.issues.map((issue) => issue.code)).toEqual(['ambiguous_source', 'unknown_type']);
    expect(error.message).toContain('models/a.yml: Unknown type "nope"');
    expect(error.message).toContain('b.yml: type: source is ambiguous');
  });

  it('reports problems with files Dogsled does not own without stopping loaders', () => {
    const index = indexProjectFiles([
      { path: 'charts/api/Chart.yaml', content: 'apiVersion: v2\ntype: application\nname: api\n' },
      {
        path: 'charts/api/templates/service.yaml',
        content: 'kind: Service\nspec:\n  {{- toYaml .Values.service | nindent 2 }}\n',
      },
      { path: 'docs/post.md', content: '---\ntype: page\ntitle: Post\n---\nBody\n' },
      { path: 'docs/draft.md', content: '---\ntitle: [unclosed\n---\nBody\n' },
      { path: 'agent-files/broken.yaml', content: 'type: agent\nname: [\n' },
      { path: 'models/orders.yml', content: model('orders') },
    ]);
    expect(index.issues.map(({ path, code }) => [path, code])).toEqual([
      ['agent-files/broken.yaml', 'invalid_yaml'],
      ['charts/api/Chart.yaml', 'unknown_type'],
      ['charts/api/templates/service.yaml', 'invalid_yaml'],
      ['docs/draft.md', 'invalid_front_matter'],
      ['docs/post.md', 'unknown_type'],
    ]);
    expect(index.issues.filter((issue) => isBlockingProjectIndexIssue(index, issue))).toEqual([]);
    expect(() => assertValidProjectIndex(index)).not.toThrow();
    expect(entriesOfKind(index, 'model').map((entry) => entry.path)).toEqual(['models/orders.yml']);
  });

  it('stops loaders for a broken file that declares a Dogsled type or lives in a Dogsled folder', () => {
    const index = indexProjectFiles([
      { path: 'golf/players.yml', content: 'type: model\nname: players\ncolumns: [\n' },
      { path: 'models/typo.yml', content: 'type: modle\nname: typo\n' },
      { path: 'guides/review.md', content: '---\ntype: skill\nname: [\n---\nBody\n' },
      { path: 'resources/api/users.yml', content: 'name: users\n  bad: indent\n' },
    ]);
    expect(
      index.issues
        .filter((issue) => isBlockingProjectIndexIssue(index, issue))
        .map(({ path }) => path)
    ).toEqual([
      'golf/players.yml',
      'guides/review.md',
      'models/typo.yml',
      'resources/api/users.yml',
    ]);
    expect(index.issues.find((issue) => issue.path === 'golf/players.yml')).toMatchObject({
      declaredType: 'model',
    });
    expect(
      indexProjectFiles([{ path: 'golf/quoted.yml', content: '"type": model\nname: [\n' }]).issues
    ).toEqual([expect.objectContaining({ code: 'invalid_yaml', declaredType: 'model' })]);
  });

  it('stops loaders for problems in folders the project configuration names', () => {
    const index = indexProjectFiles([
      {
        path: 'model-spec.yml',
        content: 'models_dir: ./data/models/\nsources_dir: warehouse/raw\n',
      },
      { path: 'extractor.yml', content: 'resources_dir: api\n' },
      { path: 'data/models/typo.yml', content: 'type: modle\nname: typo\n' },
      { path: 'warehouse/raw/notes.yml', content: 'type: note\n' },
      { path: 'api/users.yml', content: 'type: resorce\nname: users\n' },
      { path: 'data/other/chart.yaml', content: 'type: application\n' },
    ]);

    expect(configuredObjectFolders(index)).toEqual(['api', 'data/models', 'warehouse/raw']);
    expect(
      index.issues
        .filter((issue) => isBlockingProjectIndexIssue(index, issue))
        .map(({ path }) => path)
    ).toEqual(['api/users.yml', 'data/models/typo.yml', 'warehouse/raw/notes.yml']);
  });

  it('treats a configuration folder at the project root as covering every file', () => {
    const index = indexProjectFiles([
      { path: 'model-spec.yml', content: 'sources_dir: .\n' },
      { path: 'docs/post.md', content: '---\ntype: page\n---\nBody\n' },
    ]);

    expect(
      index.issues
        .filter((issue) => isBlockingProjectIndexIssue(index, issue))
        .map(({ path }) => path)
    ).toEqual(['docs/post.md']);
  });

  it('blocks on a link where Dogsled read or rejected links, and always on an incomplete scan or bad path', () => {
    const configured = indexProjectFiles([
      { path: 'model-spec.yml', content: 'models_dir: data/models\n' },
    ]);
    const link = (index: typeof empty, path: string) =>
      isBlockingProjectIndexIssue(index, { path, code: 'symlink', message: 'x' });
    expect(link(empty, 'dogsled.yml')).toBe(true);
    expect(link(empty, 'model-spec.yml')).toBe(true);
    expect(link(empty, 'notes.yml')).toBe(false);
    expect(link(empty, 'models/linked.yml')).toBe(true);
    expect(link(configured, 'data/models/linked.yaml')).toBe(true);
    expect(link(empty, 'skills/shared')).toBe(true);
    expect(link(empty, 'skills/review/SKILL.md')).toBe(true);
    expect(link(empty, 'models/README.md')).toBe(false);
    expect(link(empty, 'models/vendor')).toBe(false);
    expect(link(empty, 'seeds/orders.csv')).toBe(false);
    expect(link(empty, 'docs/latest.yml')).toBe(false);
    expect(
      isBlockingProjectIndexIssue(empty, { path: '.', code: 'too_many_files', message: 'x' })
    ).toBe(true);
    expect(
      isBlockingProjectIndexIssue(empty, { path: 'docs/a.yml', code: 'invalid_path', message: 'x' })
    ).toBe(true);
    expect(
      isBlockingProjectIndexIssue(empty, { path: 'README.md', code: 'unreadable', message: 'x' })
    ).toBe(false);
    expect(
      isBlockingProjectIndexIssue(empty, {
        path: 'sources/big.yml',
        code: 'file_too_large',
        message: 'x',
      })
    ).toBe(true);
  });

  it('refuses only an index that stopped at a limit when asked for a complete one', () => {
    const truncated = indexProjectFiles(
      [
        { path: 'a/model.yml', content: model('a') },
        { path: 'b/model.yml', content: model('b') },
      ],
      { maxFiles: 1 }
    );
    expect(() => assertCompleteProjectIndex(truncated)).toThrow(
      /more than 1 YAML, JSON, and Markdown files/
    );
    expect(() =>
      assertCompleteProjectIndex(indexProjectFiles([{ path: 'models/bad.yml', content: '[' }]))
    ).not.toThrow();
  });

  it('reads the resources folder from the extractor configuration', () => {
    const folder = (content: string) =>
      configuredResourcesFolder(indexProjectFiles([{ path: 'extractor.yml', content }]));
    expect(configuredResourcesFolder(empty)).toBe('resources');
    expect(folder('resources_dir: ./api/resources/\n')).toBe('api/resources');
    expect(folder('resourcesDir: api\n')).toBe('api');
    expect(folder('resources_dir: .\n')).toBe('');
    expect(folder('resources_dir: ../outside\n')).toBe('resources');
    expect(
      configuredObjectFolders(
        indexProjectFiles([{ path: 'extractor.yml', content: 'integrationsDir: apis\n' }])
      )
    ).toEqual(['apis']);
  });

  it('keeps source text out of YAML error messages', () => {
    const index = indexProjectFiles([
      {
        path: 'notes/keys.yml',
        content: 'api_key: FAKE-SECRET-123\napi_key: FAKE-SECRET-456\n',
      },
    ]);
    expect(index.issues).toEqual([
      {
        path: 'notes/keys.yml',
        code: 'invalid_yaml',
        message: 'Invalid YAML: Map keys must be unique at line 2, column 1',
      },
    ]);
  });
});
