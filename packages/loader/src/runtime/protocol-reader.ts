import type { Readable } from 'node:stream';

import { CommandError, parseRequiredStdoutMessage } from '@bobsled-inc/protocol';

import type { StdoutMessage } from '@bobsled-inc/protocol';

/** Maximum encoded size of one JSONL protocol message (excluding the newline). */
export const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Read newline-delimited JSON from a stream, splitting only on \n.
 *
 * Node.js `readline` treats Unicode line/paragraph separators (U+2028, U+2029)
 * as line breaks, which corrupts JSON strings containing those characters.
 * This custom reader only splits on \n to avoid that issue.
 */
async function* readLines(input: Readable): AsyncGenerator<string> {
  let pending: Buffer | undefined;
  let pendingLength = 0;

  for await (const chunk of input) {
    const buf: Buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(0x0a, start)) !== -1) {
      const segment = buf.subarray(start, idx);
      const lineLength = pendingLength + segment.length;
      assertProtocolLineSize(lineLength);
      if (pendingLength === 0) {
        yield segment.toString('utf8');
      } else {
        segment.copy(pending!, pendingLength);
        yield pending!.subarray(0, lineLength).toString('utf8');
        pendingLength = 0;
      }
      start = idx + 1;
    }

    if (start < buf.length) {
      const remainder = buf.subarray(start);
      assertProtocolLineSize(pendingLength + remainder.length);
      pending ??= Buffer.allocUnsafe(MAX_PROTOCOL_LINE_BYTES);
      remainder.copy(pending, pendingLength);
      pendingLength += remainder.length;
    }
  }

  if (pendingLength > 0) {
    assertProtocolLineSize(pendingLength);
    yield pending!.subarray(0, pendingLength).toString('utf8');
  }
}

function assertProtocolLineSize(size: number): void {
  if (size > MAX_PROTOCOL_LINE_BYTES) {
    throw new CommandError(`Protocol line exceeds the ${MAX_PROTOCOL_LINE_BYTES}-byte limit`, 2);
  }
}

export async function* readProtocol(
  input: Readable = process.stdin
): AsyncGenerator<StdoutMessage> {
  let lineNumber = 0;

  for await (const rawLine of readLines(input)) {
    lineNumber += 1;

    if (rawLine.length === 0 || rawLine === '\r') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON on protocol line ${lineNumber}: ${message}`);
    }

    try {
      const message = parseRequiredStdoutMessage(parsed);
      yield message;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CommandError) {
        throw new CommandError(
          `Invalid protocol message on line ${lineNumber}: ${message}`,
          error.exitCode
        );
      }
      throw new Error(`Invalid protocol message on line ${lineNumber}: ${message}`);
    }
  }
}
