import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { runProjectPipeline } from '../../../src/pipeline/index.js';
import { loadDogsledConfig, validateDogsledConfig } from '../../../src/runner/config/loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const S3_LANDING = `  landing:
    type: s3
    bucket: example-bucket
    prefix: landing/
    format: parquet
`;

const DUCKDB_WAREHOUSE = `  warehouse:
    type: duckdb
    db_path: out.duckdb
`;

const GCS_ARCHIVE = `  archive:
    type: gcs
    bucket: example-archive
    prefix: archive/
    format: parquet
`;

const MANAGED_WAREHOUSE = `  warehouse:
    type: dogsled_managed
    dogsled_connection_ref: warehouse-prod
`;

function makeProject(
  destinations: string,
  destinationNames: string[],
  limits = '',
  pipelineExtras = ''
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-copy-dest-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'integrations'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(
    path.join(root, 'integrations/files.yml'),
    `spec_version: '1'
type: integration
name: files
source_type: local
connection:
  base_directory: data
auth:
  type: none
`
  );
  fs.writeFileSync(
    path.join(root, 'resources/drops.yml'),
    `spec_version: '1'
type: resource
name: drops
integration: files
source:
  kind: copy
  path: incoming/**/*
replication:
  method: incremental_append
  cursor: { field: last_modified }
${limits}`
  );
  const destination =
    destinationNames.length === 1
      ? `destination: ${destinationNames[0]}`
      : `destinations: [${destinationNames.join(', ')}]`;
  fs.writeFileSync(
    path.join(root, 'dogsled.yml'),
    `destinations:
${destinations}
pipelines:
  drops:
    schedule: manual
    source: files
    ${destination}
    resources: [drops]
${pipelineExtras}`
  );
  return root;
}

function fakeChild(consumesInput: boolean): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  stdin.resume();
  const finish = () => {
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    setImmediate(() => child.emit('close', 0, null));
  };
  if (consumesInput) stdin.on('end', finish);
  else setImmediate(finish);
  return child;
}

async function run(projectRoot: string) {
  const spawned: string[][] = [];
  const result = await runProjectPipeline(
    { projectRoot, pipelineName: 'drops', quiet: true },
    {
      spawn: (_command, args) => {
        spawned.push([...args]);
        return fakeChild(!args.includes('--integration'));
      },
    }
  );
  return { result, spawned };
}

const REFUSAL =
  'Resource "drops" copies files, so it needs one destination, not a list of destinations (landing, archive).';

describe('a copy Resource in a pipeline', () => {
  it('runs with one destination and hands the loader its destination arguments', async () => {
    const { result, spawned } = await run(makeProject(S3_LANDING, ['landing']));

    expect(result).toMatchObject({ exitCode: 0 });
    const loader = spawned.find((args) => !args.includes('--integration'))!;
    expect(loader).toEqual(
      expect.arrayContaining([
        '--dest',
        's3',
        '--s3-bucket',
        'example-bucket',
        '--s3-prefix',
        'landing/',
      ])
    );
  });

  it('is refused with several destinations, before any process starts', async () => {
    const projectRoot = makeProject(`${S3_LANDING}${GCS_ARCHIVE}`, ['landing', 'archive']);
    const spawned: string[][] = [];

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'drops', quiet: true },
        {
          spawn: (_command, args) => {
            spawned.push([...args]);
            return fakeChild(true);
          },
        }
      )
    ).rejects.toThrow(REFUSAL);
    expect(spawned).toEqual([]);
  });

  it('is refused when its largest file cannot go to S3 in one write, before any process starts', async () => {
    const projectRoot = makeProject(
      S3_LANDING,
      ['landing'],
      'limits: { max_file_size_bytes: 6000000000 }\n'
    );
    const spawned: string[][] = [];

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'drops', quiet: true },
        {
          spawn: (_command, args) => {
            spawned.push([...args]);
            return fakeChild(true);
          },
        }
      )
    ).rejects.toThrow(/allows files of up to 6000000000 bytes, but S3 takes at most 5368709120/);
    expect(spawned).toEqual([]);
  });

  it('is refused with a table destination, before any process starts', async () => {
    const projectRoot = makeProject(DUCKDB_WAREHOUSE, ['warehouse']);
    const spawned: string[][] = [];

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'drops', quiet: true },
        {
          spawn: (_command, args) => {
            spawned.push([...args]);
            return fakeChild(true);
          },
        }
      )
    ).rejects.toThrow(
      'Resource "drops" copies files, so its destination must be local, s3, gcs or dogsled_managed, but "warehouse" is duckdb.'
    );
    expect(spawned).toEqual([]);
  });
});

describe('validating a copy Resource with a managed destination', () => {
  // Dogsled Cloud validates a project before it turns a dogsled_managed destination into a
  // concrete one, so validation has to let a copy through there.
  const validate = async (projectRoot: string) =>
    validateDogsledConfig(loadDogsledConfig(path.join(projectRoot, 'dogsled.yml')), projectRoot);

  it('accepts a dogsled_managed destination on a managed runner', async () => {
    const projectRoot = makeProject(MANAGED_WAREHOUSE, ['warehouse'], '', '    runner: managed\n');

    const result = await validate(projectRoot);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('still refuses a concrete destination that cannot write a file', async () => {
    const projectRoot = makeProject(DUCKDB_WAREHOUSE, ['warehouse'], '', '    runner: managed\n');

    const result = await validate(projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        message:
          'Resource "drops" copies files, so its destination must be local, s3, gcs or dogsled_managed, but "warehouse" is duckdb.',
      })
    );
  });
});
