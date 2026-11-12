import { setTimeout as waitForMetadata } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { withRegistryReadAuth } from './registry-read-auth.mjs';
import { publicationPolicy } from './publication-policy.mjs';

export async function publishWithIntegrity(
  request,
  run = spawnSync,
  {
    wait = waitForMetadata,
    delays = [1000, 3000, 7000, 15000, 30000, 60000],
    policy = publicationPolicy,
  } = {}
) {
  const { tarball, packageName, version, access, integrity } = request;
  const { provenance, distTag } = policy(request);
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-'))
    throw new Error('Reviewed SHA-512 integrity is required.');
  return withRegistryReadAuth(request, async (readEnv) => {
    const { NPM_READ_TOKEN: _readToken, ...publishEnv } = process.env;
    const result = run(
      'npm',
      [
        'publish',
        tarball,
        '--access',
        access,
        provenance ? '--provenance' : '--provenance=false',
        '--tag',
        distTag,
        '--ignore-scripts',
        '--registry',
        'https://registry.npmjs.org/',
      ],
      { encoding: 'utf8', timeout: 5 * 60 * 1000, env: publishEnv }
    );
    const alreadyPublished =
      /cannot publish over (?:the )?previously published versions|previously published version|EPUBLISHCONFLICT/i.test(
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      );
    if (result.error || (result.status !== 0 && !alreadyPublished))
      throw new Error(`npm publish failed for ${packageName}@${version}.`);
    let metadataError = 'Cannot verify the registry tarball integrity.';
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const metadata = run(
        'npm',
        [
          'view',
          `${packageName}@${version}`,
          'dist.integrity',
          '--json',
          '--registry',
          'https://registry.npmjs.org/',
        ],
        { encoding: 'utf8', timeout: 15_000, env: readEnv }
      );
      if (!metadata.error && metadata.status === 0) {
        let publishedIntegrity;
        try {
          publishedIntegrity = JSON.parse(metadata.stdout);
        } catch {
          metadataError = 'Malformed registry integrity response.';
        }
        if (typeof publishedIntegrity === 'string' && publishedIntegrity.length > 0) {
          if (publishedIntegrity !== integrity)
            throw new Error('Registry tarball integrity does not match the reviewed tarball.');
          return { alreadyPublished, integrity };
        }
      }
      if (attempt < delays.length) await wait(delays[attempt]);
    }
    throw new Error(metadataError);
  });
}
