import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

import chalk, { Chalk } from 'chalk';
import type { Command } from 'commander';

import * as fmt from '../lib/output/formatter.js';
import { waitForProcess } from '../runtime/process.js';
import type { GlobalOptions, OutputOptions } from '../types/index.js';
import { LESSONS } from './lessons.js';
import type { Lesson } from './lessons.js';
import { localStateDir } from '@bobsled-inc/connections';
import { TUTOR_PROGRESS_FILE_SPELLINGS } from './legacy-names.js';

function createChalk(options: OutputOptions): typeof chalk {
  if (options.noColor || process.env['NO_COLOR'] !== undefined) {
    return new Chalk({ level: 0 });
  }
  return chalk;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgressFile {
  completed: Record<string, string>;
  skipped: Record<string, string>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSections(): string[] {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const lesson of LESSONS) {
    if (!seen.has(lesson.section)) {
      seen.add(lesson.section);
      sections.push(lesson.section);
    }
  }
  return sections;
}

function getLessonsForSection(section: string): Lesson[] {
  return LESSONS.filter((l) => l.section === section);
}

function findProjectRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, 'pnpm-workspace.yaml')) ||
      existsSync(join(dir, 'lerna.json')) ||
      packageJsonHasWorkspaces(join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function packageJsonHasWorkspaces(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { workspaces?: unknown };
    return parsed.workspaces !== undefined;
  } catch {
    return false;
  }
}

const TUTOR_PROGRESS_FILE = '.dogsled-tutor-progress.json';

function getProgressPath(): string {
  const root = findProjectRoot();
  return join(localStateDir(root), 'tutor-lab', TUTOR_PROGRESS_FILE);
}

/** The progress file to read: the current name, else one an earlier Core wrote. */
function readableProgressPath(): string {
  const progressPath = getProgressPath();
  if (existsSync(progressPath)) return progressPath;
  const dir = resolve(progressPath, '..');
  const earlier = TUTOR_PROGRESS_FILE_SPELLINGS.map((name) => join(dir, name)).find(existsSync);
  return earlier ?? progressPath;
}

