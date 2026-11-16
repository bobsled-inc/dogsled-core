import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from './middleware';

const origin = 'http://127.0.0.1:3333';
function request(method = 'GET', headers: Record<string, string> = {}, path = '/api/query') {
  return new NextRequest(origin + path, {
    method,
    headers: { host: '127.0.0.1:3333', ...headers },
  });
}
function token() {
  return middleware(request()).headers.get('x-middleware-request-x-bobsled-explorer-token')!;
}

describe('Explorer local request protection', () => {
  it.each([undefined, 'null', 'invalid', 'https://example.com', 'http://127.0.0.1:9999'])(
    'rejects origin %s even with a loopback referer',
    (source) => {
      const response = middleware(
        request('POST', {
          ...(source ? { origin: source } : {}),
          referer: origin,
          'content-type': 'application/json',
          'x-bobsled-explorer-token': token(),
        })
      );
      expect(response.status).toBe(403);
    }
  );
  it('requires JSON and the current launch token', () => {
    expect(
      middleware(
        request('POST', {
          origin,
          'content-type': 'text/plain',
          'x-bobsled-explorer-token': token(),
        })
      ).status
    ).toBe(415);
    expect(middleware(request('POST', { origin, 'content-type': 'application/json' })).status).toBe(
      403
    );
    expect(
      middleware(
        request('POST', {
          origin,
          'content-type': 'application/json',
          'x-bobsled-explorer-token': 'wrong',
        })
      ).status
    ).toBe(403);
    expect(
      middleware(
        request('POST', {
          origin,
          'content-type': 'application/json; charset=utf-8',
          'x-bobsled-explorer-token': token(),
        })
      ).headers.get('x-middleware-next')
    ).toBe('1');
  });
  it('protects server rendered pages from rebinding', () => {
    expect(config.matcher).toBe('/:path*');
    expect(
      middleware(request('GET', { host: 'example.com' }, '/entity-graph/resolve/clusters/one'))
        .status
    ).toBe(403);
  });
  it('overwrites client supplied token metadata on GET', () => {
    expect(
      middleware(request('GET', { 'x-bobsled-explorer-token': 'forged' })).headers.get(
        'x-middleware-request-x-bobsled-explorer-token'
      )
    ).toBe(token());
  });
  it('refuses requests without Host, including public assets and image optimization', () => {
    expect(middleware(new NextRequest(origin + '/favicon.ico')).status).toBe(403);
    const page = new NextRequest(origin + '/entity-graph/resolve/clusters/one');
    expect(middleware(page).status).toBe(403);
    expect(middleware(new NextRequest(origin + '/_next/image?url=/api/query')).status).toBe(403);
  });
});
