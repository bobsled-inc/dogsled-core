import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exampleNextSteps, makeScriptsExecutable } from '../../../src/commands/examples.js';

const directories: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-example-'));
  directories.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content, { mode: 0o644 });
  }
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('dogsled examples', () => {
  it('makes copied shell scripts executable, including nested ones', () => {
    const root = project({
      'walkthrough.sh': '#!/bin/sh\n',
      'scripts/run.sh': '',
      'README.md': '',
    });
    makeScriptsExecutable(root);
    expect(fs.statSync(path.join(root, 'walkthrough.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'README.md')).mode & 0o777).toBe(0o644);
  });

  it('suggests the walkthrough and model commands for an example that has them', () => {
    const root = project({
      'walkthrough.sh': '',
      'integrations/github.yml': '',
      'integrations/warehouse.yml': '',
      'models/orders.yml': '',
    });
    expect(exampleNextSteps(root, 'demo')).toEqual([
      'cd demo',
      "export GITHUB_TOKEN='<your-token>'",
      './walkthrough.sh',
      'dogsled model validate',
      'dogsled model compile -o ./compiled',
      'See README.md for the full walkthrough.',
    ]);
  });

  it('suggests extraction checks for an example without a walkthrough or models', () => {
    const root = project({ 'integrations/s3_documents.yml': '' });
    expect(exampleNextSteps(root, 'docs')).toEqual([
      'cd docs',
      "export S3_BUCKET='<your-bucket>'",
      'dogsled extract validate s3_documents',
      'See README.md for the full walkthrough.',
    ]);
  });
});
