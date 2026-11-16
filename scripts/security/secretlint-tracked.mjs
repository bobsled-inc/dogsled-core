import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sourceFiles } from '../ci/source-files.mjs';
import { executablePath, parseArgs, repoRoot } from './lib.mjs';

const args = parseArgs();
const scanRoot = args.root ? path.resolve(args.root) : repoRoot;
const jsonOutput = args.json === true;
const secretlint = executablePath('secretlint');
if (!secretlint) {
  process.stderr.write('secretlint is unavailable; run pnpm install.\n');
  process.exit(2);
}

const textExtensions = new Set([
  '.bash',
  '.cjs',
  '.csv',
  '.env',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.mts',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);
const textNames = new Set(['.npmrc', 'Dockerfile', 'LICENSE', 'NOTICE', 'Makefile']);

function isTextCandidate(relative) {
  const base = path.basename(relative);
  return textNames.has(base) || textExtensions.has(path.extname(base).toLowerCase());
}

const exportManifest = path.join(scanRoot, 'EXPORT-MANIFEST.json');
if (scanRoot !== repoRoot && !existsSync(exportManifest)) {
  throw new Error('An export scan root must contain EXPORT-MANIFEST.json.');
}
const relativeFiles = sourceFiles(scanRoot, { includeUntracked: scanRoot === repoRoot });

const files = relativeFiles
  .filter(isTextCandidate)
  .filter((relative) => relative !== 'pnpm-lock.yaml')
  .map((relative) => path.join(scanRoot, relative));
const reports = [];
const chunkSize = 200;
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bobsled-secretlint-'));
try {
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const outputFile = path.join(tempDir, `chunk-${index / chunkSize}.json`);
    const result = spawnSync(
      secretlint,
      [
        '--format=json',
        `--output=${outputFile}`,
        '--no-color',
        '--no-terminalLink',
        '--no-gitignore',
        '--no-glob',
        `--secretlintrc=${path.join(repoRoot, '.secretlintrc.json')}`,
        ...chunk,
      ],
      {
        cwd: scanRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 2 * 60 * 1000,
      }
    );
    if (result.error || result.status !== 0 || !existsSync(outputFile)) {
      process.stderr.write(result.stderr || result.error?.message || 'secretlint failed\n');
      process.exit(2);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(outputFile, 'utf8'));
    } catch (error) {
      process.stderr.write(
        `secretlint returned invalid JSON for file chunk ${index / chunkSize + 1}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
      process.exit(2);
    }
    if (!Array.isArray(parsed)) throw new Error('secretlint JSON output must be an array.');
    reports.push(
      ...parsed.map((report) => ({
        filePath: report.filePath,
        messages: report.messages ?? [],
      }))
    );
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
} else {
  const messages = reports.flatMap((report) =>
    (report.messages ?? []).map((message) => ({
      path: path.relative(scanRoot, report.filePath),
      line: message.loc?.start?.line ?? message.line ?? 1,
      rule: message.ruleId,
      message: message.message,
    }))
  );
  for (const message of messages) {
    process.stderr.write(`${message.path}:${message.line} ${message.rule}: ${message.message}\n`);
  }
  process.stdout.write(
    `Secret scan checked ${files.length} tracked text files; ${messages.length} finding(s).\n`
  );
}

if (reports.some((report) => (report.messages ?? []).length > 0)) process.exitCode = 1;
