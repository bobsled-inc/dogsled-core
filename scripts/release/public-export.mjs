import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PUBLIC_ROOT_IDENTITY = Object.freeze({
  name: 'Ioannis',
  email: 'ioannis@bobsled.co',
});

export const UNIT_LEGS = Object.freeze(['model', 'graph', 'bobsled', 'rest']);

// The staging-only old-name guard. Its package script is found by its command
// (the script name follows the rename), then removed with its CI step.
const STAGING_GUARD_COMMAND = 'node ./scripts/guards/old-names.mjs';
// The private staging branch; nothing in the public tree may name it.
const RENAME_BRANCH = 'rename/bobsled-core';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const policyPath = 'scripts/release/public-export-exclude.txt';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, args, options = {}) =>
  execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options });

function assertRelative(value, directory = false) {
  const normalized = directory ? value.replace(/\/$/, '') : value;
  if (
    typeof normalized !== 'string' ||
    !normalized ||
    path.isAbsolute(normalized) ||
    /[\x00-\x1f\x7f\\]/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  )
    throw new Error('Export paths must be exact, safe repository-relative paths.');
}

export function parseExclusions(text) {
  const seen = new Set();
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim() || line.trim().startsWith('#')) return [];
    const match = line.match(/^([^#]+?)\s+#\s+(\S.*)$/);
    if (!match) throw new Error('Every excluded path needs an inline reason.');
    const excluded = match[1].trim();
    assertRelative(excluded, true);
    if (/[\*?\[\]{}]/.test(excluded)) throw new Error('Export exclusions must not use wildcards.');
    if (seen.has(excluded)) throw new Error('Duplicate export exclusion.');
    seen.add(excluded);
    return [{ path: excluded, reason: match[2].trim() }];
  });
}

function isExcluded(relative, exclusions) {
  return exclusions.some((entry) =>
    entry.path.endsWith('/')
      ? relative.startsWith(entry.path) || relative === entry.path.slice(0, -1)
      : relative === entry.path
  );
}

function entryBytes(root, entry) {
  const file = path.join(root, entry.path);
  return entry.type === 'symlink' ? Buffer.from(readlinkSync(file)) : readFileSync(file);
}

