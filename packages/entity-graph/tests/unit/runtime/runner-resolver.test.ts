import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedIntegration } from '@bobsled-inc/model-spec/project';

const mocks = vi.hoisted(() => ({
  buildSecretResolver: vi.fn(),
  interpolateSecrets: vi.fn(),
  loadRunnerModule: vi.fn(),
  resolveRunner: vi.fn(),
  createTokenCommandProvider: vi.fn((_command: string) => async () => ({
    accessToken: 'minted',
    expiresAt: 10_000,
  })),
}));

vi.mock('@bobsled-inc/model-spec/project', () => ({
  buildSecretResolver: mocks.buildSecretResolver,
}));

vi.mock('@bobsled-inc/model-spec/shared', () => ({
  loadRunnerModule: mocks.loadRunnerModule,
}));

vi.mock('@bobsled-inc/connections', () => ({
  interpolateSecrets: mocks.interpolateSecrets,
  resolveRunner: mocks.resolveRunner,
  createTokenCommandProvider: mocks.createTokenCommandProvider,
}));

const { resolveEntityGraphRunner } = await import('../../../src/runtime/runner-resolver.js');

const integration = {
  handle: 'warehouse',
  dialect: 'duckdb',
  targetSchema: 'entity_graph',
  integration: {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'memory' },
  },
} as ResolvedIntegration;

