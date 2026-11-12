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
 * (default: toolkit), --samples <n> (dry-run samples per rule, default 3).
 *
 * Keep-list entries that contain "dogsled" are masked before the rules run and
 * restored afterwards, so no rule can rewrite them. The tool never touches its
 * own files or the old-name guard (SELF_PATHS in mapping.mjs).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contentRules,
  maskedKeepList,
  pathRules,
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

// ─── Content ──────────────────────────────────────────────────────────────────

function applyRule(text, rule) {
  let count = 0;
  if (rule.match instanceof RegExp) {
    const next = text.replace(new RegExp(rule.match.source, rule.match.flags), (...args) => {
      count++;
      const groups = args.slice(
        1,
        args.findIndex((arg) => typeof arg === 'number')
      );
      return rule.replace.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
    });
    return { text: next, count };
  }
  const parts = text.split(rule.match);
  return { text: parts.join(rule.replace), count: parts.length - 1 };
}

/**
 * Rename one file's text. Returns { text, counts } with counts per rule id.
 * `file` is the repo-relative path used for include/exclude and keep paths.
 */
export function renameText(text, { file = '', rules, profile = 'toolkit' }) {
  const keep = maskedKeepList(profile).filter((k) => !k.paths || matchesAny(file, k.paths));
  const saved = [];
  let current = text;
  // Longest first, so `dogsled\.it` is masked before `dogsled.it`.
  for (const entry of [...keep].sort((a, b) => b.pattern.length - a.pattern.length)) {
    current = current.split(entry.pattern).join(`\u0000${saved.push(entry.pattern) - 1}\u0000`);
  }
  const counts = {};
  for (const rule of contentRules(rules)) {
    if (!ruleApplies(rule, file)) continue;
    const result = applyRule(current, rule);
    if (result.count > 0) {
      counts[rule.id] = (counts[rule.id] ?? 0) + result.count;
      current = result.text;
    }
  }
  current = current.replace(/\u0000(\d+)\u0000/g, (_, index) => saved[Number(index)]);
  return { text: current, counts };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** New path for a file, or null when no path rule matches. */
export function transformPath(file, rules) {
  let current = file;
  for (const rule of pathRules(rules)) {
    if (rule.match instanceof RegExp) {
      current = current.replace(new RegExp(rule.match.source, rule.match.flags), rule.replace);
    } else if (current === rule.match || current.startsWith(`${rule.match}/`)) {
      current = rule.replace + current.slice(rule.match.length);
    }
  }
  return current === file ? null : current;
}

// ─── Patches ──────────────────────────────────────────────────────────────────

/** Translate a unified diff (git format-patch output) through the rules. */
export function translatePatch(patchText, rules, profile = 'toolkit') {
  let file = '';
  const movePath = (p) => (p === '/dev/null' ? p : (transformPath(p, rules) ?? p));
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
      if (isSelfPath(file)) return line;
      return renameText(line, { file, rules, profile }).text;
    })
    .join('\n');
}

// ─── Repository modes ─────────────────────────────────────────────────────────

function listFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file && !SKIP_FILES.has(file) && !isSelfPath(file))
    .filter((file) => {
      // Regular files only: symlinks and deleted files are left alone.
      const full = path.join(root, file);
      return existsSync(full) && lstatSync(full).isFile();
    });
}

function scan(root, rules, profile) {
  const files = [];
  const moves = [];
  const perRule = {};
  const samples = {};
  const keptNames = maskedKeepList(profile).map((entry) => entry.pattern);
  for (const file of listFiles(root)) {
    // Binary files move with their folder but their bytes are never rewritten.
    if (!BINARY.test(file)) {
      const text = readFileSync(path.join(root, file), 'utf8');
      const result = renameText(text, { file, rules, profile });
      if (result.text !== text) files.push({ file, text: result.text });
      for (const [id, count] of Object.entries(result.counts)) {
        perRule[id] = (perRule[id] ?? 0) + count;
        (samples[id] ??= []).push(file);
      }
    }
    const to = transformPath(file, rules);
    if (to && !keptNames.some((name) => path.basename(file) === name))
      moves.push({ from: file, to });
  }
  return { files, moves, perRule, samples };
}

function dryRun(root, rules, profile, maxSamples) {
  const { files, moves, perRule, samples } = scan(root, rules, profile);
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

function apply(root, rules, profile) {
  const { files, moves, perRule } = scan(root, rules, profile);
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

function check(root, rules, profile) {
  const { perRule, samples, moves } = scan(root, rules, profile);
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
  if (args.patch) {
    const translated = translatePatch(readFileSync(args.patch, 'utf8'), rules, profile);
    if (args.out) writeFileSync(args.out, translated);
    else process.stdout.write(translated);
  } else if (args.check) check(root, rules, profile);
  else if (args.apply) apply(root, rules, profile);
  else dryRun(root, rules, profile, Number(args.samples ?? 3));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
