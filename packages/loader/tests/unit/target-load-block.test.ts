import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTargetFile } from '../../src/runtime/target-loader.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'loader-load-block-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function load(value: unknown) {
  const filename = path.join(directory, 'load.yml');
  await writeFile(filename, JSON.stringify(value));
  return loadTargetFile(filename);
}

describe('standalone bare load blocks', () => {
  it('accepts the documented integration, overrides and defaults shape', async () => {
    const block = {
      integration: 'warehouse',
      overrides: { schema: 'example_dataset' },
      defaults: { load_strategy: 'merge', buffer_size: 25 },
    };
    expect(await load(block)).toEqual({
      spec_version: '1',
      type: 'target',
      name: 'inline_load',
      ...block,
    });
  });
  it('accepts a bare integration reference', async () => {
    expect(await load({ integration: 'warehouse' })).toMatchObject({
      integration: 'warehouse',
      name: 'inline_load',
    });
  });
  it.each(['auth', 'connection', 'dataset', 'name'])(
    'rejects the unknown bare key %s without exposing its value',
    async (key) => {
      await expect(
        load({ integration: 'warehouse', [key]: 'synthetic-private-value' })
      ).rejects.toThrow(new RegExp(key));
      await expect(
        load({ integration: 'warehouse', [key]: 'synthetic-private-value' })
      ).rejects.not.toThrow(/synthetic-private-value/);
    }
  );
  it('rejects invalid nested overrides', async () => {
    await expect(
      load({ integration: 'warehouse', overrides: { dataset: 'example_dataset' } })
    ).rejects.toThrow(/dataset/);
  });
  it('still rejects incomplete typed targets', async () => {
    await expect(load({ type: 'target', integration: 'warehouse' })).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
