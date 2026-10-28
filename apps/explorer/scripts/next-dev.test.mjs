import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  createNextArgs,
  findAvailablePort,
  isPortAvailable,
  parseCliArgs,
  resolveRequestedHostname,
  resolveDevPort,
} from './next-dev.mjs';

test('parseCliArgs extracts --port values and preserves other flags', () => {
  const result = parseCliArgs(['--turbo', '--port', '4000', '--hostname', '127.0.0.1']);

  assert.deepEqual(result, {
    explicitPort: 4000,
    forwardedArgs: ['--turbo', '--hostname', '127.0.0.1'],
  });
});

test('parseCliArgs accepts --port=value syntax', () => {
  const result = parseCliArgs(['--port=4555']);

  assert.deepEqual(result, {
    explicitPort: 4555,
    forwardedArgs: [],
  });
});

test('parseCliArgs ignores pnpm argument separators', () => {
  const result = parseCliArgs(['--', '--port', '4666', '--', '--turbo']);

  assert.deepEqual(result, {
    explicitPort: 4666,
    forwardedArgs: ['--turbo'],
  });
});

test('resolveDevPort falls forward when the default port is busy', async () => {
  const result = await resolveDevPort(
    [],
    undefined,
    async (port, hostname) => port !== DEFAULT_PORT || hostname !== DEFAULT_HOSTNAME
  );

  assert.equal(result.requestedPort, DEFAULT_PORT);
  assert.equal(result.port, DEFAULT_PORT + 1);
  assert.equal(result.shouldFallback, true);
  assert.equal(result.hostname, DEFAULT_HOSTNAME);
});

test('resolveDevPort keeps explicit ports even when availability is false', async () => {
  const result = await resolveDevPort(['--port', '4100'], undefined, async () => false);

  assert.equal(result.port, 4100);
  assert.equal(result.requestedPort, 4100);
  assert.equal(result.shouldFallback, false);
});

test('findAvailablePort returns the first open port in range', async () => {
  const port = await findAvailablePort(5000, async (candidate) => candidate === 5002);

  assert.equal(port, 5002);
});

test('isPortAvailable reflects live listeners', async () => {
  const server = net.createServer();

  await new Promise((resolve) => {
    server.listen({ port: 0, host: DEFAULT_HOSTNAME }, resolve);
  });

  const address = server.address();

  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const port = address.port;

  assert.equal(await isPortAvailable(port, DEFAULT_HOSTNAME), false);

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  assert.equal(await isPortAvailable(port, DEFAULT_HOSTNAME), true);
});

test('resolveDevPort rejects invalid environment ports', async () => {
  await assert.rejects(() => resolveDevPort([], 'abc'), /Invalid PORT port/);
});

test('createNextArgs binds to localhost by default', () => {
  assert.deepEqual(createNextArgs(3333, []), ['dev', '--port', '3333', '-H', DEFAULT_HOSTNAME]);
});

test('resolveRequestedHostname uses the forwarded hostname when present', () => {
  assert.equal(resolveRequestedHostname(['--hostname', '127.0.0.1']), '127.0.0.1');
  assert.equal(resolveRequestedHostname(['--hostname=127.0.0.1']), '127.0.0.1');
  assert.equal(resolveRequestedHostname(['-H', '::1']), '::1');
  assert.equal(resolveRequestedHostname(['-H=::1']), '::1');
});

test('resolveRequestedHostname rejects flag-like tokens as hostname values', () => {
  assert.throws(() => resolveRequestedHostname(['--hostname', '--turbo']), /Missing value/);
  assert.throws(() => resolveRequestedHostname(['-H', '--turbo']), /Missing value/);
});

test('createNextArgs preserves explicit --hostname flags', () => {
  assert.deepEqual(createNextArgs(3333, ['--hostname', '127.0.0.1']), [
    'dev',
    '--port',
    '3333',
    '--hostname',
    '127.0.0.1',
  ]);
});

test('createNextArgs preserves explicit -H flags', () => {
  assert.deepEqual(createNextArgs(3333, ['-H', '127.0.0.1']), [
    'dev',
    '--port',
    '3333',
    '-H',
    '127.0.0.1',
  ]);
});

test('createNextArgs preserves explicit --hostname=value flags', () => {
  assert.deepEqual(createNextArgs(3333, ['--hostname=127.0.0.1']), [
    'dev',
    '--port',
    '3333',
    '--hostname=127.0.0.1',
  ]);
});

test('createNextArgs preserves explicit -H=value flags', () => {
  assert.deepEqual(createNextArgs(3333, ['-H=127.0.0.1']), [
    'dev',
    '--port',
    '3333',
    '-H=127.0.0.1',
  ]);
});

test('createNextArgs uses the explicit hostname argument when one is provided', () => {
  assert.deepEqual(createNextArgs(3333, ['--turbo'], '127.0.0.1'), [
    'dev',
    '--port',
    '3333',
    '-H',
    '127.0.0.1',
    '--turbo',
  ]);
});

for (const hostname of ['0.0.0.0', '::', '192.0.2.1', 'remote.example', 'localhost']) {
  test(`remote or unresolved hostname ${hostname} cannot reach the dev launcher`, async () => {
    for (const args of [
      ['--hostname', hostname],
      [`--hostname=${hostname}`],
      ['-H', hostname],
      [`-H=${hostname}`],
      ['--hostname', hostname, '--hostname', DEFAULT_HOSTNAME],
    ]) {
      assert.throws(() => resolveRequestedHostname(args), /local-only/);
      assert.throws(() => createNextArgs(3333, args), /local-only/);
      await assert.rejects(() => resolveDevPort(args, undefined), /local-only/);
    }
    assert.throws(() => createNextArgs(3333, [], hostname), /local-only/);
  });
}
