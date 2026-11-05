import { CommandError } from '@bobsled-inc/protocol';

import type { ReplaceMessage, SchemaColumn } from '@bobsled-inc/protocol';

export interface Replacement {
  key: string;
  values: string[];
}

/**
 * Collects REPLACE requests per destination stream until its next load.
 *
 * A producer sends REPLACE for a slice before any row of that slice, so the rows
 * of a later load only ever belong to slices requested before it was scheduled.
 * Taking the pending values when a load is scheduled, and deleting them first in
 * that stream's serial chain, therefore removes the old rows of exactly the
 * slices whose new rows follow, and never a row written earlier in this run.
 */
export class PendingReplacements {
  private readonly pending = new Map<string, Replacement>();
  private readonly keys = new Map<string, string>();

  add(stream: string, message: ReplaceMessage, columns: SchemaColumn[] | undefined): void {
    if (!columns) {
      throw new CommandError(`Received REPLACE for stream "${message.stream}" before SCHEMA`);
    }
    if (!columns.some((column) => column.name === message.key)) {
      throw new CommandError(
        `REPLACE key "${message.key}" is not a column of stream "${message.stream}"`
      );
    }
    const knownKey = this.keys.get(stream);
    if (knownKey !== undefined && knownKey !== message.key) {
      throw new CommandError(
        `Stream "${message.stream}" uses REPLACE key "${knownKey}" and "${message.key}" in one run`
      );
    }
    this.keys.set(stream, message.key);
    const entry = this.pending.get(stream) ?? { key: message.key, values: [] };
    entry.values.push(...message.values);
    this.pending.set(stream, entry);
  }

  /** Whether the stream received REPLACE in this run; its loads must then run serially. */
  replaces(stream: string): boolean {
    return this.keys.has(stream);
  }

  /** Remove and return the stream's pending slices, without duplicates. */
  take(stream: string): Replacement | undefined {
    const entry = this.pending.get(stream);
    this.pending.delete(stream);
    if (!entry) return undefined;
    return { key: entry.key, values: [...new Set(entry.values)] };
  }

  streamsWithPending(): string[] {
    return [...this.pending.keys()];
  }
}
