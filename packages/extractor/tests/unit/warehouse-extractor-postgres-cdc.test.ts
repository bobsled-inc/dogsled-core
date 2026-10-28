import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractWarehouseResource } from '../../src/runtime/warehouse-extractor.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { Writable } from 'node:stream';
import type { WarehouseClient } from '../../src/runtime/warehouse-client.js';
import type { ExtractorState, IntegrationSpec } from '../../src/types/index.js';
import type { WarehouseResourceSpec } from '../../src/framework/extractor/index.js';
import type { StateStore } from '../../src/runtime/state.js';

let mockClient: WarehouseClient;
const originalPgHost = process.env['PG_HOST'];
const originalPgUser = process.env['PG_USER'];
const originalPgPassword = process.env['PG_PASSWORD'];

vi.mock('../../src/runtime/warehouse-client.js', () => ({
  createWarehouseClient: vi.fn().mockImplementation(() => Promise.resolve(mockClient)),
}));

beforeEach(() => {
  process.env['PG_HOST'] = 'localhost';
  process.env['PG_USER'] = 'test-user';
  process.env['PG_PASSWORD'] = 'test-password';
});

afterEach(() => {
  if (originalPgHost === undefined) {
    delete process.env['PG_HOST'];
  } else {
    process.env['PG_HOST'] = originalPgHost;
  }
  if (originalPgUser === undefined) {
    delete process.env['PG_USER'];
  } else {
    process.env['PG_USER'] = originalPgUser;
  }
  if (originalPgPassword === undefined) {
    delete process.env['PG_PASSWORD'];
  } else {
    process.env['PG_PASSWORD'] = originalPgPassword;
  }
});

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function i32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function i64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(value);
  return buffer;
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function lsn(upper: number, lower: number): bigint {
  return (BigInt(upper) << 32n) + BigInt(lower);
}

function tuple(values: string[]): Buffer {
  const parts: Buffer[] = [u16(values.length)];
  for (const value of values) {
    const encoded = Buffer.from(value, 'utf8');
    parts.push(Buffer.from('t', 'utf8'), i32(encoded.length), encoded);
  }
  return Buffer.concat(parts);
}

function beginMessage(finalLsn: bigint, transactionId: number): Buffer {
  return Buffer.concat([Buffer.from('B', 'utf8'), i64(finalLsn), i64(0n), u32(transactionId)]);
}

function commitMessage(commitLsn: bigint, endLsn: bigint): Buffer {
  return Buffer.concat([
    Buffer.from('C', 'utf8'),
    Buffer.from([0]),
    i64(commitLsn),
    i64(endLsn),
    i64(0n),
  ]);
}

function relationMessage(): Buffer {
  return Buffer.concat([
    Buffer.from('R', 'utf8'),
    u32(42),
    cstring('public'),
    cstring('customers'),
    Buffer.from('d', 'utf8'),
    u16(2),
    Buffer.from([1]),
    cstring('id'),
    u32(23),
    i32(-1),
    Buffer.from([0]),
    cstring('name'),
    u32(25),
    i32(-1),
  ]);
}

function insertMessage(id: string, name: string): Buffer {
  return Buffer.concat([
    Buffer.from('I', 'utf8'),
    u32(42),
    Buffer.from('N', 'utf8'),
    tuple([id, name]),
  ]);
}

function postgresIntegration(): IntegrationSpec {
  return {
    auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
    spec_version: '1',
    type: 'integration',
    name: 'test_postgres',
    source_type: 'postgres',
    connection: {
      host_env: 'PG_HOST',
      port: 5432,
      database: 'test_db',
      schema: 'public',
    },
    auth: {
      type: 'password',
      username_env: 'PG_USER',
      password_env: 'PG_PASSWORD',
    },
  };
}

function postgresCdcResource(): WarehouseResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'customers_cdc',
    integration: 'test_postgres',
    source: {
      table: 'customers',
      schema: 'public',
    },
    replication: {
      method: 'change_tracking',
      primary_key: ['id'],
      change_tracking: {
        plugin: 'pgoutput',
        slot_name: 'track_customers_slot',
        publication_name: 'track_customers_pub',
      },
    },
    output: {
      id: { type: 'integer' },
      name: { type: 'string' },
      _change_type: { type: 'string' },
      _commit_lsn: { type: 'string' },
    },
    extract: {
      table: {
        load_strategy: 'append',
      },
    },
  };
}

