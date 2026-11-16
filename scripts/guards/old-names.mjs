/**
 * Old-name guard for the Dogsled Core -> Bobsled Core rename.
 *
 * Counts "dogsled" in tracked file contents and paths, minus the keep list in
 * old-names-allow.json (the Dogsled app brand and other names that stay).
 *
 * Usage:
 *   node scripts/guards/old-names.mjs            # report only, always exits 0
 *   node scripts/guards/old-names.mjs --list     # also print file:line for each finding
 *   node scripts/guards/old-names.mjs --ratchet  # fail if a count rose above the baseline
 *   node scripts/guards/old-names.mjs --update   # write today's counts as the baseline
 *   node scripts/guards/old-names.mjs --strict   # fail on any finding (end of step 5)
 *
 * Exceptions in old-names-allow.json double as a must-keep list: --ratchet and
 * --strict also fail when an exception matches nothing, because that means a
 * compatibility reader lost an old name it has to keep accepting.
 *
 * CI runs --strict: the rename is done, so every old name left is an exception.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyArea,
  compareSection,
  guardsDir,
  listScanFiles,
  parseArgs,
  readBaseline,
  repoRoot,
  scanFileLines,
  writeBaseline,
} from './lib.mjs';
import { filterOldNameFindings, validateOldNameExceptions } from './old-name-exceptions.mjs';

const ALLOW_PATH = path.join(guardsDir, 'old-names-allow.json');
const BASELINE_PATH = path.join(guardsDir, 'old-names-baseline.json');

// Files that spell the old name on purpose: this guard and the rename tooling.
export const SELF_PATHS = new Set([
  'scripts/guards/old-names.mjs',
  'scripts/guards/old-names-allow.json',
  'scripts/guards/old-names-baseline.json',
  'tests/unit/guard-old-names.test.mjs',
  'scripts/rename/README.md',
  'scripts/rename/mapping.mjs',
  'scripts/rename/rename.mjs',
  'tests/unit/rename-mapping.test.mjs',
]);

export const PATTERN_IDS = [
  'dogsled-word',
  'old-warehouse-prefix',
  'track-config',
  'track-env',
  'track-kind',
  'dogsled-path',
];

/** Validates old-names-allow.json: keep-list entries plus exact per-file exceptions. */
export function loadAllowList(data = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'))) {
  if (data?.version !== 1 || !Array.isArray(data.keep) || !Array.isArray(data.exceptions))
    throw new Error('Invalid old-name allow list.');
  const keep = data.keep.map((entry) => {
    const keys = Object.keys(entry ?? {})
      .sort()
      .join(',');
    if (
      !['note,pattern', 'files,note,pattern'].includes(keys) ||
      typeof entry.pattern !== 'string' ||
      !/dogsled/i.test(entry.pattern) ||
      typeof entry.note !== 'string' ||
      !entry.note.trim() ||
      (entry.files &&
        (!Array.isArray(entry.files) || entry.files.some((f) => typeof f !== 'string')))
    )
      throw new Error(
        'Keep entries need a literal pattern containing "dogsled", a note and optional exact files.'
      );
    return entry;
  });
  return {
    keep,
    exceptions: validateOldNameExceptions({ version: 1, exceptions: data.exceptions }, PATTERN_IDS),
  };
}

/** Character ranges of a line covered by keep-list entries that apply to the file. */
function keptRanges(line, file, keep) {
  const ranges = [];
  for (const entry of keep) {
    if (entry.files && !entry.files.includes(file)) continue;
    for (let at = line.indexOf(entry.pattern); at !== -1; at = line.indexOf(entry.pattern, at + 1))
      ranges.push([at, at + entry.pattern.length]);
  }
  return ranges;
}