function readProgress(): ProgressFile {
  const progressPath = readableProgressPath();
  if (!existsSync(progressPath)) {
    return { completed: {}, skipped: {}, updatedAt: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(progressPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'completed' in parsed &&
      'skipped' in parsed
    ) {
      return parsed as ProgressFile;
    }
    return { completed: {}, skipped: {}, updatedAt: new Date().toISOString() };
  } catch {
    return { completed: {}, skipped: {}, updatedAt: new Date().toISOString() };
  }
}

function writeProgress(progress: ProgressFile): void {
  const progressPath = getProgressPath();
  const dir = resolve(progressPath, '..');
  mkdirSync(dir, { recursive: true });
  progress.updatedAt = new Date().toISOString();
  writeFileSync(progressPath, JSON.stringify(progress, null, 2) + '\n', 'utf-8');
}

function getNextLessonIndex(progress: ProgressFile): number {
  for (let i = 0; i < LESSONS.length; i++) {
    const lesson = LESSONS[i]!;
    if (!progress.completed[lesson.id] && !progress.skipped[lesson.id]) {
      return i;
    }
  }
  return LESSONS.length; // all done
}

function resolveLessonCwd(lesson: Lesson): string {
  const root = findProjectRoot();
  switch (lesson.cwd) {
    case 'learn-sandbox':
      return join(root, 'workspace', 'learn-sandbox');
    case 'first-ingest':
      return join(root, 'examples', 'first-ingest');
    case 'shop':
      return join(root, 'workspace', 'shop-demo');
    case 'entity':
      return join(root, 'workspace', 'entity-graph-demo');
    case 'lab': {
      const labDir = join(localStateDir(root), 'tutor-lab');
      mkdirSync(labDir, { recursive: true });
      return labDir;
    }
    case 'repo':
      return root;
    default:
      return process.cwd();
  }
}

function checkEnvVars(lesson: Lesson): { available: boolean; missing: string[] } {
  if (lesson.requiredEnv) {
    const requiredAll = lesson.requiredEnv.all ?? [];
    const requiredAny = lesson.requiredEnv.any ?? [];
    const missingAll = requiredAll.filter((v) => process.env[v] === undefined);
    const hasAny =
      requiredAny.length === 0 || requiredAny.some((v) => process.env[v] !== undefined);
    const missing = [...missingAll, ...(hasAny ? [] : requiredAny)];
    return { available: missing.length === 0, missing };
  }

  if (!lesson.env || lesson.env.length === 0) {
    return { available: true, missing: [] };
  }

  if (lesson.envMode === 'any') {
    const found = lesson.env.some((v) => process.env[v] !== undefined);
    if (found) return { available: true, missing: [] };
    return { available: false, missing: lesson.env };
  }

  const missing = lesson.env.filter((v) => process.env[v] === undefined);
  return { available: missing.length === 0, missing };
}

function detectWarehouse(): { dest: string; flag: string } | null {
  if (process.env['SNOWFLAKE_ACCOUNT']) return { dest: 'snowflake', flag: '--dest snowflake' };
  if (process.env['GOOGLE_CLOUD_PROJECT']) return { dest: 'bigquery', flag: '--dest bigquery' };
  if (process.env['REDSHIFT_HOST']) return { dest: 'redshift', flag: '--dest redshift' };
  if (process.env['DATABRICKS_HOST']) return { dest: 'databricks', flag: '--dest databricks' };
  return null;
}

function buildWarehouseCommand(lessonId: string, cli: string): string {
  const wh = detectWarehouse();
  if (!wh) return '';

  switch (lessonId) {
    case 'warehouse-check':
      return `${cli} load check ${wh.flag}`;
    case 'warehouse-load':
      return `${cli} extract run --integration linear --resource issues --limit 5 | ${cli} load run ${wh.flag}`;
    case 'warehouse-query':
      return `${cli} load query ${wh.flag} "SELECT count(*) FROM linear__issues"`;
    default:
      return '';
  }
}

function resolveCommand(lesson: Lesson, cli: string): string {
  const raw = buildWarehouseCommand(lesson.id, cli) || lesson.command || '';
  if (!raw) return '';
  return cli !== 'dogsled' ? raw.replace(/\bdogsled\b/g, cli) : raw;
}

async function spawnCommand(
  command: string,
  cwd: string,
  outputOpts: OutputOptions
): Promise<number> {
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: outputOpts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (outputOpts.json && outputOpts.verbose) {
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
  } else if (outputOpts.json) {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  try {
    const result = await waitForProcess(child, 'lesson command');
    return result.exitCode;
  } catch {
    return 1;
  }
}

function humanWrite(message: string, outputOpts: OutputOptions): void {
  if (outputOpts.json) {
    process.stderr.write(message);
  } else {
    process.stdout.write(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function printSectionHeader(section: string, c: typeof chalk, outputOpts: OutputOptions): void {
  humanWrite(`\n${c.bold.cyan(`━━ ${section} ━━`)}\n\n`, outputOpts);
}

function printLessonHeader(
  index: number,
  lesson: Lesson,
  c: typeof chalk,
  outputOpts: OutputOptions
): void {
  const total = LESSONS.length;
  const pct = Math.round(((index + 1) / total) * 100);
  const prefix = c.dim(`[${index + 1}/${total} · ${pct}%]`);
  const sectionLabel = c.dim(lesson.section);
  const title = c.bold(lesson.title);
  humanWrite(`${prefix} ${sectionLabel}  ${c.dim('›')}  ${title}\n`, outputOpts);
}

function printNote(lesson: Lesson, outputOpts: OutputOptions): void {
  if (lesson.body) {
    humanWrite('\n', outputOpts);
    for (const line of lesson.body) {
      humanWrite(`  ${line}\n`, outputOpts);
    }
    humanWrite('\n', outputOpts);
  }
}

function printThink(lesson: Lesson, c: typeof chalk, outputOpts: OutputOptions): void {
  humanWrite(c.dim.italic(`  💡 ${lesson.think}`) + '\n', outputOpts);
}

function printCommand(command: string, c: typeof chalk, outputOpts: OutputOptions): void {
  humanWrite(`\n  ${c.green('$')} ${c.bold(command)}\n\n`, outputOpts);
}

function printSectionCompletion(
  section: string,
  cli: string,
  c: typeof chalk,
  outputOpts: OutputOptions
): void {
  const lessons = getLessonsForSection(section);
  const commands = lessons
    .filter((l) => l.type !== 'note')
    .map((lesson) => resolveCommand(lesson, cli))
    .filter((command) => command.length > 0);

  humanWrite(`\n${c.bold.cyan(`━━ ${section} Complete ━━`)}\n\n`, outputOpts);

  if (commands.length > 0) {
    humanWrite(`${c.bold('Commands learned:')}\n`, outputOpts);
    for (const cmd of commands) {
      humanWrite(`  ${c.dim(cmd)}\n`, outputOpts);
    }
    humanWrite('\n', outputOpts);
  }

  const concepts: Record<string, string> = {
    'Phase 0: CLI Surface': 'The CLI exposes 83 typed integrations — composable building blocks.',
    'Phase 1: Credential-Free Extract':
      'SCHEMA→RECORD→STATE protocol; three load strategies (append, merge, full_refresh).',
    'Unified Ingest':
      'Documents and APIs share the same protocol, loader, local database, and query surface.',
    'Phase 2: API Extract & Load':
      'extract | load pipe is the core flow; pipeline is syntactic sugar.',
    'Phase 3: Incremental Load & State': 'Merge deduplicates by primary key — idempotent loads.',
    'Phase 4: Model Spec Data Modeling':
      'view = live query (lazy), table = pre-materialized (fast reads).',
    'Phase 5: Shop Demo': 'A complete semantic model: seeds → staging → facts → metrics → VQs.',
    'Phase 6: Verified Queries':
      'VQs are tested SQL templates; ask converts English to SQL via the semantic model.',
    'Phase 7: Entity Resolution — Data & Concepts':
      'Standardize→Block→Score→Threshold turns messy source records into reviewable pair evidence.',
    'Phase 8: Entity Resolution — Clustering & Inspection':
      'Connected components convert pair decisions into stable entity assignments and crosswalks.',
    'Phase 9: Survivorship — Golden Records':
      'Survivorship applies explicit value-selection policy to build auditable golden records.',
    'Phase 10: Review Workflows & Truthsets':
      'Review decisions and truthsets create a feedback loop for measurable match quality.',
    'Phase 11: Relationships & Objects':
      'Resolved entities become a graph through relationship specs and object-serving shapes.',
    'Phase 12: Entity Profiles, Trust & Activation':
      'Profiles and quality scores decide which resolved entities are ready for downstream use.',
    'Phase 13: MCP Server Extraction':
      'MCP resources call tools but still emit the same SCHEMA→RECORD→STATE protocol.',
    'Phase 14: Advanced Extraction & Loading':
      'State, schema evolution, retries, and load strategy define production pipeline safety.',
    'Phase 15: Non-Local Warehouse':
      'Same config, any warehouse — Dogsled abstracts the destination.',
    'Entity Graph + SDK':
      'Resolved profiles, document mentions, relationship evidence, and SDK IR form the entity graph read surface.',
    'Phase 16: Wrap Up': 'You have the full mental model for Dogsled.',
  };

  const concept = concepts[section];
  if (concept) {
    humanWrite(`${c.bold('Key concept:')} ${concept}\n`, outputOpts);
  }
}

function printSectionList(progress: ProgressFile, outputOpts: OutputOptions): void {
  const sections = getSections();
  const c = createChalk(outputOpts);

  const stats = sections.map((section, index) => {
    const lessons = getLessonsForSection(section);
    const completed = lessons.filter((l) => progress.completed[l.id]).length;
    const skipped = lessons.filter((l) => progress.skipped[l.id]).length;
    const uniqueEnv = [
      ...new Set(
        lessons.flatMap((l) => [
          ...(l.env ?? []),
          ...(l.requiredEnv?.all ?? []),
          ...(l.requiredEnv?.any ?? []),
        ])
      ),
    ];
    const missingEnv = uniqueEnv.filter((v) => process.env[v] === undefined);
    return { index, section, total: lessons.length, completed, skipped, missingEnv };
  });

  if (outputOpts.json) {
    fmt.output(
      stats.map((s) => ({
        ...s,
        missingEnv: s.missingEnv.length > 0 ? s.missingEnv : undefined,
      })),
      outputOpts
    );
    return;
  }

  humanWrite('\n', outputOpts);
  for (const s of stats) {
    const progressStr =
      s.completed === s.total
        ? c.green(`✓ ${s.completed}/${s.total}`)
        : c.dim(`○ ${s.completed}/${s.total}`);
    const envWarn = s.missingEnv.length > 0 ? c.yellow('  ⚠ requires credentials') : '';
    const countLabel = c.dim(`${s.total} lessons`);
    humanWrite(
      `  ${c.bold(`[${s.index}]`)} ${s.section.padEnd(32)} ${countLabel}   ${progressStr}${envWarn}\n`,
      outputOpts
    );
  }
  humanWrite('\n', outputOpts);
}

// ---------------------------------------------------------------------------
// Core tutorial loop
// ---------------------------------------------------------------------------

const AUTO_ADVANCE_DELAY_MS = 1500;

async function handleMenuJump(
  rl: ReturnType<typeof createInterface>,
  progress: ProgressFile,
  outputOpts: OutputOptions,
  c: typeof chalk
): Promise<{ jumped: boolean; newIndex: number }> {
  printSectionList(progress, outputOpts);
  const jumpInput = await rl.question(c.dim('  Jump to section number (or Enter to continue): '));
  const jumpNum = parseInt(jumpInput.trim(), 10);
  if (!isNaN(jumpNum) && jumpNum >= 0) {
    const sections = getSections();
    const targetSection = sections[jumpNum];
    if (targetSection) {
      const targetIdx = LESSONS.findIndex((l) => l.section === targetSection);
      if (targetIdx >= 0) {
        return { jumped: true, newIndex: targetIdx };
      }
    }
  }
  return { jumped: false, newIndex: -1 };
}

async function runTutorial(options: {
  startIndex: number;
  auto: boolean;
  cli: string;
  outputOpts: OutputOptions;
}): Promise<void> {
  const { startIndex, auto, cli, outputOpts } = options;
  const progress = readProgress();
  const c = createChalk(outputOpts);

  const rl = createInterface({
    input: process.stdin,
    output: outputOpts.json ? process.stderr : process.stdout,
  });

  let currentSection = '';
  let i = startIndex;

  try {
    while (i < LESSONS.length) {
      const lesson = LESSONS[i]!;

      // Section transition
      if (lesson.section !== currentSection) {
        if (currentSection) {
          const prevLessons = getLessonsForSection(currentSection);
          const allDone = prevLessons.every(
            (l) => progress.completed[l.id] || progress.skipped[l.id]
          );
          if (allDone) {
            if (!outputOpts.quiet) printSectionCompletion(currentSection, cli, c, outputOpts);
            if (!auto) {
              const next = getSections().find(
                (s) =>
                  s !== currentSection &&
                  getLessonsForSection(s).some(
                    (l) => !progress.completed[l.id] && !progress.skipped[l.id]
                  )
              );
              if (next) {
                humanWrite(c.dim(`Next: ${next}  →  press Enter to continue\n`), outputOpts);
                await rl.question('');
              }
            }
          }
        }
        currentSection = lesson.section;
        if (!outputOpts.quiet) printSectionHeader(currentSection, c, outputOpts);
      }

      // Env var gating
      const envCheck = checkEnvVars(lesson);
      if (!envCheck.available) {
        if (!outputOpts.quiet) {
          humanWrite(
            c.yellow(`  Skipping: ${lesson.title}`) +
              c.dim(` (missing: ${envCheck.missing.join(', ')})`) +
              '\n',
            outputOpts
          );
        }
        if (outputOpts.json) {
          fmt.output(
            { lesson: lesson.id, status: 'skipped', missing: envCheck.missing },
            outputOpts
          );
        }
        progress.skipped[lesson.id] = new Date().toISOString();
        writeProgress(progress);
        i++;
        continue;
      }

      // Print lesson header
      if (!outputOpts.quiet) {
        printLessonHeader(i, lesson, c, outputOpts);
        humanWrite(c.dim(`  ${lesson.why}`) + '\n', outputOpts);
      }

      if (lesson.type === 'note') {
        if (!outputOpts.quiet) {
          printNote(lesson, outputOpts);
          printThink(lesson, c, outputOpts);
        }
        progress.completed[lesson.id] = new Date().toISOString();
        writeProgress(progress);
        if (outputOpts.json) {
          fmt.output({ lesson: lesson.id, status: 'completed' }, outputOpts);
        }

        if (!auto) {
          humanWrite(c.dim('  Press Enter to continue (or type "menu")...') + '\n', outputOpts);
          const input = await rl.question('  ');
          if (input.trim().toLowerCase() === 'menu') {
            const jump = await handleMenuJump(rl, progress, outputOpts, c);
            if (jump.jumped) {
              i = jump.newIndex;
              currentSection = '';
              continue;
            }
          }
        } else {
          await delay(AUTO_ADVANCE_DELAY_MS);
        }

        i++;
        continue;
      }

      // Command lesson
      const command = resolveCommand(lesson, cli);
      if (!command) {
        progress.skipped[lesson.id] = new Date().toISOString();
        writeProgress(progress);
        if (outputOpts.json) {
          fmt.output({ lesson: lesson.id, status: 'skipped', reason: 'no-command' }, outputOpts);
        }
        i++;
        continue;
      }

      if (!outputOpts.quiet) {
        printCommand(command, c, outputOpts);
        printThink(lesson, c, outputOpts);
      }

      if (!auto) {
        humanWrite(c.dim('  Press Enter to run (or "skip" / "menu")...') + '\n', outputOpts);
        const input = await rl.question('  ');
        const trimmed = input.trim().toLowerCase();

        if (trimmed === 'skip') {
          progress.skipped[lesson.id] = new Date().toISOString();
          writeProgress(progress);
          i++;
          continue;
        }

        if (trimmed === 'menu') {
          const jump = await handleMenuJump(rl, progress, outputOpts, c);
          if (jump.jumped) {
            i = jump.newIndex;
            currentSection = '';
            continue;
          }
          continue;
        }
      }

      // Execute command
      const cwd = resolveLessonCwd(lesson);
      humanWrite('\n', outputOpts);
      const exitCode = await spawnCommand(command, cwd, outputOpts);
      humanWrite('\n', outputOpts);

      if (exitCode === 0) {
        progress.completed[lesson.id] = new Date().toISOString();
        writeProgress(progress);
        if (!outputOpts.quiet) humanWrite(c.green('  ✓ Done') + '\n\n', outputOpts);
        if (outputOpts.json) {
          fmt.output({ lesson: lesson.id, status: 'completed', exitCode: 0 }, outputOpts);
        }
        if (auto) {
          await delay(AUTO_ADVANCE_DELAY_MS);
        }
      } else {
        if (outputOpts.json) {
          fmt.output({ lesson: lesson.id, status: 'failed', exitCode }, outputOpts);
        }
        if (!auto) {
          humanWrite(
            c.yellow(`  Command exited with code ${exitCode}. `) +
              c.dim('Press Enter to retry, or type "skip" to continue.') +
              '\n',
            outputOpts
          );
          const retryInput = await rl.question('  ');
          if (retryInput.trim().toLowerCase() === 'skip') {
            progress.skipped[lesson.id] = new Date().toISOString();
            writeProgress(progress);
          } else {
            continue;
          }
        } else {
          progress.skipped[lesson.id] = new Date().toISOString();
          writeProgress(progress);
        }
      }

      i++;
    }

    // All lessons complete
    if (i >= LESSONS.length) {
      const lastLesson = LESSONS.length > 0 ? LESSONS[LESSONS.length - 1] : undefined;
      if (lastLesson && currentSection === lastLesson.section && !outputOpts.quiet) {
        printSectionCompletion(lastLesson.section, cli, c, outputOpts);
      }
      if (!outputOpts.quiet) humanWrite(c.bold.green('\n  Tutorial complete! 🎉\n\n'), outputOpts);
      if (outputOpts.json) fmt.output({ status: 'complete', total: LESSONS.length }, outputOpts);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Startup menu
// ---------------------------------------------------------------------------

async function showStartupMenu(progress: ProgressFile, outputOpts: OutputOptions): Promise<number> {
  const c = createChalk(outputOpts);
  const rl = createInterface({
    input: process.stdin,
    output: outputOpts.json ? process.stderr : process.stdout,
  });

  try {
    humanWrite(`\n${c.bold.cyan('━━ dogsled learn ━━')}\n\n`, outputOpts);
    humanWrite('What would you like to do?\n\n', outputOpts);

    const nextIdx = getNextLessonIndex(progress);
    const hasProgress =
      Object.keys(progress.completed).length > 0 || Object.keys(progress.skipped).length > 0;

    if (hasProgress && nextIdx < LESSONS.length) {
      const lesson = LESSONS[nextIdx]!;
      const pct = Math.round(((nextIdx + 1) / LESSONS.length) * 100);
      humanWrite(
        `  ${c.bold('[0]')} Resume: ${lesson.section} · Lesson ${nextIdx + 1}/${LESSONS.length} (${pct}%)\n`,
        outputOpts
      );
    }

    humanWrite(`  ${c.bold('[1]')} Start from the beginning\n`, outputOpts);
    humanWrite(`  ${c.bold('[2]')} Jump to a section\n`, outputOpts);
    humanWrite('\n', outputOpts);

    const answer = await rl.question('  > ');
    const choice = answer.trim();

    if (choice === '0' && hasProgress) {
      rl.close();
      return nextIdx;
    }

    if (choice === '1') {
      rl.close();
      return 0;
    }

    if (choice === '2') {
      humanWrite('\n', outputOpts);
      printSectionList(progress, outputOpts);
      const sections = getSections();
      const sectionAnswer = await rl.question(
        c.dim('  Enter section number (0-' + (sections.length - 1) + '): ')
      );
      const sectionNum = parseInt(sectionAnswer.trim(), 10);
      if (!isNaN(sectionNum) && sectionNum >= 0 && sectionNum < sections.length) {
        const targetSection = sections[sectionNum]!;
        const targetIdx = LESSONS.findIndex((l) => l.section === targetSection);
        rl.close();
        return targetIdx >= 0 ? targetIdx : 0;
      }
      rl.close();
      return nextIdx < LESSONS.length ? nextIdx : 0;
    }

    // Default: resume or start
    rl.close();
    return hasProgress ? nextIdx : 0;
  } catch {
    rl.close();
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export function registerLearnCommand(program: Command): void {
  program
    .command('learn')
    .description('Interactive CLI tutorial — learn Dogsled step by step')
    .option('--list', 'Show all phases with progress')
    .option('--reset', 'Clear all progress')
    .option('--section <name>', 'Jump to a named section (e.g. "Phase 4")')
    .option('--goto <n>', 'Jump to lesson number N', parseInt)
    .option('--auto', 'Auto-advance on success (1.5s delay)')
    .option('--cli <cmd>', 'Override CLI binary (default: DOGSLED_CLI env or "dogsled")')
    .action(
      async (opts: {
        list?: boolean;
        reset?: boolean;
        section?: string;
        goto?: number;
        auto?: boolean;
        cli?: string;
      }) => {
        const globalOpts = program.opts<GlobalOptions>();
        const outputOpts = fmt.toOutputOptions(globalOpts);
        const cli = opts.cli ?? process.env['DOGSLED_CLI'] ?? 'dogsled';

        // --reset
        if (opts.reset) {
          if (opts.section) {
            const progress = readProgress();
            const targetSection = getSections().find((s) =>
              s.toLowerCase().includes(opts.section!.toLowerCase())
            );
            if (!targetSection) {
              fmt.error(`Section not found: "${opts.section}"`, outputOpts);
              process.exitCode = 2;
              return;
            }
            const lessons = getLessonsForSection(targetSection);
            for (const lesson of lessons) {
              delete progress.completed[lesson.id];
              delete progress.skipped[lesson.id];
            }
            writeProgress(progress);
            fmt.success(`Reset progress for: ${targetSection}`, outputOpts);
          } else {
            const emptyProgress: ProgressFile = {
              completed: {},
              skipped: {},
              updatedAt: new Date().toISOString(),
            };
            writeProgress(emptyProgress);
            fmt.success('All progress cleared.', outputOpts);
          }
          return;
        }

        // --list
        if (opts.list) {
          const progress = readProgress();
          printSectionList(progress, outputOpts);
          return;
        }

        // --goto
        if (opts.goto !== undefined) {
          if (isNaN(opts.goto)) {
            fmt.error(`Invalid lesson number: "${opts.goto}"`, outputOpts);
            process.exitCode = 2;
            return;
          }
          const idx = opts.goto - 1;
          if (idx < 0 || idx >= LESSONS.length) {
            fmt.error(`Lesson number out of range. Valid: 1-${LESSONS.length}`, outputOpts);
            process.exitCode = 2;
            return;
          }
          await runTutorial({ startIndex: idx, auto: !!opts.auto, cli, outputOpts });
          return;
        }

        // --section
        if (opts.section) {
          const targetSection = getSections().find((s) =>
            s.toLowerCase().includes(opts.section!.toLowerCase())
          );
          if (!targetSection) {
            fmt.error(`Section not found: "${opts.section}"`, outputOpts);
            process.exitCode = 2;
            return;
          }
          const targetIdx = LESSONS.findIndex((l) => l.section === targetSection);
          if (targetIdx < 0) {
            fmt.error(`No lessons found in section: "${targetSection}"`, outputOpts);
            process.exitCode = 2;
            return;
          }
          await runTutorial({ startIndex: targetIdx, auto: !!opts.auto, cli, outputOpts });
          return;
        }

        // TTY guard: interactive mode requires a terminal
        if (!process.stdin.isTTY && !opts.auto) {
          fmt.error(
            'Interactive mode requires a TTY. Use --auto, --list, --goto, or --section in non-interactive environments.',
            outputOpts
          );
          process.exitCode = 2;
          return;
        }

        // Default: show startup menu
        const progress = readProgress();
        const startIndex = opts.auto
          ? getNextLessonIndex(progress)
          : await showStartupMenu(progress, outputOpts);
        await runTutorial({ startIndex, auto: !!opts.auto, cli, outputOpts });
      }
    );
}
