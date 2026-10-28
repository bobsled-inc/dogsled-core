import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(currentFile), '..', '..');
export const reviewRoot = path.join(repoRoot, '.security-review');
export const FINDING_SCHEMA_VERSION = 1;
export const RUN_SCHEMA_VERSION = 1;

export function parseArgs(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[rawKey] = next;
      index += 1;
    } else {
      result[rawKey] = true;
    }
  }
  return result;
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

const TOKEN_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{4,}/gi,
  /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:sk|pk|xox[baprs]?)[_-][A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi,
];

export function redactText(value) {
  let redacted = String(value);
  const homeDir = realpathSync(os.homedir());
  redacted = redacted.split(realpathSync(repoRoot)).join('<repo>');
  redacted = redacted.split(homeDir).join('<home>');
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix) =>
      prefix ? `${prefix}[REDACTED]` : '[REDACTED]'
    );
  }
  return redacted;
}

export function relativeToRepo(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  return relative.startsWith('../') ? '<outside-repo>' : relative;
}

export function normalizedLocation(location = {}) {
  const filePath = location.path ?? location.file ?? '';
  const normalizedPath = filePath
    ? filePath.startsWith('/')
      ? relativeToRepo(filePath)
      : filePath.replaceAll('\\', '/').replace(/^\.\//, '')
    : '';
  return {
    path: normalizedPath,
    line: Number.isInteger(location.line) ? location.line : undefined,
    column: Number.isInteger(location.column) ? location.column : undefined,
  };
}

export function normalizeSeverity(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (['critical', 'error', 'high', 'p0', 'p1'].includes(normalized)) return 'P1';
  if (['warning', 'warn', 'medium', 'moderate', 'p2'].includes(normalized)) return 'P2';
  return 'P3';
}

export function createFinding(input) {
  const location = normalizedLocation(input.location);
  const tool = input.tool || 'unknown';
  const rule = input.rule || 'unknown';
  const rootCause = input.rootCause || `${tool}:${rule}`;
  const fingerprint =
    input.fingerprint ||
    sha256(
      JSON.stringify({
        rootCause,
        path: location.path,
        line: location.line,
        message: redactText(input.message || ''),
      })
    ).slice(0, 24);

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    fingerprint,
    rootCause,
    tool,
    rule,
    severity: normalizeSeverity(input.severity),
    confidence: input.confidence ?? 'low',
    location,
    message: redactText(input.message || ''),
    evidence: redactText(input.evidence || ''),
    reachability: input.reachability ?? 'unreviewed',
    exploitPreconditions: input.exploitPreconditions ?? [],
    classification: input.classification ?? 'uncertain',
    disposition: input.disposition ?? 'deferred',
    recommendation: input.recommendation ?? '',
    riskReduction: input.riskReduction ?? '',
    effort: input.effort ?? 'unknown',
    verification: input.verification ?? [],
    remediationCommit: input.remediationCommit ?? '',
    codexRationale: input.codexRationale ?? '',
    humanDecision: input.humanDecision ?? '',
  };
}

export function executablePath(name) {
  const localName = process.platform === 'win32' ? `${name}.cmd` : name;
  const localPath = path.join(repoRoot, 'node_modules', '.bin', localName);
  if (existsSync(localPath)) return localPath;

  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (lookup.status === 0) return lookup.stdout.trim().split(/\r?\n/, 1)[0];
  return null;
}

function safeCommandText(command, args) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

export function captureCommand({
  id,
  tool,
  adapter,
  command,
  args = [],
  cwd = repoRoot,
  env = {},
  outputDir,
  findingExitCodes = [],
  versionArgs = ['--version'],
  versionOverride,
  timeoutMs = 15 * 60 * 1000,
}) {
  ensureDir(outputDir);
  const stdoutPath = path.join(outputDir, `${id}.stdout`);
  const stderrPath = path.join(outputDir, `${id}.stderr`);
  const resolvedCommand = command.includes(path.sep) ? command : executablePath(command);
  const startedAt = new Date().toISOString();

  if (!resolvedCommand) {
    writeFileSync(stdoutPath, '');
    writeFileSync(stderrPath, `${tool} executable is unavailable.\n`);
    return {
      id,
      tool,
      adapter,
      command: safeCommandText(command, args),
      version: 'unavailable',
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      status: 'unavailable',
      stdoutPath: path.relative(outputDir, stdoutPath),
      stderrPath: path.relative(outputDir, stderrPath),
      stdoutSha256: sha256File(stdoutPath),
      stderrSha256: sha256File(stderrPath),
    };
  }

  const versionResult = spawnSync(resolvedCommand, versionArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  const version = versionOverride
    ? redactText(versionOverride)
    : redactText(
        (versionResult.stdout || versionResult.stderr || 'unknown').trim().split(/\r?\n/, 1)[0]
      );
  const result = spawnSync(resolvedCommand, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  writeFileSync(stdoutPath, result.stdout ?? '');
  writeFileSync(stderrPath, result.stderr ?? result.error?.message ?? '');

  const exitCode = result.status;
  let status;
  if (result.error || exitCode === null) {
    status = 'failed';
  } else if (exitCode === 0) {
    status = 'passed';
  } else if (findingExitCodes.includes(exitCode)) {
    status = 'findings';
  } else {
    status = 'failed';
  }

  return {
    id,
    tool,
    adapter,
    command: redactText(safeCommandText(command, args)),
    version,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    signal: result.signal ?? null,
    status,
    stdoutPath: path.relative(outputDir, stdoutPath),
    stderrPath: path.relative(outputDir, stderrPath),
    stdoutSha256: sha256File(stdoutPath),
    stderrSha256: sha256File(stderrPath),
  };
}

export function resolveRunDir(args, { create = false } = {}) {
  const requested = args.run;
  if (requested) {
    const resolved = path.isAbsolute(requested) ? requested : path.join(repoRoot, requested);
    return create ? ensureDir(resolved) : resolved;
  }

  if (!create) {
    throw new Error('Pass --run <.security-review/run-id>.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ensureDir(path.join(reviewRoot, stamp));
}
