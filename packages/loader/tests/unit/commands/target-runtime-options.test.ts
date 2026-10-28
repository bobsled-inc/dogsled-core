import { Command } from 'commander';
import { registerRunCommand } from '../../../src/commands/run.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRunConfig } from '../../../src/commands/run-reconciliation.js';

const { resolveTargetConfig, runDryRun } = vi.hoisted(() => ({
  resolveTargetConfig: vi.fn(),
  runDryRun: vi.fn(),
}));
vi.mock('../../../src/commands/run-dry-run.js', () => ({ runDryRun }));
vi.mock('../../../src/runtime/target-loader.js', () => ({ resolveTargetConfig }));

const connections = [
  { dest: 'bigquery', projectId: 'example-project', datasetId: 'example_dataset' },
  {
    dest: 'snowflake',
    account: 'example-account',
    username: 'example_user',
    warehouse: 'EXAMPLE_WH',
    database: 'EXAMPLE_DB',
    targetSchema: 'EXAMPLE_SCHEMA',
  },
] as const;

beforeEach(() => {
  resolveTargetConfig.mockReset();
  runDryRun.mockReset();
});

describe('named destination runtime overrides', () => {
  for (const connection of connections) {
    describe(connection.dest, () => {
      it.each(['loadFile', 'loadIntegration'])(
        'preserves explicit runtime overrides with %s',
        async (mode) => {
          resolveTargetConfig.mockResolvedValue({
            ...connection,
            loadStrategy: 'merge',
            schemaBehavior: 'evolve',
            bufferSize: 5000,
            logFormat: 'json',
          });
          const config = await resolveRunConfig({
            [mode]: 'example',
            tablePrefix: 'oss_e2e_example_',
            loadStrategy: 'full_refresh',
            schemaBehavior: 'strict',
            bufferSize: '25',
            logFormat: 'text',
            maxConcurrentLoads: '2',
            checkpointDir: './checkpoints',
            maxBufferMemory: '16MB',
            streamLoadStrategy: { orders: 'append' },
            streamSchemaBehavior: { orders: 'evolve' },
            streamTable: { orders: 'oss_e2e_renamed_orders' },
          });
          expect(config).toMatchObject({
            ...connection,
            tablePrefix: 'oss_e2e_example_',
            loadStrategy: 'full_refresh',
            schemaBehavior: 'strict',
            bufferSize: 25,
            logFormat: 'text',
            maxConcurrentLoads: 2,
            checkpointDir: './checkpoints',
            maxBufferMemory: '16MB',
            streamLoadStrategies: { orders: 'append' },
            streamSchemaBehaviors: { orders: 'evolve' },
            streamTables: { orders: 'oss_e2e_renamed_orders' },
          });
        }
      );
      it('preserves target defaults when no runtime overrides are provided', async () => {
        resolveTargetConfig.mockResolvedValue({
          ...connection,
          loadStrategy: 'merge',
          schemaBehavior: 'strict',
          bufferSize: 5000,
          logFormat: 'text',
        });
        expect(await resolveRunConfig({ loadIntegration: 'example' })).toMatchObject({
          ...connection,
          loadStrategy: 'merge',
          schemaBehavior: 'strict',
          bufferSize: 5000,
          logFormat: 'text',
        });
      });
      it('keeps Commander defaults from replacing the configured namespace or runtime defaults', async () => {
        resolveTargetConfig.mockResolvedValue({
          ...connection,
          loadStrategy: 'merge',
          bufferSize: 5000,
          logFormat: 'json',
        });
        const handler = vi.fn();
        const program = new Command();
        registerRunCommand(program, handler);
        await program.parseAsync([
          'node',
          'loader',
          'run',
          '--load-integration',
          'example',
          '--table-prefix',
          'oss_e2e_example_',
          '--load-strategy',
          'full_refresh',
        ]);
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            ...connection,
            tablePrefix: 'oss_e2e_example_',
            loadStrategy: 'full_refresh',
            bufferSize: 5000,
            logFormat: 'json',
          }),
          expect.any(Object)
        );
      });
      it('resolves the named integration for dry runs using the same overrides', async () => {
        resolveTargetConfig.mockResolvedValue({
          ...connection,
          loadStrategy: 'merge',
          bufferSize: 5000,
          logFormat: 'json',
        });
        const handler = vi.fn();
        const program = new Command();
        registerRunCommand(program, handler);
        await program.parseAsync([
          'node',
          'loader',
          'run',
          '--load-integration',
          'example',
          '--table-prefix',
          'oss_e2e_example_',
          '--dry-run',
        ]);
        expect(resolveTargetConfig).toHaveBeenCalledOnce();
        expect(runDryRun).toHaveBeenCalledWith(
          expect.objectContaining({
            ...connection,
            tablePrefix: 'oss_e2e_example_',
            loadStrategy: 'merge',
            bufferSize: 5000,
          })
        );
        expect(handler).not.toHaveBeenCalled();
      });
      it('rejects an invalid explicit prefix instead of silently ignoring it', async () => {
        resolveTargetConfig.mockResolvedValue({ ...connection });
        await expect(
          resolveRunConfig({ loadIntegration: 'example', tablePrefix: ' ' })
        ).rejects.toThrow();
      });
    });
  }
});

describe('named target connection boundary', () => {
  for (const mode of ['loadFile', 'loadIntegration']) {
    it.each([
      'sfAccount',
      'sfPassword',
      'sfPrivateKeyPath',
      'sfDatabase',
      'targetSchema',
      'projectId',
      'datasetId',
      'keyFilename',
      'postgresHost',
      'postgresPassword',
      'dbPath',
      'dest',
    ])(`rejects explicit %s with ${mode} without echoing its value`, async (key) => {
      resolveTargetConfig.mockResolvedValue(connections[1]);
      const value = 'synthetic-sensitive-override';
      try {
        await resolveRunConfig({ [mode]: 'example', [key]: value });
        throw new Error('Expected override rejection');
      } catch (error) {
        expect(error).toMatchObject({ exitCode: 2 });
        expect(String(error)).toContain('cannot override a named integration or load file');
        expect(String(error)).not.toContain(value);
      }
    });
  }
});
