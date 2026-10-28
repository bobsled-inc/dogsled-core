import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const common = vi.hoisted(() => ({
  buildCommandContext: vi.fn(),
  findIntegrationFile: vi.fn(() => '/project/integrations/demo/integration.yml'),
  findResourceFiles: vi.fn(() => ['/project/resources/demo/customers.yml']),
  loadIntegrationSpecWithWarnings: vi.fn(),
  loadResourceSpecWithWarnings: vi.fn(),
  parseGlobalFlags: vi.fn((opts) => opts),
}));

const stateStore = vi.hoisted(() => ({
  FileStateStore: vi.fn(function FileStateStore() {}),
  load: vi.fn(),
  mergeDurableBookmark: vi.fn((_existing, candidate) => candidate),
  save: vi.fn(),
}));
const stateBackend = vi.hoisted(() => ({
  resolveStateStore: vi.fn(),
}));

const warehouse = vi.hoisted(() => ({
  advanceReplicationSlot: vi.fn(),
  close: vi.fn(),
  createWarehouseClient: vi.fn(),
}));

const warehouseExtractor = vi.hoisted(() => ({
  isWarehouseResource: vi.fn(() => true),
  isWarehouseSource: vi.fn(() => true),
  resolveConnectionConfig: vi.fn(() => ({ host: 'localhost' })),
}));

vi.mock('../../../src/commands/common.js', () => common);
vi.mock('../../../src/runtime/state.js', () => ({
  FileStateStore: stateStore.FileStateStore,
  mergeDurableBookmark: stateStore.mergeDurableBookmark,
}));
vi.mock('../../../src/runtime/state-backend.js', () => ({
  resolveStateStore: stateBackend.resolveStateStore,
}));
vi.mock('../../../src/runtime/warehouse-client.js', () => ({
  createWarehouseClient: warehouse.createWarehouseClient,
}));
vi.mock('../../../src/runtime/warehouse-extractor.js', () => warehouseExtractor);

import { commitCapturedState } from '../../../src/commands/commit-state.js';

