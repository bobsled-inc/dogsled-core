import { describe, expect, it, vi } from 'vitest';

import {
  assertDeclaredEnv,
  assertDeclaredEnvironmentReferences,
  AuthEnvVarsSchema,
  declaredHostEnvironmentNames,
  deleteHostEmbeddingEnv,
  HOST_EMBEDDING_ENV_NAMES,
  HOST_EMBEDDING_TOKEN_ENV,
  HOST_EMBEDDING_URL_ENV,
  isHostEmbeddingEnvName,
  ModelConnectionSchema,
  requireHostEmbeddingEnv,
  validateModelProviderConfig,
  withDeclaredAuthEnvVars,
  withoutHostEmbeddingEnv,
} from '../../src/index.js';

const reservedNames = [...HOST_EMBEDDING_ENV_NAMES, 'dogsled_host_embedding_token'];

describe('host embedding environment names', () => {
  it('keeps the names stable', () => {
    expect(HOST_EMBEDDING_URL_ENV).toBe('DOGSLED_HOST_EMBEDDING_URL');
    expect(HOST_EMBEDDING_TOKEN_ENV).toBe('DOGSLED_HOST_EMBEDDING_TOKEN');
    expect(HOST_EMBEDDING_ENV_NAMES).toEqual([HOST_EMBEDDING_URL_ENV, HOST_EMBEDDING_TOKEN_ENV]);
  });

  it.each(reservedNames)('cannot be declared: %s', (name) => {
    expect(isHostEmbeddingEnvName(name)).toBe(true);
    const result = AuthEnvVarsSchema.safeParse(['SOURCE_TOKEN', name]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('reserved');
    expect(() => declaredHostEnvironmentNames([name], { [name]: 'value' })).toThrow(
      /^declaredEnvNames: .* reserved/
    );
  });

  it('leaves other names declarable', () => {
    expect(AuthEnvVarsSchema.parse(['DOGSLED_HOST_EMBEDDING', 'HOST_TOKEN'])).toHaveLength(2);
    expect(() => declaredHostEnvironmentNames(['not a name'], {})).toThrow(
      'declaredEnvNames must contain valid environment variable names.'
    );
  });

  it.each(reservedNames)('cannot be referenced even when something declares %s', (name) => {
    expect(() => assertDeclaredEnv(name, [name])).toThrow('reserved');
    expect(() =>
      assertDeclaredEnvironmentReferences({ password: `\${{ env.${name} }}` }, [name])
    ).toThrow('reserved');
    expect(() => assertDeclaredEnvironmentReferences({ token_env: name }, [name])).toThrow(
      'reserved'
    );
  });

  it.each(reservedNames)('cannot be the key of a model connection: %s', (name) => {
    for (const apiKey of [`$${name}`, `\${{ env.${name} }}`]) {
      const connection = { provider: 'openai', model: 'example', api_key: apiKey };
      expect(() => validateModelProviderConfig({ ...connection, auth_env_vars: [name] })).toThrow(
        'reserved'
      );
      expect(ModelConnectionSchema.safeParse(connection).success).toBe(false);
    }
  });

  it('is not added to a block that declares it', () => {
    const block = { auth_env_vars: [HOST_EMBEDDING_TOKEN_ENV] };
    expect(withDeclaredAuthEnvVars(block, ['SOURCE_TOKEN'])).toBe(block);
  });
});

describe('withoutHostEmbeddingEnv', () => {
  it('drops both names in any case and keeps the rest', () => {
    const env = {
      PATH: '/bin',
      EMPTY: undefined,
      DOGSLED_HOST_EMBEDDING_URL: 'https://host.example',
      Dogsled_Host_Embedding_Token: 'synthetic',
    };
    expect(withoutHostEmbeddingEnv(env)).toEqual({ PATH: '/bin', EMPTY: undefined });
    expect(Object.keys(env)).toHaveLength(4);
  });
});

describe('deleteHostEmbeddingEnv', () => {
  it('removes both names from the environment itself, in any case', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/bin',
      DOGSLED_HOST_EMBEDDING_URL: 'https://host.example',
      dogsled_host_embedding_token: 'synthetic',
    };
    deleteHostEmbeddingEnv(env);
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('requireHostEmbeddingEnv', () => {
  it('returns the endpoint and token', () => {
    expect(
      requireHostEmbeddingEnv({
        DOGSLED_HOST_EMBEDDING_URL: 'https://host.example',
        DOGSLED_HOST_EMBEDDING_TOKEN: 'synthetic',
      })
    ).toEqual({ url: 'https://host.example', token: 'synthetic' });
  });

  it.each([
    [{}, `${HOST_EMBEDDING_URL_ENV}, ${HOST_EMBEDDING_TOKEN_ENV}`],
    [{ DOGSLED_HOST_EMBEDDING_URL: 'https://host.example' }, HOST_EMBEDDING_TOKEN_ENV],
    [{ DOGSLED_HOST_EMBEDDING_TOKEN: 'synthetic' }, HOST_EMBEDDING_URL_ENV],
    [
      { DOGSLED_HOST_EMBEDDING_URL: '', DOGSLED_HOST_EMBEDDING_TOKEN: 'synthetic' },
      HOST_EMBEDDING_URL_ENV,
    ],
  ])('names what is missing from %j', (env, missing) => {
    const call = vi.fn(() => requireHostEmbeddingEnv(env));
    expect(call).toThrow(`Not set: ${missing}.`);
    expect(call).toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(call).not.toThrow('synthetic');
  });
});
