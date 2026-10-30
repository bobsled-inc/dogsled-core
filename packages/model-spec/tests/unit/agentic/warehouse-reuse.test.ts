import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import {
  AgenticRunSnapshotSchema,
  applyAgenticCheckpoint,
  digestAgenticState,
  type AgenticCheckpointCommand,
} from '../../../src/agentic/state.js';
import { runFixture } from './state-fixture.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => {
  resolve.mockReset();
  vi.useRealTimers();
});

function initial() {
  const f = runFixture(1);
  const started = Date.now() - 1000;
  const definition = { resolved: f.context().resolved, tokensPerAssignment: 100, maxAttempts: 3 };
  return AgenticRunSnapshotSchema.parse({
    version: 2,
    revision: 0,
    key: { scope: 'test', model: f.model.name, id: 'reuse' },
    definition,
    identity: digestAgenticState(definition),
    started_at: new Date(started).toISOString(),
    deadline_at: new Date(started + 600000).toISOString(),
    token_limit: 100000,
    max_attempts: 3,
    charged: 0,
    status: 'preparing',
    publication: 'pending',
    work: [],
  });
}
const window = (id: string, revision: number): AgenticCheckpointCommand => ({
  type: 'begin_execution',
  operation_id: id,
  expected_revision: revision,
  started_at: new Date().toISOString(),
});

