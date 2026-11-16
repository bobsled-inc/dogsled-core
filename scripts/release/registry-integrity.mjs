import { setTimeout as waitForMetadata } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { READ_AUTH_NPMRC, withRegistryReadAuth } from './registry-read-auth.mjs';
import { publicationPolicy } from './publication-policy.mjs';
import { redactText } from '../security/lib.mjs';

const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|AUTH|KEY|CREDENTIAL|COOKIE|SESSION/i;
const SECRET_KEY = String.raw`[\w.-]*(?:token|secret|passw|pwd|auth|cookie|session|credential|api[-_]?key|key)[\w.-]*`;
const SECRET_PATTERNS = [
  // Credentials in a URL: scheme://user:password@host
  [/\b([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@'],
  // key=value, key: value, "key":"value", key="value" (JSON or not)
  [new RegExp(`(${SECRET_KEY}["']?\\s*[:=]\\s*["']?)[^\\s"',;}]+`, 'gi'), '$1[REDACTED]'],
  // The word after a token/password-like word: "token S", "x-npm-token S", "_authToken\tS"
  [
    /(\b[\w.-]*(?:token|password|passwd|secret|cookie|credential)s?["']?\s+["']?)[^\s"',;}]+/gi,
    '$1[REDACTED]',
  ],
  // JWTs of any length, UUIDs, and long letter-and-digit runs (npm_, ghs_ and similar tokens)
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[REDACTED]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED]'],
  [/(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}/g, '[REDACTED]'],
];
// Lines that may echo npm configuration or auth headers are dropped, not redacted.
const CONFIG_LINE = /npmrc|userconfig|_auth|authorization|always-auth/i;
const LOG_POINTER = /complete log of this run|[\\/]_logs[\\/]/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values that must never print: secret-named environment values and the read-auth npmrc. */
function knownSecrets(env) {
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string')
    .map(([, value]) => value.trim())
    // One to three characters are flags such as "1", never credentials; replacing
    // them would garble status codes and versions.
    .filter((value) => value.length >= 4);
  return [...new Set([...values, READ_AUTH_NPMRC.trim()])].sort((a, b) => b.length - a.length);
}

function sanitizeNpmText(text, secrets) {
  let clean = String(text);
  for (const secret of secrets) {
    // Long values go wherever they appear; short ones only as a whole word.
    clean =
      secret.length >= 8
        ? clean.split(secret).join('[REDACTED]')
        : clean.replace(
            new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, 'g'),
            '[REDACTED]'
          );
  }
  clean = redactText(clean);
  for (const [pattern, replacement] of SECRET_PATTERNS) clean = clean.replace(pattern, replacement);
  return clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
}

function npmErrorCode(value, secrets) {
  const code = sanitizeNpmText(value, secrets);
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
}

/**
 * npm's own reason for a failed command: its error code and its `npm error` /
 * `npm ERR!` lines, nothing else. Known secret values are replaced first, then
 * config and auth lines are dropped and secret-shaped text is redacted.
 */
export function npmFailureSummary(result, env = process.env) {
  const secrets = knownSecrets(env);
  const status = result?.signal ? `signal ${result.signal}` : `exit status ${result?.status}`;
  if (result?.error) {
    const code = npmErrorCode(String(result.error.code ?? ''), secrets) ?? 'spawn error';
    return `${code}: ${sanitizeNpmText(result.error.message ?? '', secrets)}`;
  }
  let code;
  const message = [];
  for (const raw of String(result?.stderr ?? '').split(/\r?\n/)) {
    const line = /^\s*npm (?:error|ERR!)(?:\s+(.*))?$/.exec(raw)?.[1]?.trim();
    if (!line) continue;
    const codeMatch = /^code\s+(\S+)$/.exec(line);
    if (codeMatch) {
      code ??= npmErrorCode(codeMatch[1], secrets);
      continue;
    }
    if (/^\d{3}$/.test(line) || LOG_POINTER.test(line) || CONFIG_LINE.test(line)) continue;
    if (message.length < 8) message.push(sanitizeNpmText(line.replace(/\s+/g, ' '), secrets));
  }
  if (code === undefined && message.length === 0) {
    // With --json, npm can report the error only as JSON on standard output.
    try {
      const { error } = JSON.parse(result?.stdout ?? '');
      if (typeof error?.code === 'string') code = npmErrorCode(error.code, secrets);
      if (typeof error?.summary === 'string' && !CONFIG_LINE.test(error.summary))
        message.push(sanitizeNpmText(error.summary.replace(/\s+/g, ' '), secrets));
    } catch {
      // Not JSON: nothing more to report.
    }
  }
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
