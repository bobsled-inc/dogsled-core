import { describe, expect, it, vi } from 'vitest';

import { EnvSecretResolver } from '../../../src/secrets/env-resolver.js';
import { interpolateSecrets } from '../../../src/secrets/interpolate.js';

describe('interpolateSecrets — new-shape `${{ env.VAR }}`', () => {
  it('replaces whole-string token with resolved value', async () => {
    const resolver = new EnvSecretResolver({ FOO: 'bar' });
    const out = await interpolateSecrets({ account: '${{ env.FOO }}' }, resolver, {
      authEnvVars: ['FOO'],
    });
    expect(out).toEqual({ account: 'bar' });
  });

  it('tolerates whitespace in the template', async () => {
    const resolver = new EnvSecretResolver({ FOO: 'bar' });
    const out = await interpolateSecrets({ account: '  ${{   env.FOO   }}  ' }, resolver, {
      authEnvVars: ['FOO'],
    });
    expect(out).toEqual({ account: 'bar' });
  });

  it('leaves non-template strings unchanged', async () => {
    const resolver = new EnvSecretResolver({ FOO: 'bar' });
    const out = await interpolateSecrets(
      { account: 'literal', greeting: 'hello ${{ env.FOO }} world' },
      resolver,
      { authEnvVars: ['FOO'] }
    );
    // Not whole-string → untouched. We deliberately do not support inline
    // substitution for integration fields; the extractor enforces the same.
    expect(out).toEqual({ account: 'literal', greeting: 'hello ${{ env.FOO }} world' });
  });

  it('walks nested objects', async () => {
    const resolver = new EnvSecretResolver({ SF_ACCOUNT: 'xt12345', SF_TOKEN: 'secret' });
    const out = await interpolateSecrets(
      {
        connection: { account_identifier: '${{ env.SF_ACCOUNT }}' },
        auth: { type: 'pat', token: '${{ env.SF_TOKEN }}' },
      },
      resolver,
      { authEnvVars: ['SF_ACCOUNT', 'SF_TOKEN'] }
    );
    expect(out).toEqual({
      connection: { account_identifier: 'xt12345' },
      auth: { type: 'pat', token: 'secret' },
    });
  });

  it('walks arrays', async () => {
    const resolver = new EnvSecretResolver({ P1: 'raw', P2: 'modeled' });
    const out = await interpolateSecrets(
      { project_ids: ['${{ env.P1 }}', '${{ env.P2 }}'] },
      resolver,
      { authEnvVars: ['P1', 'P2'] }
    );
    expect(out).toEqual({ project_ids: ['raw', 'modeled'] });
  });

  it('passes through non-string leaves', async () => {
    const resolver = new EnvSecretResolver({});
    const out = await interpolateSecrets(
      { port: 5432, read_only: true, roles: null, opts: undefined },
      resolver
    );
    expect(out).toEqual({ port: 5432, read_only: true, roles: null, opts: undefined });
  });

  it('throws when the env var is missing', async () => {
    const resolver = new EnvSecretResolver({});
    await expect(
      interpolateSecrets({ account: '${{ env.MISSING }}' }, resolver, { authEnvVars: ['MISSING'] })
    ).rejects.toMatchObject({ name: 'CommandError', exitCode: 2 });
  });
});

