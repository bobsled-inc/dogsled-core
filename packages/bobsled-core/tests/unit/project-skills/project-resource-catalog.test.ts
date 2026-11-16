import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProjectIndexError } from '@bobsled-inc/project-index';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openBobsledProject,
  projectResourceIssues,
} from '../../../src/runner/config/project-files.js';
import { discoverProjectResourceNames } from '../../../src/runner/config/resolve-resource.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverProjectResourceNames', () => {
  it('names nested Resources by identity and by path, ignoring unrelated files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-resource-catalog-'));
    roots.push(root);
    const directory = path.join(root, 'resources', 'product', 'admin');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'users.yml'), 'type: resource\nname: users\n');
    writeFileSync(path.join(directory, 'notes.txt'), 'not a resource');

    expect(discoverProjectResourceNames(openBobsledProject(root))).toEqual([
      'product/admin/users',
      'product/users',
    ]);
  });

  it('names Resources outside resources/ by their declared integration', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-resource-catalog-'));
    roots.push(root);
    mkdirSync(path.join(root, 'crm', 'hubspot'), { recursive: true });
    writeFileSync(
      path.join(root, 'crm', 'hubspot', 'contacts.yml'),
      'type: resource\nintegration: hubspot\nname: contacts\n'
    );

    expect(discoverProjectResourceNames(openBobsledProject(root))).toEqual(['hubspot/contacts']);
  });

  it('owns untyped-integration Resources by the extractor resources folder', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-resource-catalog-'));
    roots.push(root);
    writeFileSync(path.join(root, 'extractor.yml'), 'resources_dir: data/resources\n');
    mkdirSync(path.join(root, 'data', 'resources', 'stripe'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'resources', 'stripe', 'charges.yml'),
      'type: resource\nname: charges\n'
    );

    const project = openBobsledProject(root);
    expect(project.resourcesFolder).toBe('data/resources');
    expect(discoverProjectResourceNames(project)).toEqual(['stripe/charges']);
    expect(projectResourceIssues(project)).toEqual([]);
  });

  it('refuses a linked Resource instead of following or skipping it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-resource-catalog-'));
    roots.push(root);
    const directory = path.join(root, 'resources', 'product');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'users.yml'), 'type: resource\nname: users\n');
    symlinkSync(path.join(directory, 'users.yml'), path.join(directory, 'linked.yml'));

    expect(() => openBobsledProject(root)).toThrow(ProjectIndexError);
    expect(() => openBobsledProject(root)).toThrow(
      /resources\/product\/linked\.yml: Dogsled does not follow symbolic links\./
    );
  });
});
