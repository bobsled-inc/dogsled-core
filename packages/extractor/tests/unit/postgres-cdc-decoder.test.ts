import { describe, expect, it } from 'vitest';

import {
  PgoutputDecoder,
  type PostgresCdcTransaction,
} from '../../src/runtime/postgres-cdc-decoder.js';

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

type TupleValue = { marker: 'n' } | { marker: 'u' } | { marker: 't' | 'b'; value: string };

function tuple(values: TupleValue[]): Buffer {
  const parts = [u16(values.length)];

  for (const value of values) {
    parts.push(Buffer.from(value.marker, 'utf8'));
    if (value.marker === 't' || value.marker === 'b') {
      const encoded = Buffer.from(value.value, 'utf8');
      parts.push(i32(encoded.length), encoded);
    }
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
    tuple([
      { marker: 't', value: id },
      { marker: 't', value: name },
    ]),
  ]);
}

function updateMessage(): Buffer {
  return Buffer.concat([
    Buffer.from('U', 'utf8'),
    u32(42),
    Buffer.from('O', 'utf8'),
    tuple([
      { marker: 't', value: '1' },
      { marker: 't', value: 'legacy-name' },
    ]),
    Buffer.from('N', 'utf8'),
    tuple([{ marker: 't', value: '1' }, { marker: 'u' }]),
  ]);
}

function updateWithoutPriorValuesMessage(): Buffer {
  return Buffer.concat([
    Buffer.from('U', 'utf8'),
    u32(42),
    Buffer.from('N', 'utf8'),
    tuple([{ marker: 't', value: '1' }, { marker: 'u' }]),
  ]);
}

function malformedInsertMessageWithNegativeLength(): Buffer {
  return Buffer.concat([
    Buffer.from('I', 'utf8'),
    u32(42),
    Buffer.from('N', 'utf8'),
    u16(2),
    Buffer.from('t', 'utf8'),
    i32(-1),
  ]);
}

function deleteMessage(id: string, name: string): Buffer {
  return Buffer.concat([
    Buffer.from('D', 'utf8'),
    u32(42),
    Buffer.from('K', 'utf8'),
    tuple([
      { marker: 't', value: id },
      { marker: 't', value: name },
    ]),
  ]);
}

function commitTransaction(messages: Buffer[]): PostgresCdcTransaction {
  const decoder = new PgoutputDecoder();
  let committed: PostgresCdcTransaction | null = null;

  for (const message of messages) {
    const decoded = decoder.decodeMessage(message);
    if (decoded) {
      committed = decoded;
    }
  }

  if (!committed) {
    throw new Error('Expected transaction commit');
  }

  return committed;
}

describe('PgoutputDecoder', () => {
  it('uses relation messages to decode insert tuples', () => {
    const transaction = commitTransaction([
      beginMessage(lsn(0x16, 0xb374d848), 91),
      relationMessage(),
      insertMessage('1', 'Ada'),
      commitMessage(lsn(0x16, 0xb374d848), lsn(0x16, 0xb374d860)),
    ]);

    expect(transaction).toMatchObject({
      commitLsn: '16/B374D848',
      endLsn: '16/B374D860',
      transactionId: 91,
      commitTimestamp: '2000-01-01T00:00:00.000Z',
      changes: [
        {
          type: 'INSERT',
          relation: {
            relationId: 42,
            namespace: 'public',
            name: 'customers',
          },
          values: {
            id: '1',
            name: 'Ada',
          },
        },
      ],
    });
  });

  it('decodes updates at commit boundaries and backfills unchanged toasted values', () => {
    const decoder = new PgoutputDecoder();

    expect(decoder.decodeMessage(beginMessage(lsn(0x16, 0xb374d900), 92))).toBeNull();
    expect(decoder.decodeMessage(relationMessage())).toBeNull();
    expect(decoder.decodeMessage(updateMessage())).toBeNull();

    const committed = decoder.decodeMessage(
      commitMessage(lsn(0x16, 0xb374d900), lsn(0x16, 0xb374d920))
    );

    expect(committed).toMatchObject({
      changes: [
        {
          type: 'UPDATE',
          values: {
            id: '1',
            name: 'legacy-name',
          },
        },
      ],
    });
  });

  it('decodes delete tuples from key payloads', () => {
    const transaction = commitTransaction([
      beginMessage(lsn(0x16, 0xb374da00), 93),
      relationMessage(),
      deleteMessage('2', 'Grace'),
      commitMessage(lsn(0x16, 0xb374da00), lsn(0x16, 0xb374da20)),
    ]);

    expect(transaction.changes).toEqual([
      {
        type: 'DELETE',
        relation: {
          relationId: 42,
          namespace: 'public',
          name: 'customers',
        },
        values: {
          id: '2',
          name: 'Grace',
        },
      },
    ]);
  });

  it('rejects unsupported TRUNCATE messages', () => {
    const decoder = new PgoutputDecoder();
    expect(() => decoder.decodeMessage(Buffer.from('T', 'utf8'))).toThrow(
      'pgoutput TRUNCATE messages are not supported in Dogsled CDC'
    );
  });

  it('rejects tuple payloads with negative field lengths', () => {
    const decoder = new PgoutputDecoder();
    expect(decoder.decodeMessage(beginMessage(lsn(0x16, 0xb374da30), 94))).toBeNull();
    expect(decoder.decodeMessage(relationMessage())).toBeNull();
    expect(() => decoder.decodeMessage(malformedInsertMessageWithNegativeLength())).toThrow(
      'Malformed pgoutput message: negative byte length'
    );
  });

  it('rejects unchanged toast markers when the prior value is unavailable', () => {
    const decoder = new PgoutputDecoder();
    expect(decoder.decodeMessage(beginMessage(lsn(0x16, 0xb374da40), 95))).toBeNull();
    expect(decoder.decodeMessage(relationMessage())).toBeNull();
    expect(() => decoder.decodeMessage(updateWithoutPriorValuesMessage())).toThrow(
      'Malformed pgoutput tuple for relation public.customers: missing prior value for unchanged column "name"'
    );
  });
});
