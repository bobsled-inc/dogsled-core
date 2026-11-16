import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadApiResourceEntries,
  sourceNameOf,
  type ApiResourceEntry,
} from '../../../src/runtime/source-materializer/load-specs.js';

const roots: string[] = [];

/** A project on disk holding `files`, keyed by project-relative path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bobsled-load-specs-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), content);
  }
  return root;
}

describe('loadApiResourceEntries', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('loads api_resource source entries from sources/*.yml', async () => {
    const root = project({
      'sources/issues.yml': `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
destination: { schema: sources_raw }
schema:
  columns:
    - { name: id, type: INTEGER }
`,
      'sources/raw.yml': `spec_version: '0.2'
name: raw
type: source
source_type: warehouse_table
connection: ecom
table: RAW.X
schema:
  columns:
    - { name: ID, type: NUMBER }
`,
    });

    const entries = await loadApiResourceEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        kind: 'api_resource',
        fqRef: 'sources.issues',
        mode: 'live',
        destination: { schema: 'sources_raw' },
      })
    );
  });

  it('accepts deprecated mode: cache as lazy and emits a warning', async () => {
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const root = project({
      'sources/issues.yml': `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: cache
schema:
  columns:
    - { name: id, type: INTEGER }
`,
    });

    const entries = await loadApiResourceEntries(root);

    expect(entries[0]?.mode).toBe('lazy');
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('mode: cache'),
      expect.objectContaining({ code: 'BOBSLED_CORE_SOURCE_MODE_CACHE_DEPRECATED' })
    );
    warningSpy.mockRestore();
  });

  it('propagates refresh config from source specs', async () => {
    const root = project({
      'sources/issues.yml': `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: extract
refresh:
  strategy: merge
  cursor_field: updated_at
  primary_key: id
schema:
  columns:
    - { name: id, type: INTEGER }
`,
    });

    const entries = await loadApiResourceEntries(root);

    expect(entries[0]).toEqual(
      expect.objectContaining({
        mode: 'extract',
        refresh: {
          strategy: 'merge',
          cursor_field: 'updated_at',
          primary_key: 'id',
        },
      })
    );
  });

  it('keeps duplicate api_resource names distinct by qualified source identity', async () => {
    const sourceBody = (connection: string) => `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: ${connection}
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`;
    const root = project({
      'sources/prod/issues.yml': sourceBody('github_prod'),
      'sources/stage/issues.yml': sourceBody('github_stage'),
    });

    const entries = await loadApiResourceEntries(root);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.sourceRef).sort()).toEqual([
      'github_prod.issues',
      'github_stage.issues',
    ]);
    expect(new Set(entries.map((entry) => entry.fqRef)).size).toBe(2);
  });

  it('finds api_resource sources in any folder by their declared type', async () => {
    const root = project({
      'github/issues/source.yml': `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
schema:
  columns:
    - { name: id, type: INTEGER }
`,
    });

    const entries = await loadApiResourceEntries(root);
    expect(entries.map((entry) => entry.sourceRef)).toEqual(['github_prod.issues']);
  });

  it('rejects empty source names in malformed api_resource fqRefs', () => {
    expect(() => sourceNameOf({ fqRef: 'sources.' } as ApiResourceEntry)).toThrow(CommandError);
    expect(() => sourceNameOf({ fqRef: 'sources.' } as ApiResourceEntry)).toThrow(
      /missing source name/
    );
  });

  it('rejects fqRefs without the sources. prefix', () => {
    expect(() => sourceNameOf({ fqRef: 'invalid.foo' } as ApiResourceEntry)).toThrow(CommandError);
    expect(() => sourceNameOf({ fqRef: 'invalid.foo' } as ApiResourceEntry)).toThrow(
      /Invalid source fqRef/
    );
  });

  it('trims source names before returning them', () => {
    expect(sourceNameOf({ fqRef: 'sources.  issues  ' } as ApiResourceEntry)).toBe('issues');
  });
});
