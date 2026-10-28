/**
 * Reusable fake HTTP server for integration tests.
 *
 * Serves paginated JSON responses with configurable records, headers, and delays.
 */

import * as http from 'node:http';
import * as https from 'node:https';

export interface FakeEndpoint {
  path: string;
  method?: string;
  handler: (
    req: http.IncomingMessage,
    url: URL
  ) =>
    | {
        status?: number;
        headers?: Record<string, string>;
        body: unknown;
      }
    | Promise<{
        status?: number;
        headers?: Record<string, string>;
        body: unknown;
      }>;
}

export interface FakeServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function createFakeServer(endpoints: FakeEndpoint[]): Promise<FakeServer> {
  return createFakeServerInternal(http.createServer(createRequestHandler(endpoints)), 'http');
}

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

/**
 * Simple path pattern matching: /items/{id} matches /items/42
 */
function matchPathPattern(pattern: string, actual: string): boolean {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) return false;
  return patternParts.every((p, i) => p.startsWith('{') || p === actualParts[i]);
}

/**
 * Create paginated endpoint data with Link header pagination.
 */
export function paginatedRecords(
  records: Record<string, unknown>[],
  pageSize: number,
  baseUrl: string,
  pathPrefix: string
): FakeEndpoint {
  return {
    path: pathPrefix,
    handler: (_req, url) => {
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const pageRecords = records.slice(start, end);
      const hasNext = end < records.length;

      const headers: Record<string, string> = {};
      if (hasNext) {
        headers['Link'] = `<${baseUrl}${pathPrefix}?page=${page + 1}>; rel="next"`;
      }

      return { body: pageRecords, headers };
    },
  };
}

