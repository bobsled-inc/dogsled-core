import type { Readable } from 'node:stream';

/** Bound each frame before decoding it, including input that never ends a line. */
export async function* boundedLines(input: Readable, maxBytes: number): AsyncGenerator<string> {
  const frame = Buffer.allocUnsafe(maxBytes);
  let length = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - start;
      if (length + size > maxBytes) throw new Error(`MCP request exceeds ${maxBytes} bytes.`);
      chunk.copy(frame, length, start, end);
      length += size;
      if (newline === -1) break;
      yield frame.subarray(0, length).toString('utf8').replace(/\r$/u, '');
      length = 0;
      start = newline + 1;
    }
  }
  if (length) yield frame.subarray(0, length).toString('utf8').replace(/\r$/u, '');
}