describe.each(checkpointIntegrations)('warehouse snapshot reuse: $source_type', (integration) => {
  const open = async (transport: ReturnType<typeof checkpointTransport>, leaseMs?: number) => {
    resolve.mockResolvedValue(transport.runner);
    const store = createWarehouseCheckpointStore(integration, {
      schema: 'checkpoints',
      ...(leaseMs ? { leaseMs } : {}),
    });
    return store.acquire(initial().key);
  };

  it('applies commands to its committed snapshot but verifies payloads on every read', async () => {
    const transport = checkpointTransport();
    const value = initial();
    const writer = await open(transport);
    let expected;
    try {
      expected = await writer.create(value);
      expected = await writer.checkpoint(window('one', 0));
      expect(transport.operations.read_payload).toBeUndefined();
      expect(await writer.read()).toEqual(expected);
      expect(transport.operations.read_payload).toBe(1);
    } finally {
      await writer.release();
    }
    const resumed = await open(transport);
    try {
      // A new session has no prior state: its first command reads and validates the payload.
      expect(await resumed.checkpoint(window('two', 1))).toMatchObject({ revision: 2 });
      expect(transport.operations.read_payload).toBe(2);
      expect(await resumed.checkpoint(window('three', 2))).toMatchObject({ revision: 3 });
      expect(transport.operations.read_payload).toBe(2);
      expect(await resumed.read()).toMatchObject({ revision: 3 });
      expect(transport.operations.read_payload).toBe(3);
    } finally {
      await resumed.release();
    }
  });

  it('reports damaged payload rows on read and replaces them with the next commit', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      const created = await session.create(initial());
      for (const chunk of transport.payloads.get(transport.pointer)!) chunk.data = 'invalid-base64';
      await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
      // The command applies to the snapshot this session committed under the same pointer.
      const command = window('one', 0);
      expect(await session.checkpoint(command)).toEqual(applyAgenticCheckpoint(created, command));
      expect(await session.read()).toMatchObject({ revision: 1 });
    } finally {
      await session.release();
    }
  });

  it('verifies a snapshot published under another pointer and rejects a corrupt one', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      const created = await session.create(initial());
      const external = applyAgenticCheckpoint(created, window('external', 0));
      const json = JSON.stringify(external);
      transport.publish(`${randomUUID()}_${digestAgenticState(external)}`, json);
      expect(await session.read()).toEqual(external);
      expect(transport.operations.read_payload).toBe(1);
      // Commands apply to the verified durable state, not this session's last commit.
      expect(await session.checkpoint(window('next', 1))).toMatchObject({ revision: 2 });
      transport.publish(`${randomUUID()}_${digestAgenticState(external)}`, json.replace('2', '3'));
      await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
    } finally {
      await session.release();
    }
  });

  it('isolates the reusable state from callers that mutate returned snapshots', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      const created = await session.create(initial());
      const committed = structuredClone(created);
      created.revision = 7;
      const read = (await session.read())!;
      read.status = 'execution_complete';
      read.charged = 5;
      const command = window('one', 0);
      const next = await session.checkpoint(command);
      expect(next).toEqual(applyAgenticCheckpoint(committed, command));
      next.revision = 99;
      expect(await session.read()).toMatchObject({ revision: 1, status: 'preparing' });
      expect(await session.checkpoint(window('two', 1))).toMatchObject({ revision: 2 });
    } finally {
      await session.release();
    }
  });

  it('verifies the durable pointer after an uncertain commit instead of reusing state', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      const created = await session.create(initial());
      const command = window('lost', 0);
      transport.failCommit = true;
      await expect(session.checkpoint(command)).rejects.toThrow('Lost commit response');
      expect(await session.read()).toEqual(applyAgenticCheckpoint(created, command));
      expect(transport.operations.read_payload).toBe(1);
      // The verified state is reused by the next command.
      await session.checkpoint(window('after', 1));
      expect(transport.operations.read_payload).toBe(1);
      expect(await session.read()).toMatchObject({ revision: 2 });
    } finally {
      await session.release();
    }
  });

  it('keeps the committed state after a failed staging write', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      const created = await session.create(initial());
      transport.afterInsert = () => {
        throw new Error('Staging response lost');
      };
      await expect(session.checkpoint(window('failed', 0))).rejects.toThrow('Staging');
      transport.afterInsert = undefined;
      expect(await session.read()).toEqual(created);
      expect(await session.checkpoint(window('retry', 0))).toMatchObject({ revision: 1 });
    } finally {
      await session.release();
    }
  });

  it('stops reusing state after ownership is lost', async () => {
    const transport = checkpointTransport();
    const session = await open(transport);
    try {
      await session.create(initial());
      transport.valid = false;
      await expect(session.read()).rejects.toMatchObject({ code: 'lease_lost' });
      transport.valid = true;
      await expect(session.read()).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(session.checkpoint(window('late', 0))).rejects.toMatchObject({
        code: 'lease_lost',
      });
      expect(session.ownershipLost?.aborted).toBe(true);
    } finally {
      await session.release();
    }
  });

  it('renews before staging only when a third of the lease has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const transport = checkpointTransport();
    const session = await open(transport, 30000);
    try {
      await session.create(initial());
      await session.checkpoint(window('one', 0));
      // Acquisition and each fenced pointer commit extend the lease.
      expect(transport.operations.ownership).toBe(1);
      vi.setSystemTime(Date.now() + 10000);
      await session.checkpoint(window('two', 1));
      expect(transport.operations.ownership).toBe(2);
      await session.checkpoint(window('three', 2));
      expect(transport.operations.ownership).toBe(2);
    } finally {
      await session.release();
    }
  });
});

it('validates each durable transition at most twice and does not reread its own payloads', async () => {
  const transport = checkpointTransport();
  resolve.mockResolvedValue(transport.runner);
  const f = runFixture(4);
  const counters = { validations: 0 };
  const restore = countSnapshotValidations(counters);
  try {
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: createWarehouseCheckpointStore(checkpointIntegrations[1]!, {
        schema: 'checkpoints',
      }),
      run: { id: 'gate', mode: 'start' },
    });
    expect(result.chargedTokens).toBe(8);
  } finally {
    restore();
  }
  const saves = transport.operations.pointer!;
  // create, seal, four starts, four finishes and completion.
  expect(saves).toBe(11);
  // One store validation and one receipt validation per save, plus the initial snapshot.
  expect(counters.validations).toBe(2 * saves + 1);
  expect(transport.operations.read_payload).toBeUndefined();
  // Acquisition and release only: each pointer commit extends the lease.
  expect(transport.operations.ownership).toBe(2);
});
