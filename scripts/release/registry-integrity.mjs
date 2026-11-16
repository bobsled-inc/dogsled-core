import { setTimeout as waitForMetadata } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { withRegistryReadAuth } from './registry-read-auth.mjs';
import { publicationPolicy } from './publication-policy.mjs';
import { redactText } from '../security/lib.mjs';

const NPM_SECRET_PATTERNS = [
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /((?:_authToken|_auth|_password|NODE_AUTH_TOKEN|NPM_[A-Z_]*TOKEN)\s*[=:]\s*)\S+/gi,
  /(authorization:\s*)\S+(?:\s+\S+)?/gi,
];
// Lines that may echo npm configuration or auth headers are dropped, not redacted.
const CONFIG_LINE = /npmrc|userconfig|_auth|authorization|always-auth/i;
const LOG_POINTER = /complete log of this run|[\\/]_logs[\\/]/i;

function sanitizeNpmText(text) {
  let clean = redactText(text);
  for (const pattern of NPM_SECRET_PATTERNS)
    clean = clean.replace(pattern, (_match, prefix) =>
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
    );
  return clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
}

/**
 * npm's own reason for a failed command, reduced to its error code and message
 * lines. Never the raw output: config and auth lines are dropped and
 * token-shaped text is redacted.
 */
export function npmFailureSummary(result) {
  if (result?.error)
    return `${result.error.code ?? 'spawn error'}: ${sanitizeNpmText(result.error.message ?? '')}`;
  const lines = String(result?.stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLines = lines
    .map((line) => /^npm (?:error|ERR!)(?:\s+(.*))?$/.exec(line)?.[1]?.trim())
    .filter((line) => line !== undefined);
  let code;
  const message = [];
  for (const line of errorLines.length > 0 ? errorLines : lines.slice(-5)) {
    const codeMatch = /^code\s+(\S+)$/.exec(line);
    if (codeMatch) {
      code ??= codeMatch[1];
      continue;
    }
    if (/^\d{3}$/.test(line) || LOG_POINTER.test(line) || CONFIG_LINE.test(line)) continue;
    if (message.length < 8) message.push(sanitizeNpmText(line.replace(/\s+/g, ' ')));
  }
  if (code === undefined && message.length === 0) {
    // With --json, npm can report the error only as JSON on standard output.
    try {
      const { error } = JSON.parse(result?.stdout ?? '');
      if (typeof error?.code === 'string') code = sanitizeNpmText(error.code);
      if (typeof error?.summary === 'string' && !CONFIG_LINE.test(error.summary))
        message.push(sanitizeNpmText(error.summary));
    } catch {
      // Not JSON: nothing more to report.
    }
  }
  const status = result?.signal ? `signal ${result.signal}` : `exit status ${result?.status}`;
  if (message.length === 0) return `${code ?? status}: npm printed no error message`;
  return `${code ?? status}: ${message.join(' | ')}`;
}

export async function publishWithIntegrity(
  request,
  run = spawnSync,
  {
    wait = waitForMetadata,
    delays = [1000, 3000, 7000, 15000, 30000, 60000],
    policy = publicationPolicy,
    log = (line) => process.stderr.write(`${line}\n`),
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
      throw new Error(
        `npm publish failed for ${packageName}@${version}: ${npmFailureSummary(result)}`
      );
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
      } else {
        metadataError = `Cannot verify the registry tarball integrity: npm view failed (${npmFailureSummary(metadata)}).`;
        log(
          `Registry read ${attempt + 1} of ${delays.length + 1} failed: ${npmFailureSummary(metadata)}`
        );
      }
      if (attempt < delays.length) await wait(delays[attempt]);
    }
    throw new Error(metadataError);
  });
}
