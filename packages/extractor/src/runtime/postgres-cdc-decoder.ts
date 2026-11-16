const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

type PgoutputChangeType = 'INSERT' | 'UPDATE' | 'DELETE';

interface RelationColumn {
  name: string;
  isKey: boolean;
  typeOid: number;
  typeModifier: number;
}

interface RelationDefinition {
  relationId: number;
  namespace: string;
  name: string;
  replicaIdentity: string;
  columns: RelationColumn[];
}

export interface PostgresCdcChange {
  type: PgoutputChangeType;
  relation: {
    relationId: number;
    namespace: string;
    name: string;
  };
  values: Record<string, string | null>;
}

export interface PostgresCdcTransaction {
  commitLsn: string;
  endLsn: string;
  transactionId: number;
  commitTimestamp: string;
  changes: PostgresCdcChange[];
}

interface PendingTransaction {
  transactionId: number;
  finalLsn: string;
  changes: PostgresCdcChange[];
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  readByte(): number {
    this.ensureAvailable(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readChar(): string {
    return String.fromCharCode(this.readByte());
  }

  readUInt16(): number {
    this.ensureAvailable(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt32(): number {
    this.ensureAvailable(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt32(): number {
    this.ensureAvailable(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt64(): bigint {
    this.ensureAvailable(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readBytes(length: number): Buffer {
    if (length < 0) {
      throw new Error('Malformed pgoutput message: negative byte length');
    }
    this.ensureAvailable(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readCString(): string {
    const terminator = this.buffer.indexOf(0, this.offset);
    if (terminator === -1) {
      throw new Error('Malformed pgoutput message: missing string terminator');
    }
    const value = this.buffer.subarray(this.offset, terminator).toString('utf8');
    this.offset = terminator + 1;
    return value;
  }

  done(): boolean {
    return this.offset === this.buffer.length;
  }

  private ensureAvailable(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new Error('Malformed pgoutput message: unexpected end of buffer');
    }
  }
}

function formatLsn(value: bigint): string {
  const normalized = BigInt.asUintN(64, value);
  const upper = normalized >> 32n;
  const lower = normalized & 0xffffffffn;
  return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
}

function formatPgTimestamp(value: bigint): string {
  const milliseconds = Number(value / 1000n);
  return new Date(PG_EPOCH_MS + milliseconds).toISOString();
}

function readTupleData(
  reader: BinaryReader,
  relation: RelationDefinition,
  priorValues?: Record<string, string | null>
): Record<string, string | null> {
  const columnCount = reader.readUInt16();
  if (columnCount !== relation.columns.length) {
    throw new Error(
      `Malformed pgoutput tuple for relation ${relation.namespace}.${relation.name}: expected ${relation.columns.length} columns, got ${columnCount}`
    );
  }

  const values: Record<string, string | null> = Object.create(null) as Record<
    string,
    string | null
  >;

  for (const column of relation.columns) {
    const marker = reader.readChar();
    switch (marker) {
      case 'n':
        values[column.name] = null;
        break;
      case 'u':
        if (!priorValues || !Object.prototype.hasOwnProperty.call(priorValues, column.name)) {
          throw new Error(
            `Malformed pgoutput tuple for relation ${relation.namespace}.${relation.name}: missing prior value for unchanged column "${column.name}"`
          );
        }
        values[column.name] = priorValues[column.name] ?? null;
        break;
      case 't': {
        const length = reader.readInt32();
        values[column.name] = reader.readBytes(length).toString('utf8');
        break;
      }
      case 'b': {
        const length = reader.readInt32();
        const encoded = reader.readBytes(length);
        values[column.name] = encoded.toString('utf8');
        break;
      }
      default:
        throw new Error(
          `Malformed pgoutput tuple for relation ${relation.namespace}.${relation.name}: unsupported tuple marker "${marker}"`
        );
    }
  }

  return values;
}

export class PgoutputDecoder {
  private readonly relations = new Map<number, RelationDefinition>();
  private currentTransaction: PendingTransaction | undefined;

  decodeMessage(payload: Buffer): PostgresCdcTransaction | null {
    const reader = new BinaryReader(payload);
    const tag = reader.readChar();

    switch (tag) {
      case 'B':
        {
          const finalLsn = formatLsn(reader.readInt64());
          reader.readInt64(); // begin commit timestamp, superseded by commit message timestamp
          const transactionId = reader.readUInt32();
          this.currentTransaction = {
            finalLsn,
            transactionId,
            changes: [],
          };
        }
        break;
      case 'C': {
        const transaction = this.requireTransaction();
        reader.readByte(); // flags
        const commitLsn = formatLsn(reader.readInt64());
        const endLsn = formatLsn(reader.readInt64());
        const commitTimestamp = formatPgTimestamp(reader.readInt64());
        this.currentTransaction = undefined;
        this.assertConsumed(reader, tag);
        return {
          commitLsn,
          endLsn,
          commitTimestamp,
          transactionId: transaction.transactionId,
          changes: transaction.changes,
        };
      }
      case 'R':
        this.readRelation(reader);
        break;
      case 'I':
        this.readInsert(reader);
        break;
      case 'U':
        this.readUpdate(reader);
        break;
      case 'D':
        this.readDelete(reader);
        break;
      case 'O':
        reader.readInt64();
        reader.readCString();
        break;
      case 'Y':
        reader.readUInt32();
        reader.readCString();
        reader.readCString();
        break;
      case 'M':
        reader.readByte();
        reader.readInt64();
        reader.readCString();
        reader.readBytes(reader.readInt32());
        break;
      case 'T':
        throw new Error('pgoutput TRUNCATE messages are not supported in Bobsled Core CDC');
      case 'S':
      case 'E':
      case 'c':
      case 'A':
        throw new Error('pgoutput streamed transaction messages are not supported in Bobsled Core CDC');
      default:
        throw new Error(`Unsupported pgoutput message type "${tag}"`);
    }

    this.assertConsumed(reader, tag);
    return null;
  }

  private readRelation(reader: BinaryReader): void {
    const relationId = reader.readUInt32();
    const namespace = reader.readCString();
    const name = reader.readCString();
    const replicaIdentity = reader.readChar();
    const columnCount = reader.readUInt16();
    const columns: RelationColumn[] = [];

    for (let index = 0; index < columnCount; index += 1) {
      const flags = reader.readByte();
      columns.push({
        isKey: (flags & 1) === 1,
        name: reader.readCString(),
        typeOid: reader.readUInt32(),
        typeModifier: reader.readInt32(),
      });
    }

    this.relations.set(relationId, {
      relationId,
      namespace,
      name,
      replicaIdentity,
      columns,
    });
  }

  private readInsert(reader: BinaryReader): void {
    const transaction = this.requireTransaction();
    const relation = this.requireRelation(reader.readUInt32());
    const tupleTag = reader.readChar();
    if (tupleTag !== 'N') {
      throw new Error(
        `Malformed pgoutput INSERT for relation ${relation.namespace}.${relation.name}: expected "N", got "${tupleTag}"`
      );
    }
    transaction.changes.push({
      type: 'INSERT',
      relation: {
        relationId: relation.relationId,
        namespace: relation.namespace,
        name: relation.name,
      },
      values: readTupleData(reader, relation),
    });
  }

  private readUpdate(reader: BinaryReader): void {
    const transaction = this.requireTransaction();
    const relation = this.requireRelation(reader.readUInt32());
    let priorValues: Record<string, string | null> | undefined;
    let tupleTag = reader.readChar();

    if (tupleTag === 'K' || tupleTag === 'O') {
      priorValues = readTupleData(reader, relation);
      tupleTag = reader.readChar();
    }

    if (tupleTag !== 'N') {
      throw new Error(
        `Malformed pgoutput UPDATE for relation ${relation.namespace}.${relation.name}: expected "N", got "${tupleTag}"`
      );
    }

    transaction.changes.push({
      type: 'UPDATE',
      relation: {
        relationId: relation.relationId,
        namespace: relation.namespace,
        name: relation.name,
      },
      values: readTupleData(reader, relation, priorValues),
    });
  }

  private readDelete(reader: BinaryReader): void {
    const transaction = this.requireTransaction();
    const relation = this.requireRelation(reader.readUInt32());
    const tupleTag = reader.readChar();
    if (tupleTag !== 'K' && tupleTag !== 'O') {
      throw new Error(
        `Malformed pgoutput DELETE for relation ${relation.namespace}.${relation.name}: expected "K" or "O", got "${tupleTag}"`
      );
    }
    transaction.changes.push({
      type: 'DELETE',
      relation: {
        relationId: relation.relationId,
        namespace: relation.namespace,
        name: relation.name,
      },
      values: readTupleData(reader, relation),
    });
  }

  private requireRelation(relationId: number): RelationDefinition {
    const relation = this.relations.get(relationId);
    if (!relation) {
      throw new Error(`pgoutput relation ${relationId} was referenced before its schema was sent`);
    }
    return relation;
  }

  private requireTransaction(): PendingTransaction {
    if (!this.currentTransaction) {
      throw new Error('pgoutput change message arrived before a BEGIN message');
    }
    return this.currentTransaction;
  }

  private assertConsumed(reader: BinaryReader, tag: string): void {
    if (!reader.done()) {
      throw new Error(`Malformed pgoutput ${tag} message: trailing bytes remain unread`);
    }
  }
}
