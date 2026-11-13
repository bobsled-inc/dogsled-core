#!/usr/bin/env node

/**
 * Catch the rename branch up with main.
 *
 *   node scripts/rename/sync-main.mjs [--main origin/main] [--mirror sync/main-renamed]
 *                                     [--mirror-sha <sha>] [--root <dir>]
 *
 * Run it on a fresh sync branch cut from rename/bobsled-core, with a clean
 * worktree. It first looks at how far the branch is renamed, by counting
 * what each rename category still matches here and in the last merged main:
 *
 * - unrenamed (no category applied yet; design PRs may have landed): a plain
 *   `git merge` of main. Nothing is renamed.
 * - fully renamed (every category that matches in main matches nothing here):
 *   merge a mirror of renamed main. The mirror is main renamed in a throwaway
 *   worktree, recorded with `git commit-tree` (parents: previous mirror, main),
 *   so the merge base is the previously synced renamed main and design-PR
 *   edits never conflict with the rename. The first fully renamed sync seeds
 *   the mirror from the last merged main, renamed, recorded with
 *   `git merge -s ours` (no file changes; true because the branch is fully
 *   renamed).
 * - partly renamed: refuse. The mechanical rename PRs land back to back, with
 *   no main sync between them.
 *
 * Push the mirror branch after the sync PR merges and put its SHA in the PR
 * body. If the branch is lost, pass the last mirror SHA with --mirror-sha.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { categoryCounts, parseCliArgs } from './rename.mjs';

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

function countsAt(root, commit) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'bobsled-sync-state-'));
  try {
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, commit]);
    return categoryCounts(worktree);
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

/**
 * 'unrenamed', 'renamed' or 'partial', judged against the last merged main:
 * a category counts as applied when it matches there but no longer here.
 */
export function renameState(root, base) {
  const before = countsAt(root, base);
  const now = categoryCounts(root);
  const relevant = Object.keys(before).filter((category) => before[category] > 0);
  const applied = relevant.filter((category) => now[category] === 0);
  const remaining = relevant.filter((category) => now[category] > 0);
  const state = applied.length === 0 ? 'unrenamed' : remaining.length === 0 ? 'renamed' : 'partial';
  return { state, applied, remaining };
}

function mergeCommit(root, commit, message) {
  const merge = spawnSync('git', ['merge', '--no-ff', '-m', message, commit], {
    cwd: root,
    encoding: 'utf8',
  });
  return merge.status === 0;
}

export function syncMain({ root, main = 'origin/main', mirror = 'sync/main-renamed', mirrorSha }) {
  if (git(root, ['status', '--porcelain'])) throw new Error('The worktree must be clean.');
  const mainSha = git(root, ['rev-parse', '--verify', `${main}^{commit}`]);
  const short = mainSha.slice(0, 12);
  const base = git(root, ['merge-base', 'HEAD', mainSha]);
  if (base === mainSha) return { mode: 'none', merged: false, main: mainSha };
  const { state, applied, remaining } = renameState(root, base);
  if (state === 'partial')
    throw new Error(
      'The branch is partly renamed (applied: ' +
        `${applied.join(', ')}; still to apply: ${remaining.join(', ')}). ` +
        'Finish the mechanical rename PRs first; they land back to back, with no main sync between them.'
    );
  let previous =
    mirrorSha ??
    tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${mirror}`]) ??
    tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${mirror}`]);
  if (state === 'unrenamed') {
    if (previous) throw new Error(`A mirror exists (${previous}) but the branch is not renamed.`);
    const merged = mergeCommit(root, mainSha, `Sync main ${short}`);
    return { mode: 'plain', merged, conflicts: !merged, main: mainSha };
  }
  let seeded = null;
  if (!previous) {
    // First sync after the full rename: the branch holds the last merged main, renamed.
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
    return { mode: 'mirror', mirror: previous, seeded, merged: false, main: mainSha };
  const next = commitTree(
    root,
    renamedTree(root, mainSha),
    [previous, mainSha],
    `Renamed main ${short}`
  );
  git(root, ['update-ref', `refs/heads/${mirror}`, next]);
  const merged = mergeCommit(root, next, `Sync main ${short} (mirror ${next.slice(0, 12)})`);
  return { mode: 'mirror', mirror: next, seeded, merged, conflicts: !merged, main: mainSha };
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
  if (!result.merged && !result.conflicts) {
    process.stdout.write(`Main ${result.main} is already synced.\n`);
    return;
  }
  if (result.seeded) process.stdout.write(`Seeded the mirror at ${result.seeded}.\n`);
  if (result.mode === 'mirror') process.stdout.write(`Mirror of renamed main: ${result.mirror}\n`);
  else process.stdout.write('The branch is not renamed yet: plain merge of main.\n');
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
    result.mode === 'mirror'
      ? 'Merged. Next: node scripts/rename/rename.mjs --check, pnpm install, regenerate, guard, tests.\n'
      : 'Merged. Next: pnpm install, guard, tests.\n'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
