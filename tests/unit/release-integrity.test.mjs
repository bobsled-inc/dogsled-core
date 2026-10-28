import { readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishWithIntegrity } from '../../scripts/release/registry-integrity.mjs';

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

  it('fails missing or malformed registry integrity', async () => {
    const run = vi.fn().mockReturnValueOnce(ok()).mockReturnValueOnce(ok('not-json'));
    await expect(publishWithIntegrity(request, run, { delays: [] })).rejects.toThrow('Malformed');
  });

  it('backs off across registry propagation errors without republishing', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce({ status: 1, stderr: 'not found' })
      .mockReturnValueOnce(ok('null'))
      .mockReturnValueOnce(ok(JSON.stringify(request.integrity)));
    const wait = vi.fn(async () => {});
    await expect(
      publishWithIntegrity(request, run, { wait, delays: [1000, 3000] })
    ).resolves.toMatchObject({ integrity: request.integrity });
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1000, 3000]);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'publish')).toHaveLength(1);
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
