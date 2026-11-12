#!/usr/bin/env node

/**
 * Catch the rename branch up with main through a mirror of renamed main.
 *
 *   node scripts/rename/sync-main.mjs [--main origin/main] [--mirror sync/main-renamed]
 *                                     [--mirror-sha <sha>] [--root <dir>]
 *
 * Run it on a fresh sync branch cut from rename/bobsled-core, with a clean
 * worktree. It:
 *   1. renames `--main` in a temporary worktree with this repository's rename
 *      tool and takes the resulting tree;
 *   2. records it as a mirror commit whose parents are the previous mirror and
 *      main (`git commit-tree`), and points the `--mirror` branch at it;
 *   3. merges the mirror into the current branch.
 *
 * Because the previous mirror is an ancestor of both sides, the merge base is
 * the previously synced renamed main, so only main's real changes come in and
 * design-PR edits on the branch never conflict with the rename itself. The
 * first run has no mirror yet: it seeds one from the main commit the branch
 * last merged (renamed) and records it with `git merge -s ours`, which changes
 * no files.
 *
 * Push the mirror branch after the sync PR merges, and put the mirror SHA in
 * the PR body. If the branch is lost, pass the last mirror SHA with --mirror-sha.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArgs } from './rename.mjs';

const RENAME_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rename.mjs');

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function tryGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Tree of `commit` after the full rename, built in a throwaway worktree. */
export function renamedTree(root, commit) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'bobsled-sync-'));
  try {
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, commit]);
    const result = spawnSync(
      process.execPath,
      [RENAME_SCRIPT, '--apply', '--all', '--root', worktree],
      { encoding: 'utf8' }
    );
    if (result.status !== 0)
      throw new Error(`Renaming ${commit} failed:\n${result.stderr || result.stdout}`);
    git(worktree, ['add', '-A']);
    return git(worktree, ['write-tree']);
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

function commitTree(root, tree, parents, message) {
  return git(root, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message]);
}

export function syncMain({ root, main = 'origin/main', mirror = 'sync/main-renamed', mirrorSha }) {
  if (git(root, ['status', '--porcelain'])) throw new Error('The worktree must be clean.');
  const mainSha = git(root, ['rev-parse', '--verify', `${main}^{commit}`]);
  let previous =
    mirrorSha ??
    tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${mirror}`]) ??
    tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${mirror}`]);
  let seeded = null;
  if (!previous) {
    // First sync: the branch already holds main's last merged commit, renamed.
    const base = git(root, ['merge-base', 'HEAD', mainSha]);
    previous = commitTree(
      root,
      renamedTree(root, base),
      [base],
      `Renamed main mirror seed ${base.slice(0, 12)}`
    );
    git(root, ['merge', '--quiet', '-s', 'ours', '--no-edit', previous]);
    seeded = previous;
  }
  // `merge-base --is-ancestor` prints nothing: tryGit returns '' when true, null when false.
  if (tryGit(root, ['merge-base', '--is-ancestor', previous, 'HEAD']) === null)
    throw new Error(`Mirror ${previous} is not merged into this branch; pass --mirror-sha.`);
  if (tryGit(root, ['merge-base', '--is-ancestor', mainSha, previous]) !== null)
    return { mirror: previous, seeded, merged: false, main: mainSha };
  const next = commitTree(
    root,
    renamedTree(root, mainSha),
    [previous, mainSha],
    `Renamed main ${mainSha.slice(0, 12)}`
  );
  git(root, ['update-ref', `refs/heads/${mirror}`, next]);
  const merge = spawnSync(
    'git',
    [
      'merge',
      '--no-ff',
      '-m',
      `Sync main ${mainSha.slice(0, 12)} (mirror ${next.slice(0, 12)})`,
      next,
    ],
    { cwd: root, encoding: 'utf8' }
  );
  return {
    mirror: next,
    seeded,
    merged: merge.status === 0,
    conflicts: merge.status !== 0,
    main: mainSha,
  };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const root =
    args.root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const result = syncMain({
    root,
    main: args.main ?? 'origin/main',
    mirror: args.mirror ?? 'sync/main-renamed',
    mirrorSha: typeof args['mirror-sha'] === 'string' ? args['mirror-sha'] : undefined,
  });
  if (result.seeded) process.stdout.write(`Seeded the mirror at ${result.seeded}.\n`);
  if (!result.merged && !result.conflicts) {
    process.stdout.write(`Main ${result.main} is already synced (mirror ${result.mirror}).\n`);
    return;
  }
  process.stdout.write(`Mirror of renamed main: ${result.mirror}\n`);
  if (result.conflicts) {
    process.stderr.write(
      "The merge has conflicts. For each file, apply only main's own change:\n" +
        `  git diff <previous synced main> ${result.main} -- <path>\n` +
        "Never take main's whole side: it can undo design-PR edits.\n"
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'Merged. Next: node scripts/rename/rename.mjs --check, pnpm install, regenerate, guard, tests.\n'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
