import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { command, publicApi } from './harness.mjs';

let container;
let postgresPort;
export function postgresContainerName() {
  return container;
}
export async function postgres() {
  if (process.env.BOBSLED_CORE_E2E_POSTGRES_PORT)
    return Number(process.env.BOBSLED_CORE_E2E_POSTGRES_PORT);
  if (postgresPort) return postgresPort;
  container = `bobsled-e2e-${randomUUID()}`;
  await command(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--label',
      'org.dogsled.showcase=phase4-e2e',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=256m',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=showcase',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ],
    { timeout: 180_000 }
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await command(
      'docker',
      ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'showcase'],
      { expected: null }
    );
    if (ready.code === 0) {
      const binding = await command('docker', ['port', container, '5432/tcp']);
      const match = binding.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
      const port = match ? Number(match[1]) : 0;
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        postgresPort = port;
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Postgres did not become ready within 30 seconds');
}
export async function postgresSql(sql) {
  if (process.env.BOBSLED_CORE_E2E_POSTGRES_PORT) {
    const { resolveRunner } = await publicApi('connections');
    const runner = await resolveRunner({
      spec_version: '1',
      type: 'integration',
      name: 'local_pg',
      source_type: 'postgres',
      connection: {
        host: '127.0.0.1',
        port: Number(process.env.BOBSLED_CORE_E2E_POSTGRES_PORT),
        database: 'showcase',
      },
      auth: { type: 'password', user: 'postgres', password: 'unused-local-only' },
    });
    try {
      return (await runner.query(sql)).map((row) => Object.values(row).join('|')).join('\n');
    } finally {
      await runner.close?.();
    }
  }
  await postgres();
  const result = await command('docker', [
    'exec',
    '-i',
    container,
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    'postgres',
    '-d',
    'showcase',
    '-tA',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
  return result.stdout.trim();
}
export async function stopServices() {
  if (container) await command('docker', ['rm', '--force', container], { expected: null });
  container = undefined;
  postgresPort = undefined;
}
export function postgresFlags(port, schema = 'public') {
  return [
    '--postgres-host',
    '127.0.0.1',
    '--postgres-port',
    String(port),
    '--postgres-database',
    'showcase',
    '--postgres-user',
    'postgres',
    '--postgres-schema',
    schema,
    '--postgres-password',
    '$SHOWCASE_PG_PASSWORD',
  ];
}
export async function mockApi(ctx, datasets, options = {}) {
  const key = path.join(ctx.project, 'local-key.pem');
  const cert = path.join(ctx.project, 'local-cert.pem');
  const config = path.join(ctx.project, 'local-openssl.cnf');
  await ctx.write('local-openssl.cnf', '');
  await command(
    'openssl',
    [
      'req',
      '-config',
      config,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { env: ctx.env }
  );
  const requests = [];
  const token = options.token ?? 'showcase-local-key';
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      const url = new URL(req.url, 'https://localhost');
      const authorized = req.headers.authorization === `Bearer ${token}`;
      requests.push({
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        since: url.searchParams.get('since'),
        authorized,
      });
      res.setHeader('content-type', 'application/json');
      if (!authorized) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (url.pathname === '/advance' && req.method === 'POST' && options.advance) {
        try {
          options.advance();
          res.end(JSON.stringify({ advanced: true }));
        } catch {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'Already advanced' }));
        }
        return;
      }
      const all = datasets[url.pathname.slice(1)];
      if (!all) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      const filtered = all.filter((row) => row.id > Number(url.searchParams.get('since') ?? 0));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const rows = filtered.slice(offset, offset + 100);
      res.end(
        JSON.stringify({
          data: rows,
          next_cursor: offset + 100 < filtered.length ? String(offset + 100) : null,
        })
      );
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(ctx.env, {
    SHOWCASE_API_URL: `https://127.0.0.1:${server.address().port}`,
    SHOWCASE_API_AUTHORITY: `127.0.0.1:${server.address().port}`,
    SHOWCASE_API_TOKEN: token,
    NODE_EXTRA_CA_CERTS: cert,
    BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
  });
  return {
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
    assertAuth: () => {
      assert.ok(requests.length > 0);
      assert.ok(requests.every((request) => request.authorized));
    },
  };
}
export async function apiProject(ctx, resources, incremental = false) {
  await ctx.write('extractor.yml', {
    integrations_dir: 'integrations',
    resources_dir: 'resources',
    state_dir: '.extractor',
    output_dir: 'output',
  });
  await ctx.write('integrations/shop_api.yml', {
    spec_version: '1',
    type: 'integration',
    name: 'shop_api',
    auth_env_vars: ['SHOWCASE_API_TOKEN'],
    transport: {
      type: 'http',
      base_url: ctx.env.SHOWCASE_API_URL,
      auth: { type: 'bearer', token: '${{ env.SHOWCASE_API_TOKEN }}' },
    },
  });
  for (const [name, fields] of Object.entries(resources)) {
    await ctx.write(`resources/shop_api/${name}.yml`, {
      spec_version: '1',
      type: 'resource',
      description: 'Fictional paginated shop records.',
      name,
      integration: 'shop_api',
      api: { endpoint: `/${name}`, method: 'GET' },
      input: { id: { type: 'integer' } },
      query: { filters: { id: { operators: ['eq'], bind: { eq: { input: 'id' } } } } },
      output: Object.fromEntries(
        Object.entries(fields).map(([key, type]) => [key, { type, path: `$.${key}` }])
      ),
      extract: {
        record_path: '$.data',
        pagination: { type: 'cursor', cursor_path: '$.next_cursor', cursor_param: 'cursor' },
        ...(incremental
          ? { incremental: { cursor_field: 'id', cursor_param: 'since', cursor_type: 'integer' } }
          : {}),
        table: { primary_key: ['id'], load_strategy: incremental ? 'append' : 'full_refresh' },
      },
    });
  }
}
