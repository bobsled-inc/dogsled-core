import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';

export interface FakeEndpointResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FakeEndpoint {
  path: string;
  method?: string;
  handler: (
    req: http.IncomingMessage,
    url: URL
  ) => FakeEndpointResponse | Promise<FakeEndpointResponse>;
}

export interface FakeServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Creates an HTTPS fake server with the repo's test certificate material. */
export async function createFakeHttpsServer(endpoints: FakeEndpoint[]): Promise<FakeServer> {
  return createFakeServerInternal(
    https.createServer(
      {
        key: FAKE_SERVER_KEY,
        cert: FAKE_SERVER_CERT,
      },
      createRequestHandler(endpoints)
    ),
    'https'
  );
}

/** Supports `{id}`-style path segments used by the smoke-test fixtures. */
function matchPathPattern(pattern: string, actual: string): boolean {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) {
    return false;
  }

  return patternParts.every((part, index) => {
    const actualPart = actualParts[index];
    if (actualPart === undefined) {
      return false;
    }
    if (/^\{[^}]+\}$/.test(part)) {
      return actualPart.length > 0;
    }
    return part === actualPart;
  });
}

/** Routes requests to the first matching fake endpoint and serializes JSON responses. */
function createRequestHandler(endpoints: FakeEndpoint[]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const endpoint = endpoints.find((candidate) => {
      const pathMatch =
        url.pathname === candidate.path || matchPathPattern(candidate.path, url.pathname);
      const methodMatch = !candidate.method || candidate.method === req.method;
      return pathMatch && methodMatch;
    });

    if (!endpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', path: url.pathname }));
      return;
    }

    try {
      const result = await endpoint.handler(req, url);
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status ?? 200, {
        'Content-Type': 'application/json',
        ...result.headers,
      });
      res.end(payload);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  };
}

/** Boots a fake server on a random loopback port and exposes a promise-based close helper. */
async function createFakeServerInternal(
  server: http.Server | https.Server,
  protocol: 'http' | 'https'
): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      server.off('error', reject);
      resolve({
        url: `${protocol}://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          }),
      });
    });
  });
}

const FAKE_SERVER_KEY = readFileSync(
  new URL('../fixtures/fake-server-key.pem', import.meta.url),
  'utf-8'
);

export const FAKE_SERVER_CERT = readFileSync(
  new URL('../fixtures/fake-server-cert.pem', import.meta.url),
  'utf-8'
);
