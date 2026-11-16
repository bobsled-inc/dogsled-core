import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { serveOntologyMcp } from '../../../src/commands/ontology.js';
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

async function exchange(requests: unknown[]) {
  const input = Readable.from([
    requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
  ]);
  const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await serveOntologyMcp({});
    return stdout.mock.calls.map((call) => JSON.parse(String(call[0])));
  } finally {
    stdin.mockRestore();
    stdout.mockRestore();
    input.destroy();
  }
}

it('answers health checks after initialization without replying to notifications', async () => {
  const responses = await exchange([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'health', method: 'ping' },
  ]);
  expect(responses).toHaveLength(2);
  expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 'health', result: {} });
});

it.each([true, false])(
  'reports import success and failure through MCP (valid: %s)',
  async (valid) => {
    const [response] = await exchange([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ontology_import',
          arguments: {
            documents: [
              {
                path: 'sales.yml',
                document: {
                  version: '0.2.0.dev0',
                  ...(valid ? { name: 'sales' } : {}),
                  ontology: [{ concept: 'Order', type: 'EntityType' }],
                },
              },
            ],
          },
        },
      },
    ]);
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(!valid);
    expect(JSON.parse(response.result.content[0].text).ok).toBe(valid);
  }
);

it('keeps invalid tool arguments as protocol errors', async () => {
  const [response] = await exchange([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ontology_import', arguments: { documents: 'invalid' } },
    },
  ]);
  expect(response).toMatchObject({ id: 1, error: { code: -32602 } });
  expect(response.result).toBeUndefined();
});
