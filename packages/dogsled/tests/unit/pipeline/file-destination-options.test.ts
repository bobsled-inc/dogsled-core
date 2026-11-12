import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { runProjectPipeline } from '../../../src/pipeline/index.js';

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

const GCS_LANDING = `  archive:
    type: gcs
    bucket: example-archive
    prefix: archive/
    format: parquet
`;

function makeProject(destinations: string, destinationNames: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-file-dest-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'integrations'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(
    path.join(root, 'integrations/custom.yml'),
    `spec_version: '1'
type: integration
name: custom
transport:
  type: http
  base_url: https://api.example.com
  auth:
    type: bearer
    token: \${{ env.HOST_SOURCE_TOKEN }}
`
  );
  fs.writeFileSync(
    path.join(root, 'resources/items.yml'),
    `spec_version: '1'
type: resource
name: items
integration: custom
description: Items
api:
  endpoint: /items
  method: GET
input: {}
output:
  id: { type: integer, path: $.id }
  name: { type: string, path: $.name }
extract:
  record_path: $
  table:
    primary_key: [id]
`
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
  items:
    schedule: manual
    source: custom
    ${destination}
    resources: [items]
`
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

async function loaderArgs(
  projectRoot: string
): Promise<{ extractorCalls: number; loaders: string[][] }> {
  const loaders: string[][] = [];
  let extractorCalls = 0;
  const result = await runProjectPipeline(
    {
      projectRoot,
      pipelineName: 'items',
      quiet: true,
      env: { HOST_SOURCE_TOKEN: 'synthetic-token' },
      declaredEnvNames: ['HOST_SOURCE_TOKEN'],
    },
    {
      spawn: (_command, args) => {
        if (args.includes('--integration')) {
          extractorCalls += 1;
          return fakeChild(false);
        }
        loaders.push([...args]);
        return fakeChild(true);
      },
    }
  );
  expect(result).toMatchObject({ exitCode: 0 });
  return { extractorCalls, loaders };
}

const within = (args: readonly string[], from: string, to: string) =>
  args.slice(args.indexOf(from), args.indexOf(to));

describe('file destination options through runProjectPipeline', () => {
  it('passes both options to the loader for a single destination', async () => {
    const projectRoot = makeProject(
      `${S3_LANDING}    stream_subfolder: data/20261120T050007Z-9f3a1c2b\n    utc_timestamps: true\n`,
      ['landing']
    );

    const { extractorCalls, loaders } = await loaderArgs(projectRoot);

    expect(extractorCalls).toBe(1);
    expect(loaders).toHaveLength(1);
    expect(within(loaders[0]!, '--format', '--log-format')).toEqual([
      '--format',
      'parquet',
      '--dest',
      's3',
      '--s3-bucket',
      'example-bucket',
      '--s3-prefix',
      'landing/',
      '--stream-subfolder',
      'data/20261120T050007Z-9f3a1c2b',
      '--utc-timestamps',
      '--table-prefix',
      'items__',
    ]);
  });

  it('passes both options to every loader of a fan-out', async () => {
    const projectRoot = makeProject(
      `${S3_LANDING}    stream_subfolder: data/run-1\n    utc_timestamps: true\n${GCS_LANDING}    stream_subfolder: data/run-1\n`,
      ['landing', 'archive']
    );

    const { loaders } = await loaderArgs(projectRoot);

    expect(loaders).toHaveLength(2);
    const byDestination = new Map(loaders.map((args) => [args[args.indexOf('--dest') + 1], args]));
    expect(byDestination.get('s3')).toEqual(
      expect.arrayContaining(['--stream-subfolder', 'data/run-1', '--utc-timestamps'])
    );
    expect(byDestination.get('gcs')).toEqual(
      expect.arrayContaining(['--stream-subfolder', 'data/run-1'])
    );
    expect(byDestination.get('gcs')).not.toContain('--utc-timestamps');
  });

  it.each([
    ['single destination', S3_LANDING, ['landing']],
    ['fan-out', `${S3_LANDING}${GCS_LANDING}`, ['landing', 'archive']],
  ])('adds no argument for a %s that sets neither option', async (_name, destinations, names) => {
    const projectRoot = makeProject(destinations, names);

    const { loaders } = await loaderArgs(projectRoot);

    for (const args of loaders) {
      expect(args).not.toContain('--stream-subfolder');
      expect(args).not.toContain('--utc-timestamps');
    }
    const s3 = loaders.find((args) => args.includes('s3'))!;
    expect(s3.slice(s3.indexOf('--dest'))).toEqual(
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

  it('leaves an unset single destination argument list exactly as it was', async () => {
    const projectRoot = makeProject(S3_LANDING, ['landing']);

    const { loaders } = await loaderArgs(projectRoot);

    expect(within(loaders[0]!, '--format', '--log-format')).toEqual([
      '--format',
      'parquet',
      '--dest',
      's3',
      '--s3-bucket',
      'example-bucket',
      '--s3-prefix',
      'landing/',
      '--table-prefix',
      'items__',
    ]);
  });
});
