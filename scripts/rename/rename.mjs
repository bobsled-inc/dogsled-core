#!/usr/bin/env node

/**
 * Dogsled Core -> Bobsled Core rename tool (rename/bobsled-core branch only).
 *
 * Usage:
 *   node scripts/rename/rename.mjs                         # dry run, all rules
 *   node scripts/rename/rename.mjs --rules BC-01,BC-03     # dry run, some rules
 *   node scripts/rename/rename.mjs --apply --rules BC-01   # rewrite and git mv
 *   node scripts/rename/rename.mjs --apply --all           # replay every rule (catch-up)
 *   node scripts/rename/rename.mjs --check --rules BC-08   # list remaining matches, exit 1 if any
 *   node scripts/rename/rename.mjs --patch in.patch --out out.patch
 *
 * Options: --root <dir> (default: git top level), --profile toolkit|app
 * (default: toolkit), --samples <n> (dry-run samples per rule, default 3),
 * --only <glob,...> (limit to some files, e.g. one file after a merge conflict).
 *
 * Never rewritten: keep-list names that contain "dogsled" (masked), lines that
 * contain `rename:keep`, the compatibility readers (COMPAT_PATHS), and the
 * tool and guard themselves (SELF_PATHS). With --rules, the rules that are not
 * selected still run in order but only mask their matches, so a subset run
 * gives the same text as the full run limited to the selected rules.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPAT_PATHS,
  KEEP_LINE_MARKER,
  NO_MOVE_PATHS,
  maskedKeepList,
  rulesForProfile,
  SELF_PATHS,
  selectRules,
  SPECIAL_ATTENTION,
} from './mapping.mjs';

const BINARY =
  /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|eot|otf|mp[34]|webm|zip|tar|gz|tgz|br|bz2|pdf|wasm|bin|exe|dll|so|dylib|node|pyc|parquet|duckdb)$/i;
const SKIP_FILES = new Set(['pnpm-lock.yaml']);

// ─── Globs ────────────────────────────────────────────────────────────────────

const globCache = new Map();

/** Minimal glob: `**` spans folders, `*` and `?` stay inside one segment. */
export function globToRegExp(glob) {
  let cached = globCache.get(glob);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  cached = new RegExp(`^${source}$`);
  globCache.set(glob, cached);
  return cached;
}

export const matchesAny = (file, globs) => globs.some((glob) => globToRegExp(glob).test(file));

export function ruleApplies(rule, file) {
  if (rule.exclude && matchesAny(file, rule.exclude)) return false;
  return !rule.include || matchesAny(file, rule.include);
}

export const isSelfPath = (file) => matchesAny(file, SELF_PATHS);
export const isCompatPath = (file) => matchesAny(file, COMPAT_PATHS);
/** Files whose contents the rename never rewrites (they still move, see NO_MOVE_PATHS). */
export const isProtectedPath = (file) => isSelfPath(file) || isCompatPath(file);
/** Files the rename never moves: its own files and old-format fixtures. */
export const isUnmovablePath = (file) => isSelfPath(file) || matchesAny(file, NO_MOVE_PATHS);

// ─── Masking ──────────────────────────────────────────────────────────────────
// Masked text becomes \uE000<n>\uE001 (private-use characters, never \w) and is
// restored after the rules ran.

function createMask() {
  const saved = [];
  return {
    hide: (value) => `\uE000${saved.push(value) - 1}\uE001`,
    restore(text) {
      let current = text;
      for (let pass = 0; pass < 4 && current.includes('\uE000'); pass++)
        current = current.replace(/\uE000(\d+)\uE001/g, (_, i) => saved[Number(i)]);
      return current;
    },
  };
}

function maskPattern(text, pattern, mask) {
  if (pattern instanceof RegExp)
    return text.replace(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
      (m) => mask.hide(m)
    );
  return text.split(pattern).join(mask.hide(pattern));
}

const patternLength = (p) => (p instanceof RegExp ? p.source.length : p.length);

/** Ordered rules for the profile, with a flag for the selected ones. */
function plan(selectedRules, profile) {
  const ids = new Set(selectedRules.map((rule) => rule.id));
  return rulesForProfile(profile).map((rule) => ({ rule, selected: ids.has(rule.id) }));
}

// ─── Content ──────────────────────────────────────────────────────────────────

function applyRule(text, rule, mask) {
  let count = 0;
  if (rule.match instanceof RegExp) {
    const next = text.replace(new RegExp(rule.match.source, rule.match.flags), (...args) => {
      count++;
      if (mask) return mask.hide(args[0]);
      const groups = args.slice(
        1,
        args.findIndex((arg) => typeof arg === 'number')
      );
      return rule.replace.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
    });
    return { text: next, count };
  }
  const parts = text.split(rule.match);
  return { text: parts.join(mask ? mask.hide(rule.match) : rule.replace), count: parts.length - 1 };
}

/**
 * Rename one file's text with the selected `rules`. Returns { text, counts }
 * with counts per selected rule id. `file` is the repo-relative path used for
 * include/exclude and keep paths.
 */
