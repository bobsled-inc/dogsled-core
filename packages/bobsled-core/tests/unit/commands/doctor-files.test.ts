import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkProjectFiles, servingCheckName } from '../../../src/commands/doctor.js';

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-doctor-files-')));
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

describe('checkProjectFiles', () => {
  it('counts recognized files when the project has no problems', () => {
    const root = project({
      'bobsled.yml': 'pipelines: {}\n',
      'models/orders.yml': 'spec_version: "0.2"\ntype: model\nname: orders\n',
    });

    expect(checkProjectFiles(root)).toEqual([
      { name: 'project.files', status: 'ok', message: '2 project files recognized' },
    ]);
  });

  it('warns about skipped files and errors on problems that stop Bobsled Core', () => {
    const root = project({
      'bobsled.yml': 'pipelines: {}\n',
      'docs/post.md': '---\ntype: page\n---\nBody\n',
      'models/typo.yml': 'type: modle\nname: typo\n',
    });

    expect(checkProjectFiles(root)).toEqual([
      {
        name: 'project.files',
        status: 'error',
        message: expect.stringContaining('models/typo.yml: Unknown type "modle"'),
      },
      {
        name: 'project.files.skipped',
        status: 'warn',
        message: expect.stringMatching(
          /^Bobsled Core skipped 1 file: docs\/post\.md: Unknown front matter type "page"/
        ),
      },
    ]);
  });
});

describe('servingCheckName', () => {
  it('names MCP and SDK checks without an internal namespace', () => {
    expect(servingCheckName('mcp_unfiltered_in_production')).toBe('mcp.unfiltered_in_production');
    expect(servingCheckName('sdk_stale')).toBe('sdk.stale');
  });
});
