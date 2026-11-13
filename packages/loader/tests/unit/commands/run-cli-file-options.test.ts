import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { buildConfigInput } from '../../../src/commands/run-cli.js';
import { registerRunCommand } from '../../../src/commands/run.js';
import type { LoaderConfig } from '../../../src/schemas/config.js';

const destinations = [
  { dest: 'local', extra: [] as string[] },
  { dest: 'gcs', extra: ['--gcs-bucket', 'example-bucket'] },
  { dest: 's3', extra: ['--s3-bucket', 'example-bucket'] },
];

async function runWith(args: string[]): Promise<{ config?: LoaderConfig; error?: unknown }> {
  let config: LoaderConfig | undefined;
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, async (received) => {
    config = received;
  });
  try {
    await program.parseAsync(['node', 'dogsled load', 'run', ...args]);
  } catch (error) {
    return { error };
  }
  return { config };
}

async function runRejected(args: string[]): Promise<{ stderr: string; exitCode: unknown }> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    const { config } = await runWith(args);
    expect(config).toBeUndefined();
    return { stderr: written.join(''), exitCode: process.exitCode };
  } finally {
    spy.mockRestore();
  }
}

describe('file destination CLI options', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each(destinations)(
    'passes --stream-subfolder into the $dest config',
    async ({ dest, extra }) => {
      const { config, error } = await runWith([
        '--dest',
        dest,
        '--format',
        'parquet',
        ...extra,
        '--stream-subfolder',
        'data/20261120T050007Z-9f3a1c2b/',
      ]);

      expect(error).toBeUndefined();
      expect(config).toMatchObject({
        dest,
        streamSubfolder: 'data/20261120T050007Z-9f3a1c2b',
      });
    }
  );

  it.each(destinations)('leaves the option unset for $dest by default', async ({ dest, extra }) => {
    const { config, error } = await runWith(['--dest', dest, '--format', 'parquet', ...extra]);

    expect(error).toBeUndefined();
    expect(config?.dest).toBe(dest);
    expect(config?.['streamSubfolder' as keyof LoaderConfig]).toBeUndefined();
  });

  it('rejects a subfolder that leaves the stream folder', async () => {
    const { stderr, exitCode } = await runRejected([
      '--dest',
      's3',
      '--format',
      'parquet',
      '--s3-bucket',
      'example-bucket',
      '--stream-subfolder',
      '../escape',
    ]);

    expect(stderr).toContain('streamSubfolder');
    expect(exitCode).toBe(2);
  });

  it('builds config input with the key for the local destination', () => {
    expect(
      buildConfigInput({
        dest: 'local',
        format: 'parquet',
        outputDir: './out',
        streamSubfolder: 'data/run-1',
      })
    ).toMatchObject({ dest: 'local', streamSubfolder: 'data/run-1' });
  });
});