describe('commitCapturedState', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-state-test-'));
    process.chdir(tempDir);

    common.buildCommandContext.mockReturnValue({
      cwd: tempDir,
      resourcesDir: path.join(tempDir, 'resources'),
      bundledIntegrationsDir: null,
      config: { state_dir: '.state' },
      verbose: false,
      quiet: false,
      logFormat: 'json',
    });

    common.loadIntegrationSpecWithWarnings.mockReturnValue({
      spec: {
        source_type: 'postgres',
      },
    });
    common.loadResourceSpecWithWarnings.mockReturnValue({
      spec: {
        name: 'customers_cdc',
        source: { table: 'customers', schema: 'public' },
        replication: {
          method: 'change_tracking',
          change_tracking: {
            slot_name: 'track_customers_slot',
            publication_name: 'track_customers_pub',
          },
        },
      },
    });

    stateStore.load.mockResolvedValue({ streams: {} });
    stateStore.save.mockResolvedValue(undefined);
    stateStore.FileStateStore.mockImplementation(function FileStateStore() {
      return {
        load: stateStore.load,
        save: stateStore.save,
      };
    });
    stateBackend.resolveStateStore.mockReturnValue({
      load: stateStore.load,
      save: stateStore.save,
    });

    warehouse.advanceReplicationSlot.mockResolvedValue(undefined);
    warehouse.close.mockResolvedValue(undefined);
    warehouse.createWarehouseClient.mockResolvedValue({
      advanceReplicationSlot: warehouse.advanceReplicationSlot,
      close: warehouse.close,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves durable state before advancing PostgreSQL replication slots', async () => {
    const capturePath = path.join(tempDir, 'capture.jsonl');
    const callOrder: string[] = [];

    fs.writeFileSync(
      capturePath,
      `${JSON.stringify({
        type: 'STATE',
        stream: 'customers_cdc',
        value: {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
          last_run_at: '2026-04-02T00:00:00.000Z',
        },
      })}\n`
    );

    stateStore.save.mockImplementation(async () => {
      callOrder.push('save');
    });
    warehouse.advanceReplicationSlot.mockImplementation(async () => {
      callOrder.push('advance');
    });

    await expect(
      commitCapturedState({
        captureFile: 'capture.jsonl',
        integration: 'demo',
      })
    ).resolves.toBe(0);

    expect(callOrder).toEqual(['save', 'advance']);
    expect(warehouse.advanceReplicationSlot).toHaveBeenCalledWith(
      'track_customers_slot',
      '16/B374D848'
    );
  });

  it('forwards json, verbose, and quiet flags into the command context', async () => {
    const capturePath = path.join(tempDir, 'capture.jsonl');
    fs.writeFileSync(capturePath, '');

    await expect(
      commitCapturedState({
        captureFile: 'capture.jsonl',
        integration: 'demo',
        json: true,
        quiet: true,
        verbose: true,
      })
    ).resolves.toBe(0);

    expect(common.parseGlobalFlags).toHaveBeenCalledWith({
      logFormat: 'json',
      quiet: true,
      verbose: true,
    });
    expect(stateStore.save).not.toHaveBeenCalled();
    expect(warehouse.advanceReplicationSlot).not.toHaveBeenCalled();
  });

  it('uses an explicit state backend for deferred multi-destination commits', async () => {
    fs.writeFileSync(path.join(tempDir, 'capture.jsonl'), '');
    const statePath = path.join(tempDir, '.invocation-state');

    await commitCapturedState({
      captureFile: 'capture.jsonl',
      integration: 'demo',
      stateBackend: statePath,
    });

    expect(stateBackend.resolveStateStore).toHaveBeenCalledWith({
      defaultStateDir: path.join(tempDir, '.state'),
      projectRoot: tempDir,
      stateBackend: statePath,
    });
  });

  it('ignores captured state for a lookup-only Resource', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'capture.jsonl'),
      `${JSON.stringify({
        type: 'STATE',
        stream: 'customer_lookup',
        value: {
          cursor_field: 'id',
          cursor_type: 'string',
          cursor_value: 'u-1',
          last_run_at: '2026-04-02T00:00:00.000Z',
        },
      })}\n`
    );
    warehouseExtractor.isWarehouseResource.mockReturnValueOnce(false);
    common.loadResourceSpecWithWarnings.mockReturnValue({
      spec: {
        type: 'resource',
        name: 'customer_lookup',
        output: { id: { type: 'string', path: '$.id' } },
        lookup: {
          description: 'Find one customer',
          api: { endpoint: '/customers/${{ input.id }}', method: 'GET' },
          input: { id: { type: 'string', required: true } },
        },
      },
    });

    await expect(
      commitCapturedState({ captureFile: 'capture.jsonl', integration: 'demo' })
    ).resolves.toBe(0);

    expect(stateStore.mergeDurableBookmark).not.toHaveBeenCalled();
    expect(stateStore.save).toHaveBeenCalledOnce();
  });

  it('reads captured state from the validated real path even if the symlink target changes', async () => {
    const captureTargetDir = path.join(tempDir, 'captures');
    const originalTargetPath = path.join(captureTargetDir, 'capture-original.jsonl');
    const swappedTargetPath = path.join(captureTargetDir, 'capture-swapped.jsonl');
    const captureLinkPath = path.join(tempDir, 'capture-link.jsonl');
    fs.mkdirSync(captureTargetDir, { recursive: true });
    fs.writeFileSync(
      originalTargetPath,
      `${JSON.stringify({
        type: 'STATE',
        stream: 'customers_cdc',
        value: {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
          last_run_at: '2026-04-02T00:00:00.000Z',
        },
      })}\n`
    );
    fs.writeFileSync(
      swappedTargetPath,
      `${JSON.stringify({
        type: 'STATE',
        stream: 'customers_cdc',
        value: {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D849',
          last_run_at: '2026-04-03T00:00:00.000Z',
        },
      })}\n`
    );
    fs.symlinkSync(originalTargetPath, captureLinkPath);

    let resolveLoad: ((value: { streams: Record<string, never> }) => void) | undefined;
    stateStore.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    );

    const promise = commitCapturedState({
      captureFile: 'capture-link.jsonl',
      integration: 'demo',
    });

    fs.rmSync(captureLinkPath);
    fs.symlinkSync(swappedTargetPath, captureLinkPath);
    resolveLoad?.({ streams: {} });

    await expect(promise).resolves.toBe(0);

    expect(warehouse.advanceReplicationSlot).toHaveBeenCalledWith(
      'track_customers_slot',
      '16/B374D848'
    );
  });

  it('preserves the durable last_run_at when a captured state omits it', async () => {
    const capturePath = path.join(tempDir, 'capture.jsonl');
    fs.writeFileSync(
      capturePath,
      `${JSON.stringify({
        type: 'STATE',
        stream: 'customers_cdc',
        value: {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
        },
      })}\n`
    );

    stateStore.load.mockResolvedValue({
      streams: {
        'demo/customers_cdc': {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D847',
          last_run_at: '2026-04-01T00:00:00.000Z',
        },
      },
    });

    await expect(
      commitCapturedState({
        captureFile: 'capture.jsonl',
        integration: 'demo',
      })
    ).resolves.toBe(0);

    expect(stateStore.mergeDurableBookmark).toHaveBeenCalledWith(
      expect.objectContaining({
        last_run_at: '2026-04-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        last_run_at: '2026-04-01T00:00:00.000Z',
      }),
      'lsn',
      '2026-04-01T00:00:00.000Z'
    );
  });
});
