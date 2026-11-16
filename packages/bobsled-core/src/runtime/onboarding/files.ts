import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandError } from '@bobsled-inc/protocol';

/** Only ordinary project files are accepted; never follow a source/output symlink. */
export async function containedPath(root: string, name: string): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== target || !rel) {
    throw new CommandError('Onboarding path must stay inside the project.', 2);
  }
  let current = base;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const st = await lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return undefined;
    });
    if (st?.isSymbolicLink() || (st?.isFile() && st.nlink > 1)) {
      throw new CommandError('Onboarding refuses symbolic links and hard links.', 2);
    }
    if (st && !st.isFile() && !st.isDirectory()) {
      throw new CommandError('Onboarding needs ordinary files.', 2);
    }
  }
  return target;
}
export async function readBounded(root: string, name: string): Promise<string> {
  const path = await containedPath(root, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
    throw new CommandError('Onboarding input must be a file below 5 MiB.', 2);
  }
  return readFile(path, 'utf8');
}
export async function writeLocal(root: string, name: string, content: string): Promise<string> {
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) {
    throw new CommandError('Onboarding output exceeds 5 MiB.', 2);
  }
  const target = await containedPath(root, name);
  await mkdir(dirname(target), { recursive: true });
  await containedPath(root, name);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await containedPath(root, name);
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return target;
}
export async function inputFiles(root: string, dataDirectory = 'data'): Promise<string[]> {
  const found: string[] = [];
  async function walk(name: string, depth: number): Promise<void> {
    if (depth > 6 || found.length > 500) {
      throw new CommandError('Onboarding project is too large; use a small sample.', 2);
    }
    const path = await containedPath(root, name);
    const entries = await readdir(path, { withFileTypes: true }).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return [];
      }
    );
    for (const entry of entries) {
      const child = join(name, entry.name);
      if (entry.isSymbolicLink()) throw new CommandError('Onboarding refuses symbolic links.', 2);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (/\.(json|csv|yml|yaml|sql|md)$/.test(entry.name)) found.push(child);
    }
  }
  for (const dir of [
    dataDirectory,
    'models',
    'sources',
    'integrations',
    'resources',
    'metrics',
    'relationships',
    'queries',
    'entity-graph',
  ]) {
    await walk(dir, 0);
  }
  for (const name of [
    'bobsled.yml',
    'bobsled.yaml',
    '.bobsled/config.yml',
    'executor.mjs',
    'runner.mjs',
  ]) {
    const path = await containedPath(root, name);
    const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return undefined;
    });
    if (stat) found.push(name);
  }
  if (found.length > 500) {
    throw new CommandError('Onboarding project is too large; use a small sample.', 2);
  }
  return found.sort();
}

export async function databaseFingerprint(
  root: string,
  databasePath = '.bobsled/bobsled.duckdb'
): Promise<string> {
  const path = await containedPath(root, databasePath);
  const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
    return undefined;
  });
  return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'missing';
}
