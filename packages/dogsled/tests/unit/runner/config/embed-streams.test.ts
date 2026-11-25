import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { validateProjectPipelines } from '../../../../src/runner/config/project-resolver.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const INTEGRATION = `spec_version: '1'
type: integration
name: files
source_type: local
connection:
  base_directory: data
auth:
  type: none
`;

function documentResource(name: string, source = 'format: document'): string {
  return `spec_version: '1'
type: resource
name: ${name}
integration: files
source:
  path: ${name}/*.md
${source.replace(/^/gm, '  ')}
replication:
  method: full_refresh
output:
  document_id: { type: string }
`;
}

const TABLE_RESOURCE = `spec_version: '1'
type: resource
name: events
integration: files
source:
  path: events/*.csv
  format: csv
replication:
  method: full_refresh
output:
  note: { type: string }
`;

interface Project {
  resources?: Record<string, string>;
  selected?: string[];
  streams?: Record<string, unknown>;
  embed?: string;
  enabled?: boolean;
}

function makeProject(project: Project): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-embed-streams-'));
  tempDirs.push(root);
  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  write('integrations/files.yml', INTEGRATION);
  const resources = project.resources ?? { docs: documentResource('docs') };
  for (const [file, body] of Object.entries(resources)) write(`resources/files/${file}.yml`, body);
  const embed = project.streams
    ? `    embed:
      provider: openai
      model: text-embedding-3-small
      api_key: $OPENAI_API_KEY
      streams: ${JSON.stringify(project.streams)}
`
    : (project.embed ?? '');
  write(
    'dogsled.yml',
    `destinations:
  local:
    type: duckdb
    db_path: ./out.duckdb
pipelines:
  documents:
    schedule: manual
    source: files
    destination: local
    enabled: ${project.enabled ?? true}
    resources: [${(project.selected ?? Object.keys(resources)).join(', ')}]
${embed}`
  );
  return root;
}

async function validate(project: Project) {
  const result = await validateProjectPipelines({ projectRoot: makeProject(project) });
  return {
    issues: result.issues.map(({ path: issuePath, message }) => `${issuePath}: ${message}`),
    warnings: result.warnings,
    embed:
      result.status === 'valid' ? result.project.extractPipelines[0]?.embed?.streams : undefined,
  };
}

describe('embed streams of a document Resource', () => {
  it.each([
    ['format: document', 'format: document'],
    ['kind: document', 'kind: document'],
    ['both', 'kind: document\nformat: document'],
  ])('accepts the Resource name and its text (%s), without a warning', async (_label, source) => {
    const result = await validate({
      resources: { docs: documentResource('docs', source) },
      streams: { docs: [{ field: 'text' }] },
    });
    expect(result).toEqual({
      issues: [],
      warnings: [],
      // The authored block is unchanged; a run resolves it.
      embed: { docs: [{ field: 'text' }] },
    });
  });

  it('accepts another output name', async () => {
    const result = await validate({ streams: { docs: [{ field: 'text', as: 'vector' }] } });
    expect(result.issues).toEqual([]);
  });

  it.each(['body', 'chunk_id', 'document_id', 'text_embedding'])(
    'rejects the field %s',
    async (field) => {
      const { issues } = await validate({ streams: { docs: [{ field: 'text' }, { field }] } });
      expect(issues).toEqual([
        `dogsled.yml:pipelines.documents.embed.streams.docs.${field}: resource "docs" is a ` +
          `document Resource, so only the "text" of its chunks can be embedded, not "${field}"`,
      ]);
    }
  );

  it('keeps accepting the exact chunk stream, but not next to the Resource name', async () => {
    const chunks = [{ field: 'text' }];
    expect((await validate({ streams: { docs__chunks: chunks } })).issues).toEqual([]);
    expect((await validate({ streams: { docs__chunks: chunks, docs: chunks } })).issues).toEqual([
      'dogsled.yml:pipelines.documents.embed.streams.docs: another key already embeds stream ' +
        '"docs__chunks"',
    ]);
  });

  it('leaves a Resource that is not a document alone', async () => {
    const result = await validate({
      resources: { docs: documentResource('docs'), events: TABLE_RESOURCE },
      streams: { events: [{ field: 'anything' }], docs: [{ field: 'text' }] },
    });
    expect(result.issues).toEqual([]);
  });

  it('checks only Resources the pipeline selects, and skips a disabled pipeline', async () => {
    const streams = { docs: [{ field: 'body' }] };
    const unselected = await validate({
      resources: { docs: documentResource('docs'), events: TABLE_RESOURCE },
      selected: ['events'],
      streams,
    });
    expect(unselected.issues).toEqual([]);
    expect((await validate({ streams, enabled: false })).issues).toEqual([]);
  });

  it('accepts a host-supplied model in a project', async () => {
    const embed = `    embed:
      provider: host
      dimension: 1024
      streams:
        docs: [{ field: text }]
`;
    expect((await validate({ embed })).issues).toEqual([]);
    const withModel = embed.replace('dimension: 1024', 'model: acme-embed-1');
    expect((await validate({ embed: withModel })).issues).toEqual([
      expect.stringContaining('the host application supplies the model'),
    ]);
  });

  it.each(['DOGSLED_HOST_EMBEDDING_URL', 'DOGSLED_HOST_EMBEDDING_TOKEN'])(
    'lets no project or host declare %s',
    async (name) => {
      const embed = `    embed:
      provider: host
      auth_env_vars: [${name}]
      streams:
        docs: [{ field: text }]
`;
      expect((await validate({ embed })).issues).toEqual([expect.stringContaining('reserved')]);
      await expect(
        validateProjectPipelines({ projectRoot: makeProject({}), declaredEnvNames: [name] })
      ).rejects.toThrow(/^declaredEnvNames: .* reserved/);
    }
  );
});

describe('a Resource-level embedding block', () => {
  const withEmbedding = documentResource(
    'docs',
    'format: document\nembedding: { role: default_embedding_v1 }'
  );

  it('is accepted, with a warning that nothing reads it', async () => {
    const { issues, warnings } = await validate({ resources: { docs: withEmbedding } });
    expect(issues).toEqual([]);
    expect(warnings).toEqual([
      'Pipeline "documents": source.embedding on resource "docs" has no effect; ' +
        "use the pipeline's embed block.",
    ]);
  });

  it('warns next to an embed block too, and once for each Resource', async () => {
    const { warnings } = await validate({
      resources: {
        docs: withEmbedding,
        notes: withEmbedding.replace('name: docs', 'name: notes'),
        plain: documentResource('plain'),
      },
      streams: { docs: [{ field: 'text' }] },
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"docs"');
    expect(warnings[1]).toContain('"notes"');
  });
});

describe('the s3-documents-ingestion example', () => {
  const example = fileURLToPath(
    new URL('../../../../examples/s3-documents-ingestion', import.meta.url)
  );

  it('is valid, and stays valid with its embed blocks uncommented', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-embed-example-'));
    tempDirs.push(root);
    fs.cpSync(example, root, { recursive: true });
    const config = path.join(root, 'dogsled.yml');
    const commented = fs.readFileSync(config, 'utf8');

    for (const body of [commented, commented.replace(/^    # (?=embed:|  )/gm, '    ')]) {
      fs.writeFileSync(config, body);
      const result = await validateProjectPipelines({ projectRoot: root });
      expect(result).toMatchObject({ status: 'valid', warnings: [], issues: [] });
      const embeds =
        result.status === 'valid'
          ? result.project.extractPipelines.map(({ embed }) => embed?.streams)
          : [];
      const streams = body === commented ? undefined : { documents: [{ field: 'text' }] };
      expect(embeds).toEqual([streams, streams]);
    }
  });
});
