import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findConfigurationEntry,
  ProjectIndexError,
  scanProject,
  type ProjectIndex,
} from '../../src/index.js';

let root: string;

function write(relativePath: string, content: string | Buffer): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function kinds(index: ProjectIndex): Array<[string, string]> {
  return index.entries.map((entry) => [entry.path, entry.kind]);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'project-index-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanProject', () => {
  it.each(['yml', 'yaml'])('recognizes Dogsled config extensions .%s', (extension) => {
    write(`dogsled.${extension}`, 'pipelines: {}\n');
    write(`model-spec.${extension}`, 'models_dir: models\n');
    expect(kinds(scanProject(root))).toEqual([
      [`dogsled.${extension}`, 'pipeline_config'],
      [`model-spec.${extension}`, 'model_spec_config'],
    ]);
  });

  it('leaves retired conventional files unrecognized', () => {
    write('track.yml', 'pipelines: {}\n');
    write('bms.yml', 'models_dir: models\n');
    expect(kinds(scanProject(root))).toEqual([]);
  });

  it('indexes nested data-first folders by declared type', () => {
    write('dogsled.yml', 'pipelines: {}\n');
    write('datagolf/integration.yml', 'spec_version: "2"\ntype: source\nname: datagolf\n');
    write('datagolf/players/players.yml', 'spec_version: "0.2"\ntype: model\nname: players\n');
    write('datagolf/players/raw.yml', 'spec_version: "0.2"\ntype: source\nname: raw\n');
    write('datagolf/skills/lookup.md', '---\ntype: skill\nname: lookup\n---\nBody\n');
    write('README.md', '# Project\n');

    const index = scanProject(root);
    expect(index.root).toBe(path.resolve(root));
    expect(kinds(index)).toEqual([
      ['datagolf/integration.yml', 'integration'],
      ['datagolf/players/players.yml', 'model'],
      ['datagolf/players/raw.yml', 'source'],
      ['datagolf/skills/lookup.md', 'skill'],
      ['dogsled.yml', 'pipeline_config'],
    ]);
    expect(index.unrecognized).toEqual([{ path: 'README.md', format: 'markdown' }]);
    expect(index.issues).toEqual([]);
  });

  it('leaves files in a conventional Skill folder to the Skill package loader', () => {
    write(
      'skills/skill-creator/SKILL.md',
      '---\nname: skill-creator\ndescription: Create Skills\n---\nInstructions.\n'
    );
    write('skills/skill-creator/references/example.yaml', 'type: model\nname: not-a-model\n');
    write('skills/skill-creator/scripts/run.py', 'print("resource")\n');

    const index = scanProject(root);

    expect(kinds(index)).toEqual([['skills/skill-creator/SKILL.md', 'skill']]);
    expect(index.unrecognized).toEqual([]);
    expect(index.issues).toEqual([]);
  });

  it('classifies typed YAML normally when its Skill folder has no entrypoint', () => {
    write('skills/not-a-skill/models/orders.yml', 'type: model\nname: orders\n');

    expect(kinds(scanProject(root))).toEqual([['skills/not-a-skill/models/orders.yml', 'model']]);
  });

  it('skips hidden entries and node_modules without reading them', () => {
    write('.github/workflows/ci.yml', 'type: nope\n');
    write('.dogsled/state.yml', 'type: nope\n');
    write('node_modules/pkg/spec.yml', 'type: nope\n');
    write('models/.draft.yml', 'type: nope\n');
    write('models/a.yml', 'type: model\nname: a\n');
    expect(kinds(scanProject(root))).toEqual([['models/a.yml', 'model']]);
  });

  it('reports symbolic links instead of following them', () => {
    write('real/a.yml', 'type: model\nname: a\n');
    symlinkSync(path.join(root, 'real'), path.join(root, 'linked-dir'));
    symlinkSync(path.join(root, 'real', 'a.yml'), path.join(root, 'linked.yml'));
    const index = scanProject(root);
    expect(kinds(index)).toEqual([['real/a.yml', 'model']]);
    expect(index.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['linked-dir', 'symlink'],
      ['linked.yml', 'symlink'],
    ]);
  });

  it('skips root-level Markdown aliases but reports nested Markdown links', () => {
    write('AGENTS.md', '# Guide\n');
    write('docs/notes.md', '# Notes\n');
    symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'));
    symlinkSync(path.join(root, 'docs', 'notes.md'), path.join(root, 'docs', 'alias.md'));
    const index = scanProject(root);
    expect(kinds(index)).toEqual([['AGENTS.md', 'guide']]);
    expect(index.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['docs/alias.md', 'symlink'],
    ]);
  });

  it('accepts a symbolic link as the project root itself', () => {
    write('models/a.yml', 'type: model\nname: a\n');
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    try {
      expect(kinds(scanProject(alias))).toEqual([['models/a.yml', 'model']]);
    } finally {
      unlinkSync(alias);
    }
  });

  it('stops descending past the depth limit', () => {
    write('a/b/c/model.yml', 'type: model\nname: deep\n');
    write('a/shallow.yml', 'type: model\nname: shallow\n');
    const index = scanProject(root, { maxDepth: 2 });
    expect(kinds(index)).toEqual([['a/shallow.yml', 'model']]);
    expect(index.issues).toMatchObject([{ path: 'a/b/c', code: 'too_deep' }]);
  });

  it('stops at the entry and file limits', () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.yml`, `type: model\nname: ${name}\n`);
    expect(scanProject(root, { maxEntries: 2 }).issues).toMatchObject([
      { path: '.', code: 'too_many_entries' },
    ]);
    expect(scanProject(root, { maxFiles: 2 }).issues).toMatchObject([
      { path: '.', code: 'too_many_files' },
    ]);
  });

  it('reports oversized YAML but skips oversized Markdown that cannot declare a type', () => {
    write('big.yml', `type: model\nnote: ${'x'.repeat(200)}\n`);
    write('docs/big.md', `# Notes\n${'x'.repeat(200)}\n`);
    write('docs/typed.md', `---\ntype: skill\n---\n${'x'.repeat(200)}\n`);
    const index = scanProject(root, { maxFileBytes: 100 });
    expect(index.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['big.yml', 'file_too_large'],
      ['docs/typed.md', 'file_too_large'],
    ]);
    expect(index.unrecognized).toEqual([{ path: 'docs/big.md', format: 'markdown' }]);
  });

  it('stops at the total size limit', () => {
    write('a.yml', `type: model\nnote: ${'x'.repeat(60)}\n`);
    write('b.yml', `type: model\nnote: ${'x'.repeat(60)}\n`);
    expect(scanProject(root, { maxTotalBytes: 100 }).issues).toMatchObject([
      { path: '.', code: 'total_size_exceeded' },
    ]);
  });

  it('requires valid UTF-8 in files that can declare a type', () => {
    write('bad.yml', Buffer.from([0x74, 0x79, 0x70, 0x65, 0x3a, 0x20, 0xff, 0x0a]));
    write('docs/latin1.md', Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
    const index = scanProject(root);
    expect(index.issues).toMatchObject([{ path: 'bad.yml', code: 'invalid_encoding' }]);
    expect(index.unrecognized).toEqual([{ path: 'docs/latin1.md', format: 'markdown' }]);
  });

  it('keeps a byte order mark in the indexed content', () => {
    write('models/a.yml', '\uFEFFtype: model\nname: a\n');
    const [entry] = scanProject(root).entries;
    expect(entry?.kind).toBe('model');
    expect(entry?.content.startsWith('\uFEFF')).toBe(true);
  });

  it('keeps the type an oversized or non-UTF-8 file declares', () => {
    write('apis/partner.yml', `type: integration\nname: partner\n${'# padding\n'.repeat(20)}`);
    write(
      'apis/latin1.yml',
      Buffer.concat([Buffer.from('type: resource\nname: r\nnote: '), Buffer.from([0xe9, 0x0a])])
    );
    write('notes/big.yml', `owner: data\n${'# padding\n'.repeat(20)}`);

    expect(scanProject(root, { maxFileBytes: 100 }).issues).toEqual([
      expect.objectContaining({
        path: 'apis/latin1.yml',
        code: 'invalid_encoding',
        declaredType: 'resource',
      }),
      expect.objectContaining({
        path: 'apis/partner.yml',
        code: 'file_too_large',
        declaredType: 'integration',
      }),
      { path: 'notes/big.yml', code: 'file_too_large', message: expect.any(String) },
    ]);
  });

  it('throws the native error for a root it cannot list', () => {
    expect(() => scanProject(path.join(root, 'missing'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
    write('file.yml', 'type: model\n');
    expect(() => scanProject(path.join(root, 'file.yml'))).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' })
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable subdirectory as an issue',
    () => {
      write('locked/a.yml', 'type: model\nname: a\n');
      chmodSync(path.join(root, 'locked'), 0o000);
      try {
        expect(scanProject(root).issues).toMatchObject([{ path: 'locked', code: 'unreadable' }]);
      } finally {
        chmodSync(path.join(root, 'locked'), 0o755);
      }
    }
  );

  it('produces the same index for equivalent conventional and data-first trees', () => {
    const files: Record<string, string> = {
      integration: 'spec_version: "1"\ntype: integration\nname: warehouse\nsource_type: duckdb\n',
      source: 'spec_version: "0.2"\ntype: source\nname: raw_orders\n',
      model: 'spec_version: "0.2"\ntype: model\nname: orders\n',
      metric: 'spec_version: "0.2"\ntype: metric\nname: revenue\n',
    };
    const conventional = {
      'integrations/warehouse.yml': files.integration,
      'sources/warehouse/raw_orders.yml': files.source,
      'models/orders.yml': files.model,
      'metrics/revenue.yml': files.metric,
    };
    const dataFirst = {
      'shop/warehouse.yml': files.integration,
      'shop/orders/raw.yml': files.source,
      'shop/orders/model.yml': files.model,
      'shop/orders/revenue.yml': files.metric,
    };
    const summarize = (layout: Record<string, string | undefined>) => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      for (const [filePath, content] of Object.entries(layout)) write(filePath, content ?? '');
      return scanProject(root)
        .entries.map((entry) => [entry.kind, JSON.stringify(entry.document)])
        .sort();
    };
    expect(summarize(dataFirst)).toEqual(summarize(conventional));
  });
});

describe('findConfigurationEntry', () => {
  it('reads the configuration file even when another file is malformed', () => {
    write('settings/model-spec.yml', 'type: model_spec_config\nmodels_dir: models\n');
    write('sources/broken.yml', '[');

    expect(findConfigurationEntry(root, 'model_spec_config')?.path).toBe('settings/model-spec.yml');
    expect(scanProject(root).issues).toEqual([
      expect.objectContaining({ path: 'sources/broken.yml', code: 'invalid_yaml' }),
    ]);
  });

  it('returns undefined when the project has no configuration of that kind', () => {
    write('models/orders.yml', 'type: model\nname: orders\n');

    expect(findConfigurationEntry(root, 'model_spec_config')).toBeUndefined();
  });

  it('refuses a scan that stopped at a limit before seeing every file', () => {
    write('a/model.yml', 'type: model\nname: a\n');
    write('b/model.yml', 'type: model\nname: b\n');
    write('settings/model-spec.yml', 'type: model_spec_config\n');

    expect(() =>
      findConfigurationEntry(root, 'model_spec_config', scanProject(root, { maxFiles: 1 }))
    ).toThrow(/more than 1 YAML, JSON, and Markdown files/);
  });

  it('refuses a configuration file it cannot read instead of reporting none', () => {
    write('extractor.yml', `resources_dir: api\n${'# padding\n'.repeat(20)}`);

    expect(() =>
      findConfigurationEntry(root, 'extractor_config', scanProject(root, { maxFileBytes: 100 }))
    ).toThrow(/extractor\.yml: The file is \d+ bytes; the limit is 100\./);
  });

  it('refuses a linked configuration file', () => {
    write('shared/model-spec.yml', 'models_dir: models\n');
    symlinkSync(path.join(root, 'shared', 'model-spec.yml'), path.join(root, 'model-spec.yml'));

    expect(() => findConfigurationEntry(root, 'model_spec_config')).toThrow(
      /model-spec\.yml: Dogsled does not follow symbolic links\./
    );
  });

  it('refuses a malformed file that declares the configuration type', () => {
    write('settings/model-spec.yml', 'type: model_spec_config\nmodels_dir: [\n');

    expect(() => findConfigurationEntry(root, 'model_spec_config')).toThrow(
      /settings\/model-spec\.yml: Invalid YAML/
    );
  });

  it('has no configuration for a project root that does not exist', () => {
    expect(findConfigurationEntry(path.join(root, 'missing'), 'extractor_config')).toBeUndefined();
  });

  it('names both files when the project has two', () => {
    write('model-spec.yml', 'models_dir: models\n');
    write('settings/model-spec.yml', 'type: model_spec_config\n');

    expect(() => findConfigurationEntry(root, 'model_spec_config')).toThrow(ProjectIndexError);
    expect(() => findConfigurationEntry(root, 'model_spec_config')).toThrow(
      /A project may contain one model_spec_config file; found model-spec\.yml, settings\/model-spec\.yml/
    );
  });
});

describe('Ossie scans', () => {
  it('finds JSON and YAML Ossie files alongside native files', () => {
    write('domain/semantic.json', '{"version":"0.2.0.dev0","name":"orders","datasets":[]}');
    write('domain/another.yaml', 'version: 0.2.0.dev0\nname: customers\ndatasets: []');
    write('domain/native.yml', 'type: model\nname: native');
    write('package.json', '{"name":"example","type":"module"}');
    expect(kinds(scanProject(root))).toEqual([
      ['domain/another.yaml', 'ossie'],
      ['domain/native.yml', 'model'],
      ['domain/semantic.json', 'ossie'],
    ]);
  });

  it('marks oversized Ossie files as blocking by content', () => {
    write(
      'domain/semantic.json',
      '{"name":"orders","version":"0.2.0.dev0","datasets":[]}' + ' '.repeat(200)
    );
    expect(scanProject(root, { maxFileBytes: 100 }).issues).toMatchObject([
      { code: 'file_too_large', kind: 'ossie' },
    ]);
  });
});
