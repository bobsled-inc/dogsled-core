import type { Readable } from 'node:stream';

import { readProtocol } from '@bobsled-inc/loader/runtime';
import { CommandError, EXIT_ERROR, type StdoutMessage } from '@bobsled-inc/protocol';

const INVALID_JSON_RE = /^Invalid JSON on protocol line (\d+):/;

/** The protocol messages of `input`. A JSON error would quote the line, which can hold a text. */
export async function* readMessages(input: Readable): AsyncGenerator<StdoutMessage> {
  try {
    yield* readProtocol(input);
  } catch (error) {
    const line = error instanceof Error ? INVALID_JSON_RE.exec(error.message)?.[1] : undefined;
    if (line === undefined) throw error;
    throw new CommandError(`Protocol line ${line} is not valid JSON.`, EXIT_ERROR);
  }
}
