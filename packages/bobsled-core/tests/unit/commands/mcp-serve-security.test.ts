import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMcpServe } from '../../../src/commands/mcp-serve.js';
const state = vi.hoisted(() => ({
  lines: [] as string[],
  query: vi.fn(async () => [{ id: 1 }]),
  close: vi.fn(async () => {}),
}));
vi.mock('node:readline', () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      yield* state.lines;
    },
    close() {},
  }),
}));
vi.mock('@bobsled-inc/model-spec/project', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bobsled-inc/model-spec/project')>()),
  loadProject: vi.fn(async () => ({ sources: new Map([['support.docs', 'safe.docs__chunks']]) })),
}));
vi.mock('@bobsled-inc/model-spec/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bobsled-inc/model-spec/shared')>()),
  loadRunnerModule: vi.fn(async () => ({ query: state.query, close: state.close })),
}));
vi.mock('@bobsled-inc/entity-graph/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bobsled-inc/entity-graph/api')>()),
  loadEntityGraphProjectContext: vi.fn(async () => {
    throw new Error('no entity specs');
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.query.mockClear();
  state.close.mockClear();
});
function call(source_table: string, id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'read_source', arguments: { source_table } },
  });
}
describe('MCP CLI warehouse boundary', () => {
  it('denies declared-source reads without an adapter even with a principal', async () => {
    vi.stubEnv('DOGSLED_MCP_ALLOW_UNFILTERED', undefined);
    state.lines = [call('safe.docs__chunks')];
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runMcpServe({ transport: 'stdio', runner: 'synthetic-runner', principalId: 'test-user' });
    expect(state.query).not.toHaveBeenCalled();
    expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain(
      'PermissionsNotConfigured'
    );
    expect(state.close).toHaveBeenCalledOnce();
  });
  it('restricts explicitly unfiltered reads to project declarations', async () => {
    vi.stubEnv('DOGSLED_MCP_ALLOW_UNFILTERED', '1');
    state.lines = [call('other.secret'), call('safe.docs__chunks', 2)];
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runMcpServe({ transport: 'stdio', runner: 'synthetic-runner', allowUnfiltered: true });
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM safe.docs__chunks LIMIT 100'
    );
    expect(output.mock.calls.map(([text]) => String(text)).join('')).toContain('not declared');
  });
});
