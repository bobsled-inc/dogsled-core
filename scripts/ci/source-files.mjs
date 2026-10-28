import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function sourceFiles(root, { includeUntracked = false } = {}) {
  const manifestPath = path.join(root, 'EXPORT-MANIFEST.json');
  if (!existsSync(path.join(root, '.git')) && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.files)) throw new Error('Invalid source manifest.');
    return manifest.files.map((entry) => {
      const relative = entry.path;
      if (
        typeof relative !== 'string' ||
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes('\\') ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Invalid source manifest path.');
      return relative;
    });
  }
  return execFileSync(
    'git',
    ['ls-files', '--cached', ...(includeUntracked ? ['--others', '--exclude-standard'] : []), '-z'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean);
}
