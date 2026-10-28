import * as fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runScaffoldDocument } from '../../src/commands/scaffold-document.js';

const tempDirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'entity-graph-scaffold-document-'));
  tempDirs.push(dir);
  return dir;
}

describe('scaffold document', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('dry-runs proposed YAML without writing', async () => {
    const cwd = await tempProject();
    const payload = runScaffoldDocument('Document', {
      cwd,
      integration: 'local_docs',
      resource: 'support_docs',
      dryRun: true,
    });

    expect(payload.dry_run).toBe(true);
    expect(payload.created).toBe(false);
    expect(payload.spec).toContain('type: resolution');
    expect(fs.existsSync(payload.spec_path)).toBe(false);
  });

  it('writes through an atomic rename', async () => {
    const cwd = await tempProject();
    const payload = runScaffoldDocument('Document', {
      cwd,
      integration: 'local_docs',
      resource: 'support_docs',
    });

    expect(payload.created).toBe(true);
    await expect(readFile(payload.spec_path, 'utf-8')).resolves.toContain(
      'name: support_docs_document_resolution'
    );
    const leftovers = fs
      .readdirSync(path.dirname(payload.spec_path))
      .filter((entry) => entry.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('is idempotent when the existing scaffold content is unchanged', async () => {
    const cwd = await tempProject();
    const first = runScaffoldDocument('Document', {
      cwd,
      integration: 'local_docs',
      resource: 'support_docs',
    });
    const second = runScaffoldDocument('Document', {
      cwd,
      integration: 'local_docs',
      resource: 'support_docs',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.spec_path).toBe(first.spec_path);
  });
});