describe('interpolateSecrets — legacy `<field>_env` suffix', () => {
  it('strips the _env suffix and writes the resolved value', async () => {
    const resolver = new EnvSecretResolver({ SF_ACCOUNT: 'xt12345' });
    const out = await interpolateSecrets({ account_identifier_env: 'SF_ACCOUNT' }, resolver, {
      authEnvVars: ['SF_ACCOUNT'],
    });
    expect(out).toEqual({ account_identifier: 'xt12345' });
    expect(out).not.toHaveProperty('account_identifier_env');
  });

  it('does not override a new-shape value on the same logical field', async () => {
    const resolver = new EnvSecretResolver({ NEW: 'new-value', LEGACY: 'legacy-value' });
    const out = await interpolateSecrets(
      { account_identifier: '${{ env.NEW }}', account_identifier_env: 'LEGACY' },
      resolver,
      { authEnvVars: ['LEGACY', 'NEW'] }
    );
    expect(out).toEqual({ account_identifier: 'new-value' });
  });

  it('does not call the resolver for a _env field suppressed by a new-shape winner', async () => {
    const spy = vi.fn(async (name: string) => (name === 'NEW' ? 'new-value' : 'wrong'));
    const resolver = { resolve: spy };
    await interpolateSecrets(
      { account_identifier: '${{ env.NEW }}', account_identifier_env: 'LEGACY' },
      resolver,
      { authEnvVars: ['LEGACY', 'NEW'] }
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith('NEW');
  });

  it('invokes onLegacyField once on the first legacy field encountered', async () => {
    const resolver = new EnvSecretResolver({ SF_ACCOUNT: 'xt', WAREHOUSE: 'WH' });
    const onLegacyField = vi.fn();
    await interpolateSecrets(
      { account_identifier_env: 'SF_ACCOUNT', warehouse_env: 'WAREHOUSE' },
      resolver,
      { authEnvVars: ['SF_ACCOUNT', 'WAREHOUSE'], onLegacyField }
    );
    // Callback fires on the first legacy key seen in this run only.
    expect(onLegacyField).toHaveBeenCalledTimes(1);
  });

  it('invokes onLegacyField when a legacy key is present even if new-shape wins', async () => {
    // Regression: the deprecation callback must fire whenever a deprecated
    // `*_env` key appears, so users migrating field-by-field still see the
    // warning. A suppressed lookup (new-shape winner) must not swallow it.
    const resolver = new EnvSecretResolver({ NEW: 'new-value', LEGACY: 'legacy-value' });
    const onLegacyField = vi.fn();
    await interpolateSecrets(
      { account_identifier: '${{ env.NEW }}', account_identifier_env: 'LEGACY' },
      resolver,
      { authEnvVars: ['LEGACY', 'NEW'], onLegacyField }
    );
    expect(onLegacyField).toHaveBeenCalledTimes(1);
    expect(onLegacyField).toHaveBeenCalledWith('account_identifier_env');
  });

  it('never invokes the callback when only new-shape tokens are present', async () => {
    const resolver = new EnvSecretResolver({ SF_ACCOUNT: 'xt' });
    const onLegacyField = vi.fn();
    await interpolateSecrets({ account_identifier: '${{ env.SF_ACCOUNT }}' }, resolver, {
      authEnvVars: ['SF_ACCOUNT'],
      onLegacyField,
    });
    expect(onLegacyField).not.toHaveBeenCalled();
  });

  it('performs no IO when no callback is provided', async () => {
    const resolver = new EnvSecretResolver({ SF_ACCOUNT: 'xt' });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await interpolateSecrets({ account_identifier_env: 'SF_ACCOUNT' }, resolver, {
        authEnvVars: ['SF_ACCOUNT'],
      });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('throws when the legacy field references a missing env var', async () => {
    const resolver = new EnvSecretResolver({});
    await expect(
      interpolateSecrets({ account_identifier_env: 'MISSING' }, resolver, {
        authEnvVars: ['MISSING'],
      })
    ).rejects.toMatchObject({ name: 'CommandError', exitCode: 2 });
  });
});

describe('interpolateSecrets — deep shapes', () => {
  it('handles a full integration-shaped object', async () => {
    const resolver = new EnvSecretResolver({
      SF_ACCOUNT: 'xt12345.us-east-1',
      SF_TOKEN: 'sekret',
      SF_WAREHOUSE: 'COMPUTE_WH',
    });
    const out = await interpolateSecrets(
      {
        spec_version: '1',
        type: 'integration',
        name: 'snowflake_prod',
        source_type: 'snowflake',
        connection: {
          account_identifier: '${{ env.SF_ACCOUNT }}',
          warehouse_env: 'SF_WAREHOUSE',
          role: 'BOBSLED_CORE_AI_ROLE',
        },
        auth: { type: 'pat', token: '${{ env.SF_TOKEN }}' },
      },
      resolver,
      { authEnvVars: ['SF_ACCOUNT', 'SF_TOKEN', 'SF_WAREHOUSE'] }
    );

    expect(out).toEqual({
      spec_version: '1',
      type: 'integration',
      name: 'snowflake_prod',
      source_type: 'snowflake',
      connection: {
        account_identifier: 'xt12345.us-east-1',
        warehouse: 'COMPUTE_WH',
        role: 'BOBSLED_CORE_AI_ROLE',
      },
      auth: { type: 'pat', token: 'sekret' },
    });
  });
});
