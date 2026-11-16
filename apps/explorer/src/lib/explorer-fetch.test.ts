import { afterEach, describe, expect, it, vi } from 'vitest';
import { explorerFetch } from './explorer-fetch';
afterEach(() => vi.unstubAllGlobals());
describe('Explorer browser token', () => {
  it('sends the launch token on same-origin mutations only', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', {
      location: { href: 'http://127.0.0.1:3333/', origin: 'http://127.0.0.1:3333' },
    });
    vi.stubGlobal('document', { querySelector: () => ({ content: 'launch-test-token' }) });
    await explorerFetch('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(fetcher.mock.calls[0]![1].headers.get('x-bobsled-explorer-token')).toBe(
      'launch-test-token'
    );
    expect(fetcher.mock.calls[0]![1].headers.get('content-type')).toBe('application/json');
    await explorerFetch('https://example.com/api', { method: 'POST' });
    expect(fetcher.mock.calls[1]![1].headers.has('x-bobsled-explorer-token')).toBe(false);
  });
});
