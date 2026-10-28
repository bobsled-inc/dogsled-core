import { describe, expect, it, vi } from 'vitest';
import { withDeclaredSecretNames } from '../../../src/secrets/host-resolver.js';
import { interpolateSecrets } from '../../../src/secrets/interpolate.js';
import { EnvSecretResolver } from '../../../src/secrets/env-resolver.js';

describe('host resolver declarations', () => {
  it('authorizes only declared names through the supplied resolver', async () => {
    const resolve = vi.fn(async () => 'host-value');
    const resolver = withDeclaredSecretNames({ resolve }, ['HOST_PASSWORD']);
    expect(await interpolateSecrets({ password_env: 'HOST_PASSWORD' }, resolver)).toEqual({
      password: 'host-value',
    });
    await expect(
      interpolateSecrets({ password_env: 'AMBIENT_PASSWORD' }, resolver)
    ).rejects.toThrow('Undeclared environment variable: AMBIENT_PASSWORD');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('fails closed without a host declaration or an explicit resolver', async () => {
    const resolve = vi.fn();
    await expect(
      interpolateSecrets({ password_env: 'HOST_PASSWORD' }, { resolve })
    ).rejects.toThrow('Add HOST_PASSWORD to auth_env_vars');
    expect(resolve).not.toHaveBeenCalled();
    expect(() => withDeclaredSecretNames(undefined, ['HOST_PASSWORD'])).toThrow(
      'explicit host secretResolver'
    );
  });
  it('keeps the default resolver on YAML declarations', async () => {
    const resolver = new EnvSecretResolver({ CLI_PASSWORD: 'cli-value' });
    await expect(interpolateSecrets({ password_env: 'CLI_PASSWORD' }, resolver)).rejects.toThrow(
      'Undeclared'
    );
    expect(
      await interpolateSecrets(
        { auth_env_vars: ['CLI_PASSWORD'], password_env: 'CLI_PASSWORD' },
        resolver
      )
    ).toMatchObject({ password: 'cli-value' });
  });
});