describe('resolveEntityGraphRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets the legacy --runner path win over integration-backed execution', async () => {
    const runner = { run: vi.fn() };
    mocks.loadRunnerModule.mockResolvedValue(runner);

    const handle = await resolveEntityGraphRunner({
      cwd: '/project',
      runnerPath: './runner.mjs',
      integration,
    });

    expect(handle?.source).toBe('runner_path');
    expect(handle?.runner).toBe(runner);
    expect(mocks.loadRunnerModule).toHaveBeenCalledWith('./runner.mjs');
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
    await expect(handle?.close()).resolves.toBeUndefined();
  });

  it('resolves an integration-backed runner and closes it', async () => {
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: { schema: 'entity_graph' } };
    const close = vi.fn();
    const runner = { run: vi.fn(), query: vi.fn(), close };
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue(runner);

    const handle = await resolveEntityGraphRunner({
      cwd: '/project',
      integration,
      secrets: 'secrets.yml',
    });

    expect(handle?.source).toBe('integration');
    expect(handle?.runner).toBe(runner);
    expect(mocks.buildSecretResolver).toHaveBeenCalledWith('/project', 'secrets.yml');
    expect(mocks.interpolateSecrets).toHaveBeenCalledWith(integration.integration, secretResolver);
    expect(mocks.resolveRunner).toHaveBeenCalledWith(interpolated, { secretResolver });

    await handle?.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('threads `customRunners` through to resolveRunner on the integration branch', async () => {
    // Mirrors `runProject`'s `customRunners` hook for Model Spec — entity-graph
    // runs in agents-elt depend on this so the BigQuery WIF / Snowflake
    // OIDC / Sledhouse OIDC factories from `@dogsled/lakehouse-execution`
    // win over Dogsled's default driver dispatch.
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: {} };
    const runner = { run: vi.fn(), close: vi.fn() };
    const customRunners = { get: vi.fn(), keys: vi.fn(() => []) } as never;
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue(runner);

    const handle = await resolveEntityGraphRunner({
      cwd: '/project',
      integration,
      customRunners,
    });

    expect(handle?.source).toBe('integration');
    expect(mocks.resolveRunner).toHaveBeenCalledWith(interpolated, {
      secretResolver,
      customRunners,
    });
  });

  it('threads an explicit `tokenProvider` through to resolveRunner without building a command provider', async () => {
    // A multi-hour entity-graph phase against a managed BigQuery/Snowflake
    // warehouse must hand the refreshable provider to the connections runner —
    // the runner-level proactive + reactive proof lives in @bobsled-inc/connections.
    mocks.createTokenCommandProvider.mockClear();
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: {} };
    const runner = { run: vi.fn(), close: vi.fn() };
    const tokenProvider = vi.fn(async () => ({ accessToken: 'tok-1', expiresAt: 10_000 }));
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue(runner);

    await resolveEntityGraphRunner({ cwd: '/project', integration, tokenProvider });

    // The explicit provider wins — the command path must NOT be consulted.
    expect(mocks.resolveRunner).toHaveBeenCalledWith(interpolated, {
      secretResolver,
      tokenProvider,
    });
    expect(mocks.createTokenCommandProvider).not.toHaveBeenCalled();
  });

  it('builds a provider from `credentialsTokenCommand` when no provider is given', async () => {
    mocks.createTokenCommandProvider.mockClear();
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: {} };
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue({ run: vi.fn(), close: vi.fn() });

    await resolveEntityGraphRunner({
      cwd: '/project',
      integration,
      credentialsTokenCommand: 'mint-token.sh',
    });

    const call = mocks.resolveRunner.mock.calls.at(-1);
    expect(typeof (call?.[1] as { tokenProvider?: unknown }).tokenProvider).toBe('function');
    expect(mocks.createTokenCommandProvider).toHaveBeenCalledWith('mint-token.sh');
  });

  it('falls back to DOGSLED_CREDENTIALS_TOKEN_COMMAND (standalone / Cloud Run path)', async () => {
    mocks.createTokenCommandProvider.mockClear();
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: {} };
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue({ run: vi.fn(), close: vi.fn() });
    process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'] = 'env-mint.sh';
    try {
      await resolveEntityGraphRunner({ cwd: '/project', integration });
    } finally {
      delete process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
    }

    const call = mocks.resolveRunner.mock.calls.at(-1);
    expect(typeof (call?.[1] as { tokenProvider?: unknown }).tokenProvider).toBe('function');
    expect(mocks.createTokenCommandProvider).toHaveBeenCalledWith('env-mint.sh');
  });

  it('omits `customRunners` from the resolveRunner call when the caller did not set it', async () => {
    // Back-compat with every existing caller — must not start passing
    // `customRunners: undefined` into resolveRunner where it would override
    // existing dispatch semantics.
    const secretResolver = { get: vi.fn() };
    const interpolated = { ...integration.integration, connection: {} };
    const runner = { run: vi.fn(), close: vi.fn() };
    mocks.buildSecretResolver.mockResolvedValue(secretResolver);
    mocks.interpolateSecrets.mockResolvedValue(interpolated);
    mocks.resolveRunner.mockResolvedValue(runner);

    await resolveEntityGraphRunner({
      cwd: '/project',
      integration,
    });

    expect(mocks.resolveRunner).toHaveBeenCalledWith(interpolated, { secretResolver });
  });

  it('ignores `customRunners` when `runnerPath` is set (path takes precedence)', async () => {
    const runner = { run: vi.fn(), close: vi.fn() };
    mocks.loadRunnerModule.mockResolvedValue(runner);
    const customRunners = { get: vi.fn(), keys: vi.fn(() => []) } as never;

    const handle = await resolveEntityGraphRunner({
      cwd: '/project',
      runnerPath: './runner.mjs',
      integration,
      customRunners,
    });

    expect(handle?.source).toBe('runner_path');
    // Path-driven dispatch never consults the registry.
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
  });

  it('returns undefined when no execution mechanism is configured', async () => {
    await expect(resolveEntityGraphRunner({ cwd: '/project' })).resolves.toBeUndefined();
  });

  it('falls back to a project-local runner.js when present', async () => {
    const runner = { run: vi.fn(), close: vi.fn() };
    mocks.loadRunnerModule.mockResolvedValue(runner);

    // Avoid relying on this repository having a real runner.js checked in.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-runner-fallback-'));
    fs.writeFileSync(path.join(tmpDir, 'runner.js'), 'export async function run() {}');
    try {
      const fallback = await resolveEntityGraphRunner({
        cwd: tmpDir,
        allowLocalRunnerFallback: true,
      });
      expect(fallback?.source).toBe('local_runner');
      expect(fallback?.runner).toBe(runner);
      expect(mocks.loadRunnerModule).toHaveBeenCalledWith(path.join(tmpDir, 'runner.js'));
      await fallback?.close();
      expect(runner.close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not load project-local runner.js when fallback is disabled', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-runner-fallback-disabled-'));
    fs.writeFileSync(path.join(tmpDir, 'runner.js'), 'export async function run() {}');
    try {
      const handle = await resolveEntityGraphRunner({
        cwd: tmpDir,
        allowLocalRunnerFallback: false,
      });
      expect(handle).toBeUndefined();
      expect(mocks.loadRunnerModule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
