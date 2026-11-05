import { PassThrough, Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { boundedLines } from '../../../src/lib/bounded-lines.js';
it('rejects an oversized unfinished frame without waiting for newline or EOF', async () => {
  const input = new PassThrough();
  const result = (async () => {
    for await (const _ of boundedLines(input, 8)) {
      /* consume */
    }
  })();
  const rejected = expect(result).rejects.toThrow('exceeds 8 bytes');
  input.write('1234');
  input.write('56789');
  await rejected;
  expect(input.destroyed).toBe(true);
});
it('counts UTF-8 bytes and rejects an oversized completed frame', async () => {
  const result = (async () => {
    for await (const _ of boundedLines(Readable.from(['界界\n']), 5)) {
      /* consume */
    }
  })();
  await expect(result).rejects.toThrow('exceeds 5 bytes');
});
it('handles split UTF-8, CRLF, and several bounded frames in one large chunk', async () => {
  const bytes = Buffer.from('界\r\n');
  const lines: string[] = [];
  for await (const line of boundedLines(
    Readable.from([bytes.subarray(0, 1), bytes.subarray(1), Buffer.from('one\ntwo\nend')]),
    5
  )) {
    lines.push(line);
  }
  expect(lines).toEqual(['界', 'one', 'two', 'end']);
});

it('the MCP server returns a structured error for an oversized unfinished request', async () => {
  const { vi } = await import('vitest');
  const { serveOntologyMcp } = await import('../../../src/commands/ontology.js');
  const input = new PassThrough();
  const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const serving = serveOntologyMcp({});
    input.write(Buffer.alloc(1_000_001, 32));
    await serving;
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: expect.stringContaining('exceeds') },
    });
  } finally {
    stdin.mockRestore();
    stdout.mockRestore();
    input.destroy();
  }
});
