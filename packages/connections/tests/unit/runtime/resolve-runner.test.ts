import { describe, expect, it, vi } from 'vitest';

import { CustomRunnerRegistry } from '../../../src/runtime/custom-runner.js';
import { resolveRunner } from '../../../src/runtime/resolve-runner.js';
import { builtinRunnerRegistry } from '../../../src/runtime/runners/index.js';
import type { IntegrationFile } from '../../../src/schemas/integration.js';
import type { SqlRunnerModule } from '../../../src/runtime/types.js';

const duckDbMemory: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'local_duck',
  source_type: 'duckdb',
  connection: {},
  auth: { type: 'memory' },
};

const snowflakePat: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'sf_prod',
  source_type: 'snowflake',
  connection: {
    account_identifier: 'xt12345',
    warehouse: 'COMPUTE_WH',
    role: 'DOGSLED_AI_ROLE',
  },
  auth: { type: 'pat', token: 'secret' },
};

const snowflakeSledhouse: IntegrationFile = {
  ...snowflakePat,
  name: 'sf_sledhouse',
  auth: { type: 'sledhouse_oidc' },
};

describe('resolveRunner — precedence: custom → built-in → fail', () => {
  it('uses the built-in DuckDB runner when no custom factory is registered', async () => {
    const runner = await resolveRunner(duckDbMemory);
    expect(typeof runner.run).toBe('function');
    await runner.close?.();
  });

  it('has a real built-in runner registered for every non-sledhouse Snowflake auth', () => {
    // Registry-level dispatch check. We assert the presence here instead of
    // calling resolveRunner on a fake integration because that would load the
    // real snowflake-sdk driver (it is hoisted by pnpm as a loader dep) and
    // attempt a network handshake with fake credentials. Per-dialect behavior
    // is covered by the builder-level tests in `runners/*.test.ts`.
    expect(builtinRunnerRegistry.has('snowflake', 'pat')).toBe(true);
    expect(builtinRunnerRegistry.has('snowflake', 'rsa_key')).toBe(true);
    expect(builtinRunnerRegistry.has('snowflake', 'oauth')).toBe(true);
    expect(builtinRunnerRegistry.has('snowflake', 'sledhouse_oidc')).toBe(false);
  });

  it('throws "No runner available" for (snowflake, sledhouse_oidc) when no custom factory is present', async () => {
    // sledhouse_oidc is a custom-only auth type — there is no built-in for it
    // at any point, so the resolver falls straight through to the "no runner
    // available" error instead of the "not implemented yet" deferred message.
    await expect(resolveRunner(snowflakeSledhouse)).rejects.toThrow(/No runner available/);
  });

  it('custom factory wins over the built-in, even for DuckDB', async () => {
    const customModule: SqlRunnerModule = {
      run: vi.fn(async () => ({ rowCount: 42 })),
    };
    const factory = vi.fn(async () => customModule);

    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    const resolved = await resolveRunner(duckDbMemory, { customRunners });
    expect(resolved).toBe(customModule);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(duckDbMemory, expect.objectContaining({}));
  });

  it('passes the statement limit to the runner factory', async () => {
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({ run: vi.fn() }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    await resolveRunner(duckDbMemory, { customRunners, statementTimeoutMs: 60_000 });
    expect(factory).toHaveBeenCalledWith(
      duckDbMemory,
      expect.objectContaining({ statementTimeoutMs: 60_000 })
    );
  });

  it('custom factory satisfies (snowflake, sledhouse_oidc) that built-ins never implement', async () => {
    const customModule: SqlRunnerModule = { run: vi.fn(async () => ({ rowCount: 0 })) };
    const factory = vi.fn(async () => customModule);

    const customRunners = new CustomRunnerRegistry();
    customRunners.register('snowflake', 'sledhouse_oidc', factory);

    await expect(resolveRunner(snowflakeSledhouse, { customRunners })).resolves.toBe(customModule);
  });

  it('custom factory key mismatch falls through to the built-in registry', async () => {
    // Dispatch semantics: a custom factory registered under a different
    // auth_type must not shadow the built-in for the requested auth_type.
    // We verify with DuckDB (memory) so no external driver is touched.
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', vi.fn());

    const resolved = await resolveRunner(duckDbMemory, { customRunners });
    expect(typeof resolved.run).toBe('function');
    await resolved.close?.();
  });

  it('throws a detailed "no runner available" error when both registries miss', async () => {
    // Manually craft an integration whose source_type is in the schema but
    // whose (source_type, auth_type) is not covered by the built-in registry.
    // We can't easily fabricate this with the discriminated union, so instead
    // inject a garbage source_type by casting — validates the error path.
    const bogus = { ...duckDbMemory, source_type: 'unknown' } as unknown as IntegrationFile;
    await expect(resolveRunner(bogus)).rejects.toThrow(/No runner available/);
  });

  it('passes secretResolver through to the chosen factory', async () => {
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({
      run: async () => ({ rowCount: 0 }),
    }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    const secretResolver = { resolve: vi.fn(async () => 'value') };
    await resolveRunner(duckDbMemory, { customRunners, secretResolver });

    expect(factory).toHaveBeenCalledWith(duckDbMemory, { secretResolver });
  });

  it('forwards the warehouse override into the factory context', async () => {
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({
      run: async () => ({ rowCount: 0 }),
    }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    await resolveRunner(duckDbMemory, { customRunners, warehouse: 'BIG_WH' });

    expect(factory).toHaveBeenCalledWith(
      duckDbMemory,
      expect.objectContaining({ warehouse: 'BIG_WH' })
    );
  });

  it('forwards a trusted query tag into the factory context', async () => {
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({
      run: async () => ({ rowCount: 0 }),
    }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    await resolveRunner(duckDbMemory, { customRunners, queryTag: 'custom:model-run:123' });

    expect(factory).toHaveBeenCalledWith(
      duckDbMemory,
      expect.objectContaining({ queryTag: 'custom:model-run:123' })
    );
  });

  it('rejects an invalid query tag before invoking a custom factory', async () => {
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({
      run: async () => ({ rowCount: 0 }),
    }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    await expect(
      resolveRunner(duckDbMemory, { customRunners, queryTag: 'trusted\nmetadata' })
    ).rejects.toThrow(/control characters/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('forwards the refreshable tokenProvider into the factory context', async () => {
    // This is the exact seam Model Spec models + entity-graph share: both reach the
    // warehouse runner through resolveRunner, so proving the provider lands in
    // the (real) factory context here is what guarantees mid-run refresh engages
    // for those paths — the runner-level refresh proof lives in runners/*.test.ts.
    const factory = vi.fn(async (): Promise<SqlRunnerModule> => ({
      run: async () => ({ rowCount: 0 }),
    }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'memory', factory);

    const tokenProvider = vi.fn(async () => ({ accessToken: 'tok-1', expiresAt: 10_000 }));
    await resolveRunner(duckDbMemory, { customRunners, tokenProvider });

    expect(factory).toHaveBeenCalledWith(duckDbMemory, expect.objectContaining({ tokenProvider }));
  });
});