function createMockStateStore(initialState: ExtractorState = { streams: {} }): StateStore {
  let state = initialState;
  return {
    load: vi.fn().mockImplementation(() => Promise.resolve(state)),
    save: vi.fn().mockImplementation((newState: ExtractorState) => {
      state = newState;
      return Promise.resolve();
    }),
  };
}

interface ReplicationSlotRow {
  database: string;
  plugin: string;
  slot_name: string;
}

interface PublicationTableRow {
  schemaname: string;
  tablename: string;
}

interface ChangeRecord {
  _change_type: string;
  _commit_lsn: string;
  id: number;
  name: string;
}

interface ChangeRecordMessage {
  record: ChangeRecord;
  type: 'RECORD';
}

interface ChangeStateMessage {
  type: 'STATE';
  value: {
    cursor_field: string;
    cursor_type?: string;
    cursor_value: string;
    record_count?: number;
  };
}

interface OtherProtocolMessage {
  type: string;
}

type ParsedProtocolMessage = ChangeRecordMessage | ChangeStateMessage | OtherProtocolMessage;

function isRecordMessage(message: ParsedProtocolMessage): message is ChangeRecordMessage {
  return message.type === 'RECORD';
}

function isStateMessage(message: ParsedProtocolMessage): message is ChangeStateMessage {
  return message.type === 'STATE';
}

function parseProtocolMessages(stdoutStream: FakeWritable): ParsedProtocolMessage[] {
  return stdoutStream.chunks.map((chunk) => JSON.parse(chunk) as ParsedProtocolMessage);
}

function createPostgresCdcClient(params: {
  messages: Buffer[];
  slotRows?: ReplicationSlotRow[];
  publicationRows?: PublicationTableRow[];
  publicationExists?: boolean;
}) {
  const queryRows = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pg_replication_slots')) {
      return (
        params.slotRows ?? [
          {
            slot_name: 'track_customers_slot',
            plugin: 'pgoutput',
            database: 'test_db',
          },
        ]
      );
    }
    if (sql.includes('FROM pg_publication_tables')) {
      return (
        params.publicationRows ?? [
          {
            schemaname: 'public',
            tablename: 'customers',
          },
        ]
      );
    }
    if (sql.includes('FROM pg_publication')) {
      return params.publicationExists ? [{ pubname: 'track_customers_pub' }] : [];
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  const advanceReplicationSlot = vi.fn().mockResolvedValue('16/B374D860');

  const client: WarehouseClient = {
    dialect: 'postgres',
    async *execute() {
      yield params.messages.map((data) => ({ data }));
    },
    queryRows,
    advanceReplicationSlot,
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    introspect: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    client,
    queryRows,
    advanceReplicationSlot,
  };
}

