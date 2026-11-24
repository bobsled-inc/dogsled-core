import { readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  publishWithIntegrity,
  REGISTRY_WAIT_LIMIT_MS,
} from '../../scripts/release/registry-integrity.mjs';

beforeEach(() => vi.stubEnv('NPM_READ_TOKEN', 'test-read-only-token'));
afterEach(() => vi.unstubAllEnvs());

const request = {
  tarball: '/tmp/reviewed.tgz',
  packageName: '@example/toolkit',
  version: '0.1.0',
  access: 'public',
  visibility: 'public',
  integrity: 'sha512-reviewed',
};
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const MINUTE = 60_000;
const notFound = {
  status: 1,
  stdout: '',
  stderr: 'npm error code E404 https://secret@example.test',
};

/** Registry that answers `view` with `pending` until `visibleAt`, on a clock only waits advance. */
function fakeRegistry({ visibleAt = Infinity, pending = notFound, viewTime = 0 } = {}) {
  let time = 0;
  const waits = [];
  const lines = [];
  const run = vi.fn((_command, args) => {
    if (args[0] === 'publish') return ok();
    time += viewTime;
    return time >= visibleAt ? ok(JSON.stringify(request.integrity)) : pending;
  });
  const options = {
    now: () => time,
    wait: async (delay) => {
      waits.push(delay);
      time += delay;
    },
    log: (line) => lines.push(line),
  };
  return { run, options, waits, lines, elapsed: () => time };
}
const publishes = (run) => run.mock.calls.filter(([, args]) => args[0] === 'publish');

