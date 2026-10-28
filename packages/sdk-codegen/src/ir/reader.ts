import { z } from 'zod';

import { CommandError } from '@bobsled-inc/protocol';
import { inventoryEntityGraph } from '@bobsled-inc/entity-graph/api';

import { parseSdkIr, type SdkIr } from './schema.js';

export interface ReadIrOptions {
  cwd?: string;
  integration?: string;
}

export interface ReadIrResult {
  ir: SdkIr;
  /**
   * Non-fatal warnings collected while projecting the entity-graph project
   * into the IR shape (e.g. relationships skipped because endpoints were
   * not in the inventory). Empty when projection produced no warnings.
   * The IR contract itself does not carry warnings — they are operational
   * metadata surfaced separately by the CLI.
   */
  warnings: string[];
}

/**
 * Read the SDK IR for an entity-graph project on disk.
 *
 * Calls `inventoryEntityGraph()` (the `@bobsled-inc/entity-graph` bridge),
 * splits operational warnings off, and validates the IR against the Zod
 * schema. ZodError surfaces as a user-friendly `CommandError(2)`.
 */
export async function readIr(options: ReadIrOptions = {}): Promise<ReadIrResult> {
  const inventory = await inventoryEntityGraph(options);
  // Split operational warnings from the IR shape — the schema is strict
  // and warnings aren't part of the contract; they're surfaced separately
  // so consumers see what was skipped.
  const { warnings, ...ir } = inventory;
  try {
    return { ir: parseSdkIr(ir), warnings };
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new CommandError(`SDK IR validation failed:\n${issues}`, 2);
    }
    throw err;
  }
}