describe('extractWarehouseResource — PostgreSQL CDC', () => {
  let stdoutStream: FakeWritable;
  let stderrStream: FakeWritable;
  let emitter: Emitter;
  let logger: ControlLogger;

  beforeEach(() => {
    stdoutStream = new FakeWritable();
    stderrStream = new FakeWritable();
    emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });
    logger = new ControlLogger({
      logFormat: 'json',
      quiet: true,
      stream: stderrStream as unknown as Writable,
    });
    vi.clearAllMocks();
  });

  it('saves durable state before advancing the replication slot', async () => {
    const { client, advanceReplicationSlot } = createPostgresCdcClient({
      messages: [
        beginMessage(lsn(0x16, 0xb374d848), 91),
        relationMessage(),
        insertMessage('1', 'Ada'),
        commitMessage(lsn(0x16, 0xb374d848), lsn(0x16, 0xb374d860)),
      ],
    });
    mockClient = client;
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: postgresIntegration(),
      resource: postgresCdcResource(),
      integrationName: 'test_postgres',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
    });

    const saveCallOrder = vi.mocked(stateStore.save).mock.invocationCallOrder[0];
    const advanceCallOrder = advanceReplicationSlot.mock.invocationCallOrder[0];

    expect(saveCallOrder).toBeLessThan(advanceCallOrder);
    expect(result.durableBookmark).toMatchObject({
      cursor_field: '_commit_lsn',
      cursor_type: 'lsn',
      cursor_value: '16/B374D848',
    });

    const messages = parseProtocolMessages(stdoutStream);
    const recordMessage = messages.find(isRecordMessage);
    const stateMessage = messages.find(isStateMessage);

    expect(recordMessage).toMatchObject({
      record: {
        id: 1,
        name: 'Ada',
        _change_type: 'INSERT',
        _commit_lsn: '16/B374D848',
      },
    });
    expect(stateMessage).toMatchObject({
      value: {
        cursor_field: '_commit_lsn',
        cursor_type: 'lsn',
        cursor_value: '16/B374D848',
        record_count: 1,
      },
    });
  });

  it('treats --limit as preview mode and skips state plus slot advancement', async () => {
    const { client, advanceReplicationSlot } = createPostgresCdcClient({
      messages: [
        beginMessage(lsn(0x16, 0xb374d848), 91),
        relationMessage(),
        insertMessage('1', 'Ada'),
        commitMessage(lsn(0x16, 0xb374d848), lsn(0x16, 0xb374d860)),
      ],
    });
    mockClient = client;
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: postgresIntegration(),
      resource: postgresCdcResource(),
      integrationName: 'test_postgres',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      limit: 1,
    });

    expect(result.durableBookmark).toBeUndefined();
    expect(vi.mocked(stateStore.save)).not.toHaveBeenCalled();
    expect(advanceReplicationSlot).not.toHaveBeenCalled();
  });

  it('skips state and slot advancement when advanceState is false', async () => {
    const { client, advanceReplicationSlot } = createPostgresCdcClient({
      messages: [
        beginMessage(lsn(0x16, 0xb374d848), 91),
        relationMessage(),
        insertMessage('1', 'Ada'),
        commitMessage(lsn(0x16, 0xb374d848), lsn(0x16, 0xb374d860)),
      ],
    });
    mockClient = client;
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: postgresIntegration(),
      resource: postgresCdcResource(),
      integrationName: 'test_postgres',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      advanceState: false,
    });

    expect(result.durableBookmark).toBeUndefined();
    expect(vi.mocked(stateStore.save)).not.toHaveBeenCalled();
    expect(advanceReplicationSlot).not.toHaveBeenCalled();

    const messages = parseProtocolMessages(stdoutStream);
    const stateMessage = messages.find(isStateMessage);
    expect(stateMessage).toMatchObject({
      value: {
        cursor_field: '_commit_lsn',
        cursor_value: '16/B374D848',
      },
    });
  });

  it('skips commits that are already durable by LSN', async () => {
    const { client } = createPostgresCdcClient({
      messages: [
        beginMessage(lsn(0x16, 0xb374d848), 91),
        relationMessage(),
        insertMessage('1', 'Ada'),
        commitMessage(lsn(0x16, 0xb374d848), lsn(0x16, 0xb374d860)),
        beginMessage(lsn(0x16, 0xb374d900), 92),
        insertMessage('2', 'Grace'),
        commitMessage(lsn(0x16, 0xb374d900), lsn(0x16, 0xb374d920)),
      ],
    });
    mockClient = client;
    const stateStore = createMockStateStore();
    const state: ExtractorState = {
      streams: {
        'test_postgres/customers_cdc': {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
          last_run_at: '2026-04-03T00:00:00Z',
          record_count: 1,
        },
      },
    };

    const result = await extractWarehouseResource({
      integration: postgresIntegration(),
      resource: postgresCdcResource(),
      integrationName: 'test_postgres',
      emitter,
      logger,
      state,
      stateStore,
    });

    expect(result.recordCount).toBe(1);

    const messages = parseProtocolMessages(stdoutStream);
    const recordMessages = messages.filter(isRecordMessage);
    expect(recordMessages).toHaveLength(1);
    expect(recordMessages[0]).toMatchObject({
      record: {
        id: 2,
        _commit_lsn: '16/B374D900',
      },
    });
  });

  it('fails with an actionable publication mismatch error', async () => {
    const { client } = createPostgresCdcClient({
      messages: [],
      publicationRows: [],
      publicationExists: true,
    });
    mockClient = client;

    await expect(
      extractWarehouseResource({
        integration: postgresIntegration(),
        resource: postgresCdcResource(),
        integrationName: 'test_postgres',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
      })
    ).rejects.toThrow(
      'Publication "track_customers_pub" does not expose any tables through pg_publication_tables.'
    );
  });

  it('rejects full refresh for PostgreSQL CDC resources', async () => {
    const { client } = createPostgresCdcClient({ messages: [] });
    mockClient = client;

    await expect(
      extractWarehouseResource({
        integration: postgresIntegration(),
        resource: postgresCdcResource(),
        integrationName: 'test_postgres',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
        fullRefresh: true,
      })
    ).rejects.toThrow(
      '--full-refresh is not supported for PostgreSQL change_tracking resource "customers_cdc"'
    );
  });
});
