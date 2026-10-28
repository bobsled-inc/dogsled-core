import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

import { parseArgs, repoRoot, sha256, sha256File, writeJson } from './lib.mjs';

const args = parseArgs();
if (!args.out) throw new Error('Pass --out <directory> for the clean export.');
const outputDir = path.resolve(repoRoot, args.out);
if (!outputDir.startsWith(`${path.resolve(repoRoot, '.security-review')}${path.sep}`)) {
  throw new Error('Security exports must stay under .security-review/.');
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: repoRoot, encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean)
  .filter((relative) => relative !== 'EXPORT-MANIFEST.json')
  .filter((relative) => !relative.startsWith('.security-review/'))
  .sort();

const manifest = [];
for (const relative of files) {
  const source = path.join(repoRoot, relative);
  if (!existsSync(source)) continue;
  const stat = lstatSync(source);
  const destination = path.join(outputDir, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(source);
    const resolvedTarget = path.resolve(path.dirname(source), linkTarget);
    const relativeTarget = path.relative(repoRoot, resolvedTarget);
    if (
      path.isAbsolute(linkTarget) ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(`Refusing to export out-of-repository symlink: ${relative}`);
    }
    symlinkSync(linkTarget, destination);
    manifest.push({
      path: relative,
      bytes: stat.size,
      sha256: sha256(linkTarget),
      linkTarget,
    });
    continue;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to export non-file entry: ${relative}`);
  }
  copyFileSync(source, destination);
  manifest.push({
    path: relative,
    bytes: stat.size,
    sha256: sha256File(destination),
  });
}

writeJson(path.join(outputDir, 'EXPORT-MANIFEST.json'), {
  schemaVersion: 1,
  source: 'tracked and untracked non-ignored worktree files',
  files: manifest,
});
process.stdout.write(
  `${JSON.stringify({
    output: path.relative(repoRoot, outputDir),
    fileCount: manifest.length,
    manifestSha256: sha256File(path.join(outputDir, 'EXPORT-MANIFEST.json')),
  })}\n`
);
