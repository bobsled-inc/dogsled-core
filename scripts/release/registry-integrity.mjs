import { setTimeout as waitForMetadata } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { withRegistryReadAuth } from './registry-read-auth.mjs';
import { publicationPolicy } from './publication-policy.mjs';

// npm reviews a new public version before it is readable, which can take many minutes.
export const REGISTRY_WAIT_LIMIT_MS = 20 * 60 * 1000;
const FIRST_DELAYS_MS = [1000, 3000, 7000, 15000];
const POLL_DELAY_MS = 30_000;
const PROGRESS_INTERVAL_MS = 60_000;

export async function publishWithIntegrity(
  request,
  run = spawnSync,
  {
    wait = waitForMetadata,
    now = () => performance.now(),
    log = (line) => process.stdout.write(`${line}\n`),
  } = {}
) {
  const { tarball, packageName, version, access, integrity } = request;
  const { provenance, distTag } = publicationPolicy(request);
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
    const startedAt = now();
    let nextProgress = PROGRESS_INTERVAL_MS;
    for (let attempt = 0; ; attempt += 1) {
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
      const elapsed = now() - startedAt;
      if (elapsed >= REGISTRY_WAIT_LIMIT_MS) throw new Error(metadataError);
      if (elapsed >= nextProgress) {
        const minutes = Math.floor(elapsed / PROGRESS_INTERVAL_MS);
        log(
          `Waiting for npm to show ${packageName}@${version}: ${minutes} of at most ${REGISTRY_WAIT_LIMIT_MS / PROGRESS_INTERVAL_MS} minutes.`
        );
        nextProgress = (minutes + 1) * PROGRESS_INTERVAL_MS;
      }
      await wait(
        Math.min(FIRST_DELAYS_MS[attempt] ?? POLL_DELAY_MS, REGISTRY_WAIT_LIMIT_MS - elapsed)
      );
    }
  });
}
