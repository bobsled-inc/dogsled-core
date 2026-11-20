import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { formatZodIssues } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { loadResourceSpecWithWarnings } from '../../src/commands/common.js';

import { FileCopyResourceSpecSchema } from '../../src/framework/extractor/file-copy-resource.js';
import { ResourceSpecSchema } from '../../src/framework/extractor/resource.js';

const copyResource = {
  spec_version: '1',
  type: 'resource',
  name: 'drops',
  integration: 'landing',
  source: { kind: 'copy', path: 'incoming/**/*' },
  replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
};

function messages(spec: unknown): string[] {
  const result = FileCopyResourceSpecSchema.safeParse(spec);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('copy resource schema', () => {
  it('parses a path with an incremental last_modified replication', () => {
    const spec = ResourceSpecSchema.parse(copyResource);
    expect(spec).toMatchObject({ source: { kind: 'copy', path: 'incoming/**/*' } });
  });

  it('takes a lookback and the file limits', () => {
    const spec = FileCopyResourceSpecSchema.parse({
      ...copyResource,
      replication: {
        method: 'incremental_append',
        cursor: { field: 'last_modified', lookback_seconds: 7200 },
      },
      limits: { max_file_size_bytes: 1024, max_files_per_run: 5 },
    });
    expect(spec.replication.cursor.lookback_seconds).toBe(7200);
    expect(spec.limits?.max_files_per_run).toBe(5);
  });

  it.each(['format', 'compression', 'options', 'include_filename', 'include_file_metadata'])(
    'refuses source.%s with a plain message',
    (field) => {
      const value = field === 'options' ? { header: true } : 'x';
      expect(
        messages({ ...copyResource, source: { ...copyResource.source, [field]: value } })
      ).toEqual([`source.${field} is not allowed for a copy: it moves files as they are`]);
    }
  );

  it('refuses output with a plain message', () => {
    expect(messages({ ...copyResource, output: { id: { type: 'string' } } })).toEqual([
      'output is not allowed for a copy: it has no columns',
    ]);
  });

  it.each([
    [
      'a full refresh',
      { method: 'full_refresh', cursor: { field: 'last_modified' } },
      'replication.method must be incremental_append for a copy',
    ],
    [
      'an etag cursor',
      { method: 'incremental_append', cursor: { field: 'etag' } },
      'replication.cursor.field must be last_modified for a copy',
    ],
    ['no cursor', { method: 'incremental_append' }, 'replication.cursor is required for a copy'],
    [
      'a negative lookback',
      { method: 'incremental_append', cursor: { field: 'last_modified', lookback_seconds: -1 } },
      'replication.cursor.lookback_seconds must be zero or more',
    ],
  ])('refuses %s', (_label, replication, message) => {
    expect(messages({ ...copyResource, replication })).toEqual([message]);
  });

  it.each(['../secrets/*', '/etc/*'])('refuses the path %s', (path) => {
    expect(messages({ ...copyResource, source: { kind: 'copy', path } })).toHaveLength(1);
  });
});

describe('copy Resources and the Resource kinds around them', () => {
  it('lets a spec that is not a copy fail only on a marker, so its own errors are shown', () => {
    const structured = {
      ...copyResource,
      source: { path: 'exports/*.csv', format: 'csv' },
      output: { id: { type: 'string' } },
    };

    const result = FileCopyResourceSpecSchema.safeParse(structured);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([{ code: 'custom', path: ['type'] }]);

    // The error a person reads for a mistake in a structured Resource never mentions a copy.
    const shown = ResourceSpecSchema.safeParse({ ...structured, replication: { method: 'nope' } });
    expect(shown.success).toBe(false);
    expect(formatZodIssues(shown.error!, { schema: ResourceSpecSchema })).not.toMatch(/copy/);
  });

  it.each([
    ['a wrong spec_version', { spec_version: '2' }],
    ['an unquoted spec_version', { spec_version: 1 }],
  ])('names the mistake in a Resource that is not a copy: %s', (_label, mistake) => {
    const structured = {
      ...copyResource,
      source: { path: 'exports/*.csv', format: 'csv' },
      output: { id: { type: 'string' } },
      ...mistake,
    };

    const result = ResourceSpecSchema.safeParse(structured);

    expect(result.success).toBe(false);
    const shown = formatZodIssues(result.error!, { schema: ResourceSpecSchema });
    expect(shown).toContain('spec_version');
    expect(shown).not.toMatch(/not a copy/);
  });

  it('reports the plain messages when a copy Resource file is loaded', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'copy-spec-'));
    try {
      const write = (name: string, yaml: string): string => {
        const file = path.join(dir, name);
        writeFileSync(file, yaml);
        return file;
      };
      const head = "spec_version: '1'\ntype: resource\nname: drops\nintegration: files\n";
      const good = write(
        'good.yml',
        `${head}source: { kind: copy, path: 'in/**/*' }\nreplication: { method: incremental_append, cursor: { field: last_modified } }\n`
      );
      const bad = write(
        'bad.yml',
        `${head}source: { kind: copy, path: 'in/**/*', format: csv }\nreplication: { method: full_refresh }\noutput: { id: { type: string } }\n`
      );

      expect(loadResourceSpecWithWarnings(good).spec).toMatchObject({ source: { kind: 'copy' } });
      expect(() => loadResourceSpecWithWarnings(bad)).toThrow(
        /source\.format is not allowed for a copy[^]*replication\.method must be incremental_append for a copy[^]*output is not allowed for a copy/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