export function renameText(text, { file = '', rules, profile = 'toolkit' }) {
  const mask = createMask();
  let current = text.replace(new RegExp(`^.*${KEEP_LINE_MARKER}.*$`, 'gm'), (line) =>
    mask.hide(line)
  );
  const keep = maskedKeepList(profile)
    .filter((k) => !k.paths || matchesAny(file, k.paths))
    .sort((a, b) => patternLength(b.pattern) - patternLength(a.pattern));
  // Longest first, so `dogsled\.it` is masked before `dogsled.it`.
  for (const entry of keep) current = maskPattern(current, entry.pattern, mask);
  const counts = {};
  for (const { rule, selected } of plan(rules, profile)) {
    if (rule.kind !== 'content' || !ruleApplies(rule, file)) continue;
    const result = applyRule(current, rule, selected ? null : mask);
    if (result.count > 0) {
      if (selected) counts[rule.id] = (counts[rule.id] ?? 0) + result.count;
      current = result.text;
    }
  }
  return { text: mask.restore(current), counts };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** New path for a file under the selected rules, or null when nothing moves. */
export function transformPath(file, rules, profile = 'toolkit') {
  const mask = createMask();
  let current = file;
  for (const { rule, selected } of plan(rules, profile)) {
    if (rule.kind !== 'path') continue;
    if (rule.match instanceof RegExp) {
      current = current.replace(new RegExp(rule.match.source, rule.match.flags), (...args) => {
        if (!selected) return mask.hide(args[0]);
        const groups = args.slice(
          1,
          args.findIndex((arg) => typeof arg === 'number')
        );
        return rule.replace.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
      });
    } else if (current === rule.match || current.startsWith(`${rule.match}/`)) {
      current =
        (selected ? rule.replace : mask.hide(rule.match)) + current.slice(rule.match.length);
    }
  }
  current = mask.restore(current);
  return current === file ? null : current;
}

// ─── Patches ──────────────────────────────────────────────────────────────────

/** Translate a unified diff (git format-patch output) through the rules. */
export function translatePatch(patchText, rules, profile = 'toolkit') {
  let file = '';
  const movePath = (p) =>
    p === '/dev/null' || isUnmovablePath(p) ? p : (transformPath(p, rules, profile) ?? p);
  return patchText
    .split('\n')
    .map((line) => {
      const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (header) {
        file = header[2];
        return `diff --git a/${movePath(header[1])} b/${movePath(header[2])}`;
      }
      const side = line.match(/^(--- |\+\+\+ )(?:([ab])\/(.+)|\/dev\/null)$/);
      if (side) return side[2] ? `${side[1]}${side[2]}/${movePath(side[3])}` : line;
      const rename = line.match(/^(rename (?:from|to) )(.+)$/);
      if (rename) return `${rename[1]}${movePath(rename[2])}`;
      if (isProtectedPath(file)) return line;
      // Diff lines: rename after the ' ', '+' or '-' marker, so a removed line
      // that starts with an old name matches like it does in the file.
      if (/^[ +-]/.test(line))
        return line[0] + renameText(line.slice(1), { file, rules, profile }).text;
      return renameText(line, { file, rules, profile }).text;
    })
    .join('\n');
}

// ─── Repository modes ─────────────────────────────────────────────────────────

function listFiles(root, only) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file && !SKIP_FILES.has(file) && !isSelfPath(file))
    .filter((file) => !only || matchesAny(file, only))
    .filter((file) => {
      // Regular files only: symlinks and deleted files are left alone.
      const full = path.join(root, file);
      return existsSync(full) && lstatSync(full).isFile();
    });
}

/**
 * Whether the rename may move this file: not its own files, not old-format
 * fixtures, and not a file whose name is on the keep list (the Explorer logo).
 * Shared by the moves and the per-category state counts.
 */
export function isMovable(file, profile = 'toolkit') {
  if (isUnmovablePath(file)) return false;
  const base = path.basename(file);
  return !maskedKeepList(profile).some((entry) => entry.pattern === base);
}

function scan(root, rules, profile, only) {
  const files = [];
  const moves = [];
  const perRule = {};
  const samples = {};
  for (const file of listFiles(root, only)) {
    // Binary files and compatibility readers move with their folder, but their
    // contents are never rewritten.
    if (!BINARY.test(file) && !isCompatPath(file)) {
      const text = readFileSync(path.join(root, file), 'utf8');
      const result = renameText(text, { file, rules, profile });
      if (result.text !== text) files.push({ file, text: result.text });
      for (const [id, count] of Object.entries(result.counts)) {
        perRule[id] = (perRule[id] ?? 0) + count;
        (samples[id] ??= []).push(file);
      }
    }
    const to = transformPath(file, rules, profile);
    if (to && isMovable(file, profile)) moves.push({ from: file, to });
  }
  return { files, moves, perRule, samples };
}

/**
 * Remaining matches per category (content replacements plus path moves) in a
 * checkout, as `--check` would count them. Used to tell an unrenamed, a fully
 * renamed and a partly renamed branch apart.
 */