function patternsFor(keep) {
  const outsideKeep = (regex) => (line, file) => {
    const ranges = keptRanges(line, file, keep);
    return [...line.matchAll(regex)]
      .filter((m) => !ranges.some(([start, end]) => m.index >= start && m.index < end))
      .map((m) => ({ column: m.index + 1 }));
  };
  return [
    { id: 'dogsled-word', scan: outsideKeep(/dogsled/gi) },
    { id: 'old-warehouse-prefix', scan: outsideKeep(/\b_{1,2}(?:track|dogsled)_[a-z0-9_]+/gi) },
    // Track-era names: Core must keep rejecting them, never start writing them again.
    { id: 'track-config', scan: outsideKeep(/\btrack\.ya?ml\b|\.track\//g) },
    { id: 'track-env', scan: outsideKeep(/\bTRACK_[A-Z0-9_]+/g) },
    { id: 'track-kind', scan: outsideKeep(/\btrack\.(?:model|pipeline|runner|entity_graph)\./g) },
  ];
}

export function scanFile(file, lines, allow = loadAllowList()) {
  const results = filterOldNameFindings(
    file,
    lines,
    scanFileLines(file, lines, patternsFor(allow.keep)),
    allow.exceptions
  );
  const pathHit = /dogsled/i.test(file) && !allow.keep.some((k) => file.includes(k.pattern));
  results.set('dogsled-path', pathHit ? [{ file, line: 0, column: 0 }] : []);
  return results;
}

/**
 * Exceptions that match nothing. Each exception guards an old name that must
 * stay (a compatibility reader); a stale one means that name was deleted.
 */
export function staleExceptions(allow = loadAllowList(), read = readRepoFile) {
  return allow.exceptions.filter((entry) => {
    const text = read(entry.path);
    if (text === null) return true;
    const regex = new RegExp(entry.pattern);
    return !text.split('\n').some((line) => regex.test(line));
  });
}

function readRepoFile(file) {
  try {
    return readFileSync(path.join(repoRoot, file), 'utf8');
  } catch {
    return null;
  }
}

export function runScan(allow = loadAllowList()) {
  const patterns = Object.fromEntries(PATTERN_IDS.map((id) => [id, 0]));
  const areas = {};
  const findings = [];
  for (const file of listScanFiles()) {
    if (SELF_PATHS.has(file)) continue;
    let content;
    try {
      content = readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const [id, rows] of scanFile(file, content.split('\n'), allow)) {
      if (rows.length === 0) continue;
      patterns[id] += rows.length;
      const area = classifyArea(file);
      areas[area] = (areas[area] ?? 0) + rows.length;
      findings.push(...rows.map((row) => ({ ...row, id })));
    }
  }
  return { patterns, areas, findings };
}

function report({ patterns, areas, findings }, baseline, mode, stale) {
  const total = Object.values(patterns).reduce((sum, n) => sum + n, 0);
  const files = new Set(findings.map((f) => f.file)).size;
  const lines = [`Old-name guard (${mode}): ${total} findings in ${files} files.`, ''];
  lines.push('| Pattern | Count | Baseline |', '| --- | --- | --- |');
  for (const [id, count] of Object.entries(patterns))
    lines.push(`| ${id} | ${count} | ${baseline?.patterns?.[id] ?? '-'} |`);
  lines.push('', '| Area | Count | Baseline |', '| --- | --- | --- |');
  for (const [area, count] of Object.entries(areas).sort((a, b) => b[1] - a[1]))
    lines.push(`| ${area} | ${count} | ${baseline?.areas?.[area] ?? '-'} |`);
  lines.push('', `Stale exceptions (a kept old name was removed): ${stale.length}`);
  for (const entry of stale) lines.push(`- ${entry.patternId} ${entry.path}: ${entry.reason}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const allow = loadAllowList();
  const result = runScan(allow);
  const stale = staleExceptions(allow);
  const baseline = readBaseline(BASELINE_PATH);
  const mode = args.strict ? 'strict' : args.ratchet ? 'ratchet' : 'report only';
  const text = report(result, baseline, mode, stale);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (args.list) {
    for (const f of result.findings) process.stdout.write(`${f.id} ${f.file}:${f.line}\n`);
  }
  if (args.update) {
    writeBaseline(BASELINE_PATH, { version: 1, patterns: result.patterns, areas: result.areas });
    process.stdout.write('Baseline updated.\n');
  }
  if ((args.ratchet || args.strict) && stale.length > 0) {
    process.stderr.write(
      'Stale exceptions: a compatibility reader lost an old name it must keep.\n'
    );
    process.exitCode = 1;
  }
  if (args.ratchet) {
    if (!baseline) throw new Error('No baseline; run with --update first.');
    const increases = [
      ...compareSection(baseline.patterns, result.patterns, 'pattern').increases,
      ...compareSection(baseline.areas, result.areas, 'area').increases,
    ];
    for (const inc of increases)
      process.stderr.write(`${inc.label} ${inc.key}: ${inc.baseline} -> ${inc.current}\n`);
    if (increases.length > 0) process.exitCode = 1;
  }
  if (args.strict && result.findings.length > 0) {
    process.stderr.write('Old names remain outside the allow list (--strict).\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
