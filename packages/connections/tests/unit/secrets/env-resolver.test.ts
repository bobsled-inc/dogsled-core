import { describe, expect, it } from 'vitest';

import { EnvSecretResolver } from '../../../src/secrets/env-resolver.js';

describe('EnvSecretResolver', () => {
  it('reads from an injected source', async () => {
    const resolver = new EnvSecretResolver({ FOO: 'bar' });
    await expect(resolver.resolve('FOO')).resolves.toBe('bar');
  });

  it('throws CommandError when the var is missing', async () => {
    const resolver = new EnvSecretResolver({});
    await expect(resolver.resolve('MISSING')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects empty string values', async () => {
    const resolver = new EnvSecretResolver({ EMPTY: '' });
    await expect(resolver.resolve('EMPTY')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it.each(['DOGSLED_HOST_EMBEDDING_URL', 'DOGSLED_HOST_EMBEDDING_TOKEN'])(
    'never resolves %s, which only a host embedding stage may read',
    async (name) => {
      const resolver = new EnvSecretResolver({ [name]: 'must-not-appear' });
      const resolved = resolver.resolve(name);
      await expect(resolved).rejects.toMatchObject({ name: 'CommandError', exitCode: 2 });
      await expect(resolved).rejects.not.toThrow('must-not-appear');
    }
  );

  it('defaults to process.env when constructed with no argument', async () => {
    const prev = process.env['CONNECTIONS_TEST_TOKEN'];
    process.env['CONNECTIONS_TEST_TOKEN'] = 'hello';
    try {
      const resolver = new EnvSecretResolver();
      await expect(resolver.resolve('CONNECTIONS_TEST_TOKEN')).resolves.toBe('hello');
    } finally {
      if (prev === undefined) delete process.env['CONNECTIONS_TEST_TOKEN'];
      else process.env['CONNECTIONS_TEST_TOKEN'] = prev;
    }
  });
});