export function assertExport(root, entries, exclusions) {
  for (const entry of exclusions) {
    const file = path.join(root, entry.path.replace(/\/$/, ''));
    try {
      lstatSync(file);
      throw new Error(`Excluded path remains: ${entry.path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const names = new Map();
  for (const entry of entries) {
    const name = path.posix.basename(entry.path);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const needles = [
    ...new Set(
      exclusions.flatMap((entry) => {
        const value = entry.path.replace(/\/$/, '');
        const name = path.posix.basename(value);
        return [
          value,
          ...(!entry.path.endsWith('/') && (names.get(name) ?? 0) === 0 ? [name] : []),
        ];
      })
    ),
  ];
  for (const entry of entries) {
    if (entry.path === policyPath) continue;
    const bytes = entryBytes(root, entry);
    if (bytes.includes(Buffer.from(RENAME_BRANCH)))
      throw new Error(`Retained file names the private rename branch: ${entry.path}`);
    for (const needle of needles) {
      if (bytes.includes(Buffer.from(needle))) {
        throw new Error(`Retained file references an excluded path: ${entry.path} -> ${needle}`);
      }
    }
    if (entry.type === 'symlink') {
      const target = realpathSync(path.join(root, entry.path));
      const relative = path.relative(realpathSync(root), target);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Export symlink escapes its root.');
    }
  }
  for (const name of ['old-names-exceptions.json', 'privacy-exceptions.json']) {
    const file = path.join(root, 'scripts/guards', name);
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const entry of data.exceptions) {
      for (const relative of entry.path ? [entry.path] : entry.files) {
        assertRelative(relative);
        if (!existsSync(path.join(root, relative)))
          throw new Error(`Guard exception points at a missing file: ${relative}`);
      }
    }
  }
}

export function exportCommit({ root, commit, output }) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? ''))
    throw new Error('Pass an exact 40-character commit SHA.');
  const type = git(root, ['cat-file', '-t', commit], { encoding: 'utf8' }).trim();
  if (type !== 'commit') throw new Error('The exact SHA must identify a commit object.');
  const destination = path.resolve(output);
  if (existsSync(destination)) throw new Error('Export destination must not exist.');
  const tree = git(root, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
  const exclusions = parseExclusions(
    git(root, ['show', `${commit}:${policyPath}`], { encoding: 'utf8' })
  );
  const sourceEntries = git(root, ['ls-tree', '-rz', '--full-tree', commit], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/);
      if (!match) throw new Error('Export supports only regular files and contained symlinks.');
      const [, mode, object, relative] = match;
      assertRelative(relative);
      if (relative === 'EXPORT-MANIFEST.json')
        throw new Error('Source commit must not contain an export manifest.');
      const type = mode === '120000' ? 'symlink' : 'file';
      if (type === 'symlink') {
        const target = git(root, ['cat-file', 'blob', object], { encoding: 'utf8' });
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(relative), target)
        );
        if (
          path.isAbsolute(target) ||
          resolved === '..' ||
          resolved.startsWith('../') ||
          target.includes('\\')
        ) {
          throw new Error(`Source symlink escapes its root: ${relative}`);
        }
      }
      return { path: relative, mode, type, object };
    });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'public-export-archive-'));
  mkdirSync(destination, { recursive: true });
  try {
    const archive = path.join(scratch, 'source.tar');
    git(root, ['archive', '--format=tar', '--output', archive, commit]);
    execFileSync('tar', ['-xf', archive, '-C', destination]);
    for (const entry of sourceEntries) {
      const bytes = entryBytes(destination, entry);
      const object = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (object !== entry.object)
        throw new Error(`Archive bytes differ from source commit: ${entry.path}`);
      const stat = lstatSync(path.join(destination, entry.path));
      if ((entry.type === 'symlink') !== stat.isSymbolicLink())
        throw new Error('Archive type drift.');
      if (entry.type === 'file' && ((stat.mode & 0o111) !== 0) !== (entry.mode === '100755')) {
        throw new Error('Archive executable mode drift.');
      }
    }
    for (const entry of exclusions)
      rmSync(path.join(destination, entry.path), { recursive: true, force: true });
    const transformations = preparePublicScripts(destination);
    const entries = sourceEntries
      .filter((entry) => !isExcluded(entry.path, exclusions))
      .map(({ object, ...entry }) => ({
        ...entry,
        sha256: sha256(entryBytes(destination, entry)),
      }));
    assertExport(destination, entries, exclusions);
    const manifest = { schemaVersion: 1, commit, tree, transformations, files: entries };
    writeFileSync(
      path.join(destination, 'EXPORT-MANIFEST.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return { manifest, exclusions };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function preparePublicScripts(root) {
  const transformations = [];
  let guard;
  const packageFile = path.join(root, 'package.json');
  if (existsSync(packageFile)) {
    const source = readFileSync(packageFile);
    const data = JSON.parse(source);
    const guards = Object.keys(data.scripts ?? {}).filter((name) =>
      data.scripts[name].includes(STAGING_GUARD_COMMAND)
    );
    if (guards.length) {
      if (guards.length !== 1 || data.scripts[guards[0]] !== STAGING_GUARD_COMMAND)
        throw new Error('Unrecognized staging guard invocation in package.json.');
      [guard] = guards;
      delete data.scripts[guard];
      for (const [name, script] of Object.entries(data.scripts))
        if (script.includes(guard))
          throw new Error(`Unrecognized staging guard invocation in the ${name} script.`);
      writeFileSync(packageFile, `${JSON.stringify(data, null, 2)}\n`);
      transformations.push({
        path: 'package.json',
        sourceSha256: sha256(source),
        reason: 'Remove the staging-only old-name guard script.',
      });
    }
  }
  const ciFile = path.join(root, '.github/workflows/ci.yml');
  if (!existsSync(ciFile)) return transformations;
  const ciSource = readFileSync(ciFile);
  let text = ciSource.toString('utf8');
  const reasons = [];
  if (guard) {
    const step = new RegExp(`^ {6}- name: [^\\n]+\\n {8}run: pnpm ${escapeRegExp(guard)}\\n`, 'gm');
    const steps = text.match(step) ?? [];
    text = text.replace(step, '');
    if (steps.length > 1 || text.includes(guard))
      throw new Error('Unrecognized staging guard step in .github/workflows/ci.yml.');
    if (steps.length === 1) reasons.push('Remove the staging-only old-name guard step.');
  }
  const mainOnly = text.replaceAll(`, ${RENAME_BRANCH}]`, ']');
  if (mainOnly !== text) reasons.push('Run CI on main only.');
  text = mainOnly;
  if (text.includes(RENAME_BRANCH))
    throw new Error('Unrecognized rename branch reference in .github/workflows/ci.yml.');
  if (reasons.length) {
    writeFileSync(ciFile, text);
    transformations.push({
      path: '.github/workflows/ci.yml',
      sourceSha256: sha256(ciSource),
      reason: reasons.join(' '),
    });
  }
  return transformations;
}

export function createPublicRootCommit(root, manifest, exclusions) {
  if (existsSync(path.join(root, '.git')))
    throw new Error('Public root commit requires a Git-free export.');
  assertExport(root, manifest.files, exclusions);
  assertManifest(root, manifest);
  const pendingFiles = manifest.files
    .filter((entry) => {
      const bytes = entryBytes(root, entry);
      return /counsel:\s*review|proposed wording for counsel review/i.test(bytes.toString('utf8'));
    })
    .map((entry) => entry.path);
  if (pendingFiles.length) {
    throw new Error(`Publication blocked by counsel-review markers: ${pendingFiles.join(', ')}`);
  }
  rmSync(path.join(root, 'EXPORT-MANIFEST.json'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input: manifest.files.map((entry) => entry.path).join('\0') + '\0',
  });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: PUBLIC_ROOT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: PUBLIC_ROOT_IDENTITY.email,
    GIT_COMMITTER_NAME: PUBLIC_ROOT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: PUBLIC_ROOT_IDENTITY.email,
  };
  git(
    root,
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
      '-m',
      'Initial commit',
    ],
    { env }
  );
  const identity = git(root, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s%n%P', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const expected = [
    PUBLIC_ROOT_IDENTITY.name,
    PUBLIC_ROOT_IDENTITY.email,
    PUBLIC_ROOT_IDENTITY.name,
    PUBLIC_ROOT_IDENTITY.email,
    'Initial commit',
  ].join('\n');
  if (identity !== expected)
    throw new Error('Public root commit identity, message or parent assertion failed.');
  if (git(root, ['ls-files', '--', 'EXPORT-MANIFEST.json'], { encoding: 'utf8' }).trim())
    throw new Error('Public root commit must not contain the export manifest.');
  return git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function assertManifest(root, manifest) {
  const expected = `${JSON.stringify(manifest, null, 2)}\n`;
  if (readFileSync(path.join(root, 'EXPORT-MANIFEST.json'), 'utf8') !== expected) {
    throw new Error('Verification changed the export manifest.');
  }
  for (const entry of manifest.files) {
    const stat = lstatSync(path.join(root, entry.path));
    if (
      (entry.type === 'symlink' ? !stat.isSymbolicLink() : !stat.isFile()) ||
      (entry.type === 'file' && ((stat.mode & 0o111) !== 0) !== (entry.mode === '100755'))
    )
      throw new Error(`Verification changed source mode or type: ${entry.path}`);
    if (sha256(entryBytes(root, entry)) !== entry.sha256) {
      throw new Error(`Verification changed source bytes: ${entry.path}`);
    }
  }
}

export function verifyExport(root, manifest, exclusions, unitLeg) {
  if (unitLeg !== undefined && !UNIT_LEGS.includes(unitLeg))
    throw new Error('Unknown unit-test leg.');
  git(root, ['init', '--quiet']);
  git(root, ['add', '--all']);
  const commands = [
    ['install', '--frozen-lockfile'],
    ['run', 'setup:sqlite'],
    ['build'],
    [unitLeg ? `test:unit:ci:${unitLeg}` : 'test:unit'],
    ['security:fast'],
  ];
  for (const args of commands) {
    process.stdout.write(`Export verification: pnpm ${args.join(' ')}\n`);
    const result = spawnSync('pnpm', args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      timeout: 20 * 60 * 1000,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Export verification failed: pnpm ${args.join(' ')}`);
  }
  assertExport(root, manifest.files, exclusions);
  assertManifest(root, manifest);
}

export function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--verify') options.verify = true;
    else if (arg === '--create-root-commit') options.createRootCommit = true;
    else if (arg === '--commit' || arg === '--out' || arg === '--unit-leg') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      if (options[arg.slice(2)]) throw new Error(`Duplicate argument: ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options['unit-leg'] && (!options.verify || !UNIT_LEGS.includes(options['unit-leg'])))
    throw new Error('--unit-leg requires --verify and a known unit-test leg.');
  if (!options.out) throw new Error('Pass --out <new directory>.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { manifest, exclusions } = exportCommit({
    root,
    commit: options.commit,
    output: options.out,
  });
  if (options.verify) {
    verifyExport(path.resolve(options.out), manifest, exclusions, options['unit-leg']);
    if (options.createRootCommit)
      rmSync(path.join(path.resolve(options.out), '.git'), { recursive: true });
  }
  const publicCommit = options.createRootCommit
    ? createPublicRootCommit(path.resolve(options.out), manifest, exclusions)
    : undefined;
  process.stdout.write(
    `${JSON.stringify({ commit: manifest.commit, fileCount: manifest.files.length, verified: options.verify === true, publicCommit })}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