describe('registry release integrity', async () => {
  it('verifies a successful publication and requests provenance', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok(JSON.stringify(request.integrity)));
    expect(await publishWithIntegrity(request, run)).toEqual({
      alreadyPublished: false,
      integrity: request.integrity,
    });
    expect(run.mock.calls[0][1]).toContain('--provenance');
    expect(run.mock.calls[1][1]).toContain('dist.integrity');
  });

  it.each([
    ['private', 'restricted', '0.1.0', true, '--provenance=false', 'latest'],
    ['private', 'restricted', '0.1.1', false, '--provenance=false', 'latest'],
    ['private', 'restricted', '0.1.1-preview.1', false, '--provenance=false', 'preview'],
    ['public', 'public', '0.2.0-preview.2', false, '--provenance', 'preview'],
  ])(
    'publishes %s %s %s with bootstrap=%j',
    async (visibility, access, version, bootstrap, provenance, tag) => {
      const run = vi
        .fn()
        .mockReturnValueOnce(ok())
        .mockReturnValueOnce(ok(JSON.stringify(request.integrity)));
      await publishWithIntegrity({ ...request, visibility, access, version, bootstrap }, run);
      expect(run.mock.calls[0][1]).toEqual([
        'publish',
        request.tarball,
        '--access',
        access,
        provenance,
        '--tag',
        tag,
        '--ignore-scripts',
        '--registry',
        'https://registry.npmjs.org/',
      ]);
    }
  );

  it.each([
    { visibility: undefined },
    { visibility: 'internal' },
    { visibility: 'private' },
    { access: 'restricted' },
    { version: '1.0.0-preview.1' },
    { bootstrap: true },
    { visibility: 'private', access: 'restricted', version: '0.1.1', bootstrap: true },
  ])('rejects invalid publication settings before npm: %j', async (settings) => {
    const run = vi.fn();
    await expect(publishWithIntegrity({ ...request, ...settings }, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not retry a public provenance failure without provenance', async () => {
    const run = vi.fn().mockReturnValue({ status: 1, stderr: 'provenance unsupported' });
    await expect(publishWithIntegrity(request, run)).rejects.toThrow('npm publish failed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toContain('--provenance');
  });

  it('accepts an existing version only when the registry integrity matches', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr: 'Cannot publish over the previously published versions',
      })
      .mockReturnValueOnce(ok(JSON.stringify(request.integrity)));
    expect((await publishWithIntegrity(request, run)).alreadyPublished).toBe(true);
  });

  it('fails an already-published response with different tarball bytes', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: 'EPUBLISHCONFLICT' })
      .mockReturnValueOnce(ok(JSON.stringify('sha512-different')));
    await expect(publishWithIntegrity(request, run)).rejects.toThrow('does not match');
  });

  it('fails malformed registry integrity after the wait limit', async () => {
    const registry = fakeRegistry({ pending: ok('not-json') });
    await expect(publishWithIntegrity(request, registry.run, registry.options)).rejects.toThrow(
      'Malformed'
    );
    expect(registry.elapsed()).toBe(REGISTRY_WAIT_LIMIT_MS);
  });

  it('backs off across registry propagation errors without republishing', async () => {
    const registry = fakeRegistry({ visibleAt: 4000 });
    await expect(
      publishWithIntegrity(request, registry.run, registry.options)
    ).resolves.toMatchObject({ integrity: request.integrity });
    expect(registry.waits).toEqual([1000, 3000]);
    expect(registry.lines).toEqual([]);
    expect(publishes(registry.run)).toHaveLength(1);
  });

  it.each([5, 15])('accepts a version that npm shows after %i minutes', async (minutes) => {
    const registry = fakeRegistry({ visibleAt: minutes * MINUTE });
    await expect(publishWithIntegrity(request, registry.run, registry.options)).resolves.toEqual({
      alreadyPublished: false,
      integrity: request.integrity,
    });
    expect(registry.elapsed()).toBeLessThan((minutes + 1) * MINUTE);
    expect(Math.max(...registry.waits)).toBeLessThanOrEqual(MINUTE);
    expect(publishes(registry.run)).toHaveLength(1);
    expect(registry.lines).toHaveLength(minutes - 1);
    expect(registry.lines[0]).toBe(
      'Waiting for npm to show @example/toolkit@0.1.0: 1 of at most 20 minutes.'
    );
  });

  it('fails within a bounded time when the version never appears', async () => {
    const viewTime = 15_000;
    const registry = fakeRegistry({ viewTime });
    await expect(publishWithIntegrity(request, registry.run, registry.options)).rejects.toThrow(
      'Cannot verify the registry tarball integrity.'
    );
    expect(REGISTRY_WAIT_LIMIT_MS).toBe(20 * MINUTE);
    expect(registry.elapsed()).toBeGreaterThanOrEqual(REGISTRY_WAIT_LIMIT_MS);
    expect(registry.elapsed()).toBeLessThanOrEqual(REGISTRY_WAIT_LIMIT_MS + viewTime);
    expect(publishes(registry.run)).toHaveLength(1);
    expect(registry.lines.length).toBeGreaterThanOrEqual(18);
    expect(registry.lines.length).toBeLessThanOrEqual(20);
    expect(registry.lines.join('\n')).not.toMatch(/https?:|secret|token/i);
  });

  it('fails a mismatch at once, on the first answer or after a wait', async () => {
    const first = fakeRegistry({ pending: ok(JSON.stringify('sha512-different')) });
    await expect(publishWithIntegrity(request, first.run, first.options)).rejects.toThrow(
      'does not match'
    );
    expect(first.waits).toEqual([]);

    const late = fakeRegistry({ visibleAt: 5 * MINUTE });
    await expect(
      publishWithIntegrity({ ...request, integrity: 'sha512-other' }, late.run, late.options)
    ).rejects.toThrow('does not match');
    expect(late.elapsed()).toBeLessThan(6 * MINUTE);
  });

  it('leaves the publish job room for the publish call, the wait and its setup', () => {
    const workflow = parse(
      readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
    );
    expect(workflow.jobs.publish['timeout-minutes']).toBeGreaterThanOrEqual(
      REGISTRY_WAIT_LIMIT_MS / MINUTE + 20
    );
  });

  it('does not reinterpret unrelated publish failures as success', async () => {
    const run = vi.fn().mockReturnValue({ status: 1, stderr: 'Access denied' });
    await expect(publishWithIntegrity(request, run)).rejects.toThrow('npm publish failed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('authenticates private integrity reads without giving the read token to npm publish', async () => {
    let config;
    const run = vi.fn((_command, args, options) => {
      if (args[0] === 'publish') {
        expect(options.env.NPM_READ_TOKEN).toBeUndefined();
        return ok();
      }
      config = options.env.NPM_CONFIG_USERCONFIG;
      expect(options.env.NPM_READ_TOKEN).toBe('test-read-only-token');
      expect(readFileSync(config, 'utf8')).toContain('${NPM_READ_TOKEN}');
      return ok(JSON.stringify(request.integrity));
    });
    await publishWithIntegrity({ ...request, visibility: 'private', access: 'restricted' }, run);
    expect(existsSync(config)).toBe(false);
  });

  it('requires a reviewed digest before invoking the publishing client', async () => {
    const run = vi.fn();
    await expect(publishWithIntegrity({ ...request, integrity: undefined }, run)).rejects.toThrow(
      'required'
    );
    expect(run).not.toHaveBeenCalled();
  });
});