export function categoryCounts(root, profile = 'toolkit') {
  const rules = rulesForProfile(profile);
  const counts = Object.fromEntries(rules.map((rule) => [rule.category, 0]));
  const byId = new Map(rules.map((rule) => [rule.id, rule.category]));
  const pathCategories = [
    ...new Set(rules.filter((r) => r.kind === 'path').map((r) => r.category)),
  ];
  for (const file of listFiles(root)) {
    if (!BINARY.test(file) && !isCompatPath(file)) {
      const text = readFileSync(path.join(root, file), 'utf8');
      for (const [id, count] of Object.entries(renameText(text, { file, rules, profile }).counts))
        counts[byId.get(id)] += count;
    }
    if (!isMovable(file, profile)) continue;
    for (const category of pathCategories)
      if (transformPath(file, selectRules(category, profile), profile)) counts[category] += 1;
  }
  return counts;
}

function dryRun(root, rules, profile, maxSamples, only) {
  const { files, moves, perRule, samples } = scan(root, rules, profile, only);
  const total = Object.values(perRule).reduce((sum, n) => sum + n, 0);
  const out = [
    `Dry run: ${total} replacements in ${files.length} files, ${moves.length} path moves.`,
  ];
  const perCategory = {};
  for (const rule of rules) {
    if (perRule[rule.id])
      perCategory[rule.category] = (perCategory[rule.category] ?? 0) + perRule[rule.id];
  }
  out.push('', 'Per category:');
  for (const [category, count] of Object.entries(perCategory)) out.push(`  ${category}: ${count}`);
  out.push('', 'Per rule:');
  for (const rule of rules) {
    if (!perRule[rule.id]) continue;
    out.push(`  ${rule.id} (${rule.category}): ${perRule[rule.id]}`);
    for (const file of samples[rule.id].slice(0, maxSamples)) out.push(`    ${file}`);
  }
  if (moves.length > 0) {
    out.push('', 'Path moves (first entries):');
    for (const move of moves.slice(0, maxSamples * 3)) out.push(`  ${move.from} -> ${move.to}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

function apply(root, rules, profile, only) {
  const { files, moves, perRule } = scan(root, rules, profile, only);
  for (const { file, text } of files) writeFileSync(path.join(root, file), text);
  const conflicts = [];
  for (const { from, to } of moves) {
    if (existsSync(path.join(root, to))) {
      conflicts.push(`${from} -> ${to}`);
      continue;
    }
    mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'pipe' });
  }
  const moved = moves.filter(({ from, to }) => !conflicts.includes(`${from} -> ${to}`));
  if (moved.length > 0) moveGuardPaths(root, moved);
  const total = Object.values(perRule).reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `Applied ${total} replacements in ${files.length} files and ${moves.length - conflicts.length} path moves.\n`
  );
  for (const item of SPECIAL_ATTENTION)
    process.stdout.write(`[attention: ${item.id}] ${item.summary}\n`);
  if (conflicts.length > 0) {
    process.stderr.write(
      `Not moved, target already exists (merge these by hand):\n${conflicts.map((c) => `  ${c}`).join('\n')}\n`
    );
    process.exitCode = 1;
  }
  process.stdout.write(
    'Next: pnpm install (lockfile), regenerate generated catalogs, run the old-name guard.\n'
  );
}

/**
 * The old-name guard's allow list names exact files (exceptions, file-limited
 * keep entries). It is a SELF_PATHS file, so its contents are not renamed, but
 * its paths must follow the files they point at, or the exceptions go stale.
 */
export function moveGuardPaths(root, moved) {
  const allowList = path.join(root, 'scripts/guards/old-names-allow.json');
  if (!existsSync(allowList)) return;
  let text = readFileSync(allowList, 'utf8');
  for (const { from, to } of moved)
    text = text.split(JSON.stringify(from)).join(JSON.stringify(to));
  writeFileSync(allowList, text);
}

function check(root, rules, profile, only) {
  const { perRule, samples, moves } = scan(root, rules, profile, only);
  let total = moves.length;
  for (const [id, count] of Object.entries(perRule)) {
    total += count;
    for (const file of new Set(samples[id])) process.stdout.write(`${id} ${file}\n`);
  }
  for (const move of moves) process.stdout.write(`path ${move.from}\n`);
  process.stdout.write(`${total} remaining matches.\n`);
  if (total > 0) process.exitCode = 1;
}

export function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else args[key] = true;
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const profile = args.profile ?? 'toolkit';
  const root =
    args.root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (args.apply && !args.rules && !args.all) {
    throw new Error('--apply needs --rules <ids|categories> or --all.');
  }
  const rules = selectRules(args.all ? 'all' : args.rules, profile);
  const only = typeof args.only === 'string' ? args.only.split(',') : undefined;
  if (args.patch) {
    const translated = translatePatch(readFileSync(args.patch, 'utf8'), rules, profile);
    if (args.out) writeFileSync(args.out, translated);
    else process.stdout.write(translated);
  } else if (args.check) check(root, rules, profile, only);
  else if (args.apply) apply(root, rules, profile, only);
  else dryRun(root, rules, profile, Number(args.samples ?? 3), only);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
