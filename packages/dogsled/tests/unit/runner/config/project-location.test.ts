import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findDogsledProject,
  resolveDogsledProject,
  dogsledProjectForConfig,
} from '../../../../src/runner/config/loader.js';
import { resolveCliDogsledProject } from '../../../../src/runner/config/cli-project-location.js';

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-location-')));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('findDogsledProject', () => {
  it('walks up to the nearest root dogsled.yml', () => {
    const root = project({ 'dogsled.yml': 'pipelines: {}\n', 'crm/hubspot/notes.md': '# Notes\n' });

    expect(findDogsledProject(path.join(root, 'crm', 'hubspot'))).toEqual({
      projectRoot: root,
      configPaths: [path.join(root, 'dogsled.yml')],
      index: expect.objectContaining({ root, issues: [] }),
    });
  });

  it('finds a moved pipeline configuration from the project root', () => {
    const root = project({ 'settings/pipelines.yml': 'type: pipeline_config\npipelines: {}\n' });

    expect(findDogsledProject(root)).toEqual({
      projectRoot: root,
      configPaths: [path.join(root, 'settings', 'pipelines.yml')],
      index: expect.objectContaining({ root, issues: [] }),
    });
  });

  it('returns null for a directory that does not exist', () => {
    const root = project({});

    expect(findDogsledProject(path.join(root, 'missing'))).toBeNull();
  });

  it('locates a Project that has no pipeline configuration', () => {
    const root = project({ 'models/orders.yml': 'type: model\nname: orders\n' });

    expect(findDogsledProject(root)).toEqual({
      projectRoot: root,
      configPaths: [],
      index: expect.objectContaining({ root, issues: [] }),
    });
  });
});

describe('dogsledProjectForConfig', () => {
  it('uses the directory of an untyped configuration', () => {
    const root = project({ 'nested/dogsled.yml': 'pipelines: {}\n' });

    expect(dogsledProjectForConfig('nested/dogsled.yml', root)).toEqual({
      projectRoot: path.join(root, 'nested'),
      configPaths: [path.join(root, 'nested', 'dogsled.yml')],
    });
  });

  it('uses the caller Project root for a typed nested dogsled.yml', () => {
    const root = project({ 'nested/dogsled.yml': 'type: pipeline_config\npipelines: {}\n' });

    expect(dogsledProjectForConfig('nested/dogsled.yml', root)).toEqual({
      projectRoot: root,
      configPaths: [path.join(root, 'nested', 'dogsled.yml')],
    });
  });

  it('uses the working directory for a moved configuration inside it', () => {
    const root = project({ 'settings/pipelines.yml': 'type: pipeline_config\npipelines: {}\n' });

    expect(dogsledProjectForConfig('settings/pipelines.yml', root)).toEqual({
      projectRoot: root,
      configPaths: [path.join(root, 'settings', 'pipelines.yml')],
    });
  });

  it('uses the directory of a moved configuration outside the working directory', () => {
    const root = project({ 'settings/pipelines.yml': 'type: pipeline_config\npipelines: {}\n' });
    const elsewhere = project({});
    const configPath = path.join(root, 'settings', 'pipelines.yml');

    expect(dogsledProjectForConfig(configPath, elsewhere)).toEqual({
      projectRoot: path.join(root, 'settings'),
      configPaths: [configPath],
    });
  });
});

describe('resolveDogsledProject', () => {
  it('discovers the project from the working directory without --config', () => {
    const root = project({ 'dogsled.yml': 'pipelines: {}\n' });

    expect(resolveDogsledProject(undefined, root)?.projectRoot).toBe(root);
  });

  it('resolves an explicit --config relative to the working directory', () => {
    const root = project({ 'settings/pipelines.yml': 'type: pipeline_config\npipelines: {}\n' });

    expect(resolveDogsledProject('settings/pipelines.yml', root)?.projectRoot).toBe(root);
  });

  it('keeps explicit single-file mode rooted above a nested dogsled.yml', () => {
    const root = project({ 'golf/dogsled.yml': 'type: pipeline_config\npipelines: {}\n' });

    expect(resolveDogsledProject('golf/dogsled.yml', root)).toMatchObject({
      projectRoot: root,
      configPaths: [path.join(root, 'golf', 'dogsled.yml')],
    });
  });
});

describe('resolveCliDogsledProject', () => {
  it('uses cwd as the default root instead of finding an ancestor Project', () => {
    const parent = project({
      'dogsled.yml': 'pipelines: {}\n',
      'nested/models/orders.yml': 'type: model\nname: orders\n',
    });
    const cwd = path.join(parent, 'nested');

    expect(resolveCliDogsledProject({ cwd })).toMatchObject({
      projectRoot: cwd,
      configPaths: [],
      index: expect.objectContaining({ root: cwd }),
    });
  });

  it('recognizes a configless Project at cwd', () => {
    const root = project({ 'golf/datagolf/pga/metrics/wins.yml': 'type: metric\nname: wins\n' });

    expect(resolveCliDogsledProject({ cwd: root })).toMatchObject({
      projectRoot: root,
      configPaths: [],
      index: expect.objectContaining({ root }),
    });
  });

  it('uses an explicit root and keeps explicit config single-file semantics', () => {
    const root = project({
      'settings/one.yml': 'type: pipeline_config\npipelines: {}\n',
      'settings/two.yml': 'type: pipeline_config\npipelines: {}\n',
    });

    expect(resolveCliDogsledProject({ projectRoot: root, configPath: 'settings/one.yml' })).toEqual(
      {
        projectRoot: root,
        configPaths: [path.join(root, 'settings', 'one.yml')],
        index: expect.objectContaining({ root }),
      }
    );
  });

  it('rejects config paths outside an explicit root', () => {
    const root = project({});
    expect(() =>
      resolveCliDogsledProject({ projectRoot: root, configPath: '../outside/dogsled.yml' })
    ).toThrow('configPath must live inside projectRoot.');
  });

  it('rejects config symlinks that leave an explicit root', () => {
    const root = project({ 'settings/placeholder.yml': 'type: pipeline_config\n' });
    const outside = project({ 'outside.yml': 'type: pipeline_config\n' });
    const link = path.join(root, 'settings', 'escape.yml');
    fs.unlinkSync(path.join(root, 'settings', 'placeholder.yml'));
    fs.symlinkSync(path.join(outside, 'outside.yml'), link);

    expect(() =>
      resolveCliDogsledProject({ projectRoot: root, configPath: 'settings/escape.yml' })
    ).toThrow('configPath must live inside projectRoot.');
  });

  it('preserves legacy explicit config behavior when no project root is supplied', () => {
    const root = project({ 'nested/dogsled.yml': 'pipelines: {}\n' });

    expect(resolveCliDogsledProject({ configPath: 'nested/dogsled.yml', cwd: root })).toMatchObject(
      {
        projectRoot: path.join(root, 'nested'),
        configPaths: [path.join(root, 'nested', 'dogsled.yml')],
      }
    );
  });
});
