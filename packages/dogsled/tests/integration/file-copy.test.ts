import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx/esm');
const cliEntry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** One of each kind of file a copy has to leave alone, including an empty file and a subfolder. */
const FIXTURES: Record<string, Buffer> = {
  'orders.csv': Buffer.from('id,name\n1,Ada\n2,Grace\n'),
  'orders.csv.gz': gzipSync('id,name\n1,Ada\n2,Grace\n'),
  'part.parquet': Buffer.from([
    0x50, 0x41, 0x52, 0x31, 0, 1, 2, 253, 254, 255, 0x50, 0x41, 0x52, 0x31,
  ]),
  'invoice.pdf': Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0,
  ]),
  'bundle.zip': Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 255, 0]),
  'empty.dat': Buffer.alloc(0),
  'deep/er/note.txt': Buffer.from('nested file'),
};

function makeProject(limits = ''): { project: string; source: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-file-copy-'));
  tempDirs.push(root);
  const project = path.join(root, 'project');
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  for (const dir of [
    project,
    source,
    path.join(project, 'integrations'),
    path.join(project, 'resources'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(project, 'integrations/files.yml'),
    `spec_version: '1'
type: integration
name: files
source_type: local
connection:
  base_directory: ${source}
auth:
  type: none
`
  );
  fs.writeFileSync(
    path.join(project, 'resources/drops.yml'),
    `spec_version: '1'
type: resource
name: drops
integration: files
source:
  kind: copy
  path: '**/*'
replication:
  method: incremental_append
  cursor: { field: last_modified }
${limits}`
  );
  return { project, source, output };
}

function writeFixtures(source: string, files: Record<string, Buffer>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), body);
  }
}

interface CliResult {
  exitCode: number;
  messages: Array<Record<string, unknown>>;
  stderr: string;
}

/** Run `dogsled pipeline`, which starts the real extractor and loader processes. */
function copyPipeline(
  project: string,
  output: string,
  destination: string[] = ['--dest', 'local', '--format', 'jsonl']
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        tsxLoader,
        cliEntry,
        'pipeline',
        '--integration',
        'files',
        '--resource',
        'drops',
        ...destination,
        '--output-dir',
        output,
      ],
      { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(90_000) }
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.resume();
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stderr,
        messages: stderr
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>];
            } catch {
              return [];
            }
          }),
      })
    );
  });
}

const drops = (result: CliResult, type: string) =>
  result.messages.filter((message) => message['type'] === type && message['stream'] === 'drops');

const listOutput = (output: string): string[] =>
  fs.existsSync(output)
    ? (fs.readdirSync(output, { recursive: true, withFileTypes: true }) as fs.Dirent[])
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)))
        .sort()
    : [];

describe('copy Resource through dogsled pipeline', () => {
  it('copies a mixed folder byte for byte, then only what is new or changed', async () => {
    const { project, source, output } = makeProject();
    writeFixtures(source, FIXTURES);

    const first = await copyPipeline(project, output);

    expect(first.exitCode, first.stderr).toBe(0);
    for (const [name, body] of Object.entries(FIXTURES)) {
      expect(sha256(fs.readFileSync(path.join(output, 'drops', name))), name).toBe(sha256(body));
    }
    const totalBytes = Object.values(FIXTURES).reduce((sum, body) => sum + body.length, 0);
    expect(drops(first, 'METRIC')).toHaveLength(1);
    expect(drops(first, 'METRIC')[0]?.['metrics']).toMatchObject({
      files_processed: 7,
      bytes_downloaded: totalBytes,
    });
    expect(first.stderr).toMatch(/Completed: files\/drops \(7 file\(s\), \d+ bytes copied\)/);

    const second = await copyPipeline(project, output);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(drops(second, 'METRIC')).toHaveLength(1);
    expect(drops(second, 'METRIC')[0]?.['metrics']).toMatchObject({
      files_processed: 0,
      bytes_downloaded: 0,
    });

    writeFixtures(source, {
      'orders.csv': Buffer.from('id,name\n1,Ada\n2,Grace\n3,Edsger\n'),
      'fresh.csv': Buffer.from('id\n9\n'),
    });
    const third = await copyPipeline(project, output);
    expect(third.exitCode, third.stderr).toBe(0);
    expect(drops(third, 'METRIC')[0]?.['metrics']).toMatchObject({ files_processed: 2 });
    expect(fs.readFileSync(path.join(output, 'drops/orders.csv'), 'utf8')).toContain('Edsger');
  }, 180_000);

  it('fails an oversize file by name, copies nothing and keeps its state', async () => {
    const { project, source, output } = makeProject('limits: { max_file_size_bytes: 10 }\n');
    writeFixtures(source, { 'small.txt': Buffer.from('tiny'), 'big.bin': Buffer.alloc(64, 7) });

    const result = await copyPipeline(project, output);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/big\.bin.*max_file_size_bytes/);
    expect(listOutput(output)).toEqual([]);
  }, 90_000);

  it('refuses a destinations list, instead of waiting for a loader that never reads', async () => {
    const { project, source, output } = makeProject();
    writeFixtures(source, { 'a.txt': Buffer.from('a') });

    const result = await copyPipeline(project, output, [
      '--destinations-json',
      JSON.stringify([{ name: 'archive', type: 'local', format: 'jsonl' }]),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('copies files, so it cannot run with --no-state-write');
    expect(listOutput(output)).toEqual([]);
  }, 90_000);

  it('stops, instead of waiting, when the loader refuses a file name', async () => {
    const { project, source, output } = makeProject();
    // A backslash is a legal file name here, but the destination would turn it into a folder.
    writeFixtures(source, {
      'plain.txt': Buffer.from('fine'),
      'odd\\name.txt': Buffer.from('odd'),
    });

    const result = await copyPipeline(project, output);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Refusing to copy');
    expect(listOutput(output)).not.toContain(path.join('drops', 'odd', 'name.txt'));
  }, 90_000);
});