function createRequestHandler(endpoints: FakeEndpoint[]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost`);

    const endpoint = endpoints.find((e) => {
      const pathMatch = url.pathname === e.path || matchPathPattern(e.path, url.pathname);
      const methodMatch = !e.method || e.method === req.method;
      return pathMatch && methodMatch;
    });

    if (!endpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', path: url.pathname }));
      return;
    }

    const result = await endpoint.handler(req, url);
    const status = result.status ?? 200;
    const headers = { 'Content-Type': 'application/json', ...result.headers };

    res.writeHead(status, headers);
    res.end(JSON.stringify(result.body));
  };
}

async function createFakeServerInternal(
  server: http.Server | https.Server,
  protocol: 'http' | 'https'
): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      server.off('error', reject);
      const port = addr.port;
      resolve({
        url: `${protocol}://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const FAKE_SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDRa4ZBnYsPHYOJ
GLlNBBLs2CENPoDTkZYXKnQYYBD75zSOKdvhxgkuK9jW8YmObGFoEkTm+8Vs3Zbw
T7OCgDE+Rj5HF7JMjEkhHv9w+tp5Y3QnwFEeOoa9+fNjoDJCUYrERG9l3rtI+Z8K
atB9oTBVkTAIQSmc3v7D8OBHjrgj7mccC+3qgXmXXEtv0dYTtSX5E6E7dhNH1Gfx
oOPm6CfJK7S+BIVA/cG2qrojqFk6n1q6lXMGdqy4Ig6lDIseDgWyMmGaJgA7IEM9
sY5zypq4krHbx2irkoiy95jZzeMsp60o0dTI70M/XKI2zHQA8+cVLhTZps0w05/a
8RPDY3rpAgMBAAECggEABi+295k/0mJ80D/6uVu1c2mvEEUYaSeT13tZkp7D4a0i
0FBMPo8rFkIVVcQs3Bg3iGuBvZESc/TX0KGKHADNc5l/nXoFul0qi9/ui9fdPFjD
xajYvJvd/x6zIe5Jjcv63XFoGQpLXgyBtj0Ri6SHWP/A+31xTUEJJaCn/3Un22fR
0/H58NHsfUl25cLWgkeUx33Wbk+QAxEL/dt8HDJ8sMSz8PB9M0nNxJhS0xG18byq
IgRnLoZpZm22Izxtxj7A1mwKl1jHysBNu+LBzi/e1EhjMxg5vky17XVnn5zvqeHe
OhyKloZvBH3YtKZcWj8+gEql84HDRzrOBJsHO0VyQQKBgQDvXaD3JH+SjQ1kpL3h
BsaK4mKWy/xKc+P5IfBpQKpPRvzPsDukJGQaQ2Olu/wpYBDVUucyfd455BlwfhBs
cImaRC3WWZ1z2QI1vXw6H0Jr/WilZ4Q0aaS1EDsPdy1dWZf4msP0BpnjpVaI6z4M
tmb/km4Ga+rJNNu92Y5Ls4a54wKBgQDf+SeKgLxwqlB2w3GKlrSMZr4Ce2CeKosA
8I1PUcyJzAxrtnR/SjgxLsUKb4kk0b+6eMzFb4Z5l9qGwRd9h+TOLvWZnS2v4hrQ
pjndud00h27gny53GOCS0eYtvx1x4asx6big4e8WOR29/WYSlS6oGd73Zl4HBszf
97oTZO4BwwKBgAmpGLcAxRlQEgtOzs8HK/os+telMfB7TuceJIrK7lS2w7tKHI4a
XePldl8ZACtXUjaZ2vThuZdSimhM3jLSM+uC9uqgwUcMqhcrJ5lc65xaJOAQFnjb
Dqe0GP4dzDnpRMXm0SPHJGzYnm52OBHhRrTn3wLpVhd6x6eY4TJS84wLAoGBAJ4t
DCvYtzyqS6FUbj9+J4xwkwiVsaqCSSEkweee0WEP5kW72ZJ8DCtP6IByPNzv9QPw
hE17cfE1uXMpszlIW+LxbypJwxZQDLgGbR+WQA71Bu1D/kDGJPQLoQ/1xQnEYm8h
rO6SIZQESmj/KLM/AHBftQPsG8PCnbYe8h74TM6ZAoGAD6mEUI2MWhFdDVa1dFZW
2DbELuw/RM5OSxwbfQsaMqPPlrsZqGLZN+ET3uVGjJ4Tx1XYTpy6GsSGvIfmTUvE
jiK5cxc2sP+NvGupSrDSHvDPQCIug++iloGrkFyRzyjE8F17ncuWkjJsyhBE/XfG
JfNZmdiBZdY2QYoODWhbS/Q=
-----END PRIVATE KEY-----
`;

export const FAKE_SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIC8zCCAdugAwIBAgIUBjqunMa8Y8Vfsrw763XGoKhOBDQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDMyMjIzNTgyOFoXDTM2MDMx
OTIzNTgyOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0WuGQZ2LDx2DiRi5TQQS7NghDT6A05GWFyp0GGAQ++c0
jinb4cYJLivY1vGJjmxhaBJE5vvFbN2W8E+zgoAxPkY+RxeyTIxJIR7/cPraeWN0
J8BRHjqGvfnzY6AyQlGKxERvZd67SPmfCmrQfaEwVZEwCEEpnN7+w/DgR464I+5n
HAvt6oF5l1xLb9HWE7Ul+ROhO3YTR9Rn8aDj5ugnySu0vgSFQP3Btqq6I6hZOp9a
upVzBnasuCIOpQyLHg4FsjJhmiYAOyBDPbGOc8qauJKx28doq5KIsveY2c3jLKet
KNHUyO9DP1yiNsx0APPnFS4U2abNMNOf2vETw2N66QIDAQABoz0wOzAaBgNVHREE
EzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0OBBYEFOz8vgiid7vvIA5EOCrSZbI7
STxaMA0GCSqGSIb3DQEBCwUAA4IBAQBnBnwYuaV1WRFp0yMu5MV2Wvf9fIcKA6kC
XFZWtYR8+64iIkWioMIMCkExH58x2VdhKH1gTq1O8Z4Btpni+WReDxI8sKLGI2iA
fIrI7Ja216jOlfO/SBHoVGaoor/9mRmZonl16Db4IFzxO57DZSfEXS2/ExuFGp9R
6AzXdax5rUR5E43MwBmBV4r3q+94ZkRsZhRuH4JgIo/O8cV/En2Z8U2JTTzc4c7X
8JrifSqwwQqF5SxV0szoVDX7eZAdUpWhq66Ef9m4tLKQWN+nlN2iqmmW0Qa+QCGI
4SN9lk4+b51vYYskRwDYZBA5jfu5Ut1uI05mBcto8iLOVTxmL/DY
-----END CERTIFICATE-----
`;
