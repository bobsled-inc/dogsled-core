import { createInterface } from 'node:readline/promises';

import { Option, type Command } from 'commander';
import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

import type { HumanFeedbackOutcome } from '../compiler/identity/types.js';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';
import { outputTableName } from '../compiler/output-tables/index.js';
import { out } from '@bobsled-inc/model-spec/shared';

import {
  createDialectOption,
  loadRunnerModule,
  parsePositiveIntOption,
} from '@bobsled-inc/model-spec/shared';

interface ReviewTarget {
  entity: string;
  name: string;
  schema: string;
  midpoint: number;
}

type ResolveReviewTargets = (
  entityNames: string[],
  options: { schema?: string; dialect?: SupportedDialect },
  globalOptions: { verbose?: boolean; quiet?: boolean }
) => { dialect: SupportedDialect; quiet: boolean; targets: ReviewTarget[] };

interface ReviewFeedbackOptions {
  entity: string;
  limit?: number;
  decisionSource?: 'agent' | 'human';
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  json?: boolean;
}

const ReviewFeedbackRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    decision: z.enum(['merge', 'not_match', 'defer']),
    confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    reason: z.string().nullable().optional(),
    decision_source: z.string().nullable().optional(),
    decided_at: z.string().nullable().optional(),
  })
);

function buildPendingFeedbackQuery(
  entityName: string,
  targetSchema: string,
  dialect: SupportedDialect,
  limit: number,
  decisionSource?: 'agent' | 'human'
): string {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new CommandError(`Invalid limit ${limit}. Expected a non-negative integer.`);
  }

  const reviewDecisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );
  const pairIdColumn = quoteIdentifier('pair_id', dialect);
  const decisionColumn = quoteIdentifier('decision', dialect);
  const confidenceColumn = quoteIdentifier('confidence', dialect);
  const reasonColumn = quoteIdentifier('reason', dialect);
  const outcomeColumn = quoteIdentifier('human_feedback_outcome', dialect);
  const sourceColumn = quoteIdentifier('decision_source', dialect);
  const decidedAtColumn = quoteIdentifier('decided_at', dialect);
  const rowNumberColumn = quoteIdentifier('rn', dialect);
  // Two-step filtering. We rank ALL rows (`outcomeColumn IS NULL` plus the
  // optional source filter) so the latest-per-pair winner is correct, then
  // drop legacy `escalate` rows from the OUTER query. Filtering legacy
  // values inside the CTE would shift `rn = 1` to a stale older row when a
  // pair's most-recent decision is `escalate` — and we'd silently record
  // feedback against the wrong call. The Zod schema only accepts
  // merge/not_match/defer; legacy `escalate` rows stay readable elsewhere
  // via the backward-compatible read schema in review.ts.
  const allowedDecisions = ['merge', 'not_match', 'defer']
    .map((value) => quoteLiteral(value, dialect))
    .join(', ');
  const rankedClauses = [`${outcomeColumn} IS NULL`];
  if (decisionSource != null) {
    rankedClauses.push(`${sourceColumn} LIKE ${quoteLiteral(`${decisionSource}%`, dialect)}`);
  }

  return [
    `WITH ranked AS (`,
    `  SELECT`,
    `    ${pairIdColumn},`,
    `    ${decisionColumn},`,
    `    ${confidenceColumn},`,
    `    ${reasonColumn},`,
    `    ${sourceColumn},`,
    `    ${decidedAtColumn},`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY ${pairIdColumn}`,
    `      ORDER BY ${decidedAtColumn} DESC`,
    `    ) AS ${rowNumberColumn}`,
    `  FROM ${reviewDecisionsTable}`,
    `  WHERE ${rankedClauses.join('\n    AND ')}`,
    `)`,
    `SELECT ${pairIdColumn},`,
    `       ${decisionColumn},`,
    `       ${confidenceColumn},`,
    `       ${reasonColumn},`,
    `       ${sourceColumn},`,
    `       ${decidedAtColumn}`,
    `FROM ranked`,
    `WHERE ${rowNumberColumn} = 1`,
    `  AND ${decisionColumn} IN (${allowedDecisions})`,
    `ORDER BY ${decidedAtColumn} DESC`,
    `LIMIT ${quoteLiteral(limit, dialect)}`,
  ].join('\n');
}

function buildFeedbackUpdateQuery(
  entityName: string,
  targetSchema: string,
  dialect: SupportedDialect,
  pairId: string,
  decidedAt: string,
  outcome: HumanFeedbackOutcome,
  reason: string | null
): string {
  const reviewDecisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );
  const pairIdColumn = quoteIdentifier('pair_id', dialect);
  const decidedAtColumn = quoteIdentifier('decided_at', dialect);
  const reasonColumn = quoteIdentifier('human_feedback_reason', dialect);

  return [
    `UPDATE ${reviewDecisionsTable}`,
    `SET ${quoteIdentifier('human_feedback_outcome', dialect)} = ${quoteLiteral(outcome, dialect)},`,
    `    ${reasonColumn} = ${reason == null ? 'NULL' : quoteLiteral(reason, dialect)},`,
    `    ${quoteIdentifier('feedback_timestamp', dialect)} = CURRENT_TIMESTAMP`,
    `WHERE ${pairIdColumn} = ${quoteLiteral(pairId, dialect)}`,
    `  AND ${decidedAtColumn} = ${quoteLiteral(decidedAt, dialect)}`,
  ].join('\n');
}

function renderDecisionConfidence(value: number | null | undefined): string {
  if (value == null) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function writeInteractiveLine(value = ''): void {
  process.stderr.write(`${value}\n`);
}

function renderFeedbackCandidate(row: z.infer<typeof ReviewFeedbackRowsSchema>[number]): void {
  writeInteractiveLine(`--- Pair ${row.pair_id} ----------------------------------------`);
  writeInteractiveLine(
    `Decision:    ${row.decision}  (confidence: ${renderDecisionConfidence(row.confidence)})`
  );
  writeInteractiveLine(`Source:      ${row.decision_source ?? 'unknown'}`);
  writeInteractiveLine(`Reason:      ${row.reason?.trim() || '(none)'}`);
  writeInteractiveLine(`Decided at:  ${row.decided_at ?? 'unknown'}`);
  writeInteractiveLine('---------------------------------------------------------------');
}

interface FeedbackPromptSession {
  ask(prompt: string): Promise<string>;
  close(): void;
}

async function readPromptStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function createFeedbackPromptSession(): Promise<FeedbackPromptSession> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return {
      ask(prompt: string): Promise<string> {
        return rl.question(prompt);
      },
      close(): void {
        rl.close();
      },
    };
  }

  const scriptedInput = await readPromptStdin();
  const scriptedLines = scriptedInput.split(/\r?\n/);
  let index = 0;

  return {
    async ask(prompt: string): Promise<string> {
      process.stderr.write(prompt);
      if (index >= scriptedLines.length) {
        throw new CommandError('Not enough scripted feedback responses were provided on stdin.', 1);
      }
      return scriptedLines[index++] ?? '';
    },
    close(): void {},
  };
}

async function promptForOutcome(
  promptSession: FeedbackPromptSession
): Promise<HumanFeedbackOutcome | 'skip' | 'quit'> {
  while (true) {
    const answer = (
      await promptSession.ask(
        'Outcome? [c]orrect / [i]ncorrect / [n]eeds_revision / [s]kip / [q]uit: '
      )
    )
      .trim()
      .toLowerCase();

    if (answer === 'c' || answer === 'correct') return 'correct';
    if (answer === 'i' || answer === 'incorrect') return 'incorrect';
    if (answer === 'n' || answer === 'needs_revision') return 'needs_revision';
    if (answer === 's' || answer === 'skip') return 'skip';
    if (answer === 'q' || answer === 'quit') return 'quit';

    out.warn('Enter c, i, n, s, or q.');
  }
}

async function promptForReason(
  promptSession: FeedbackPromptSession,
  outcome: Extract<HumanFeedbackOutcome, 'incorrect' | 'needs_revision'>
): Promise<string> {
  while (true) {
    const answer = (await promptSession.ask(`Reason for ${outcome}: `)).trim();
    if (answer.length > 0) {
      return answer;
    }
    out.warn('Reason is required for incorrect and needs_revision feedback.');
  }
}

async function feedbackHandler(
  options: ReviewFeedbackOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean },
  resolveReviewTargets: ResolveReviewTargets
): Promise<void> {
  if (!options.runner) {
    throw new CommandError('--runner is required for review feedback.', 2);
  }

  const { targets, dialect } = resolveReviewTargets([options.entity], options, globalOptions);
  const target = targets[0];
  if (!target) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`);
  }

  const runner = await loadRunnerModule(options.runner);
  if (runner.query == null) {
    throw new CommandError(
      `Runner module "${options.runner}" must export query(sql) for review feedback.`,
      1
    );
  }

  const limit = options.limit ?? 10;
  const query = buildPendingFeedbackQuery(
    target.entity,
    target.schema,
    dialect,
    limit,
    options.decisionSource
  );
  const rawRows = await runner.query(query);
  const parsedRows = ReviewFeedbackRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    throw new CommandError(
      `Runner query for ${target.entity} returned invalid feedback rows: ${parsedRows.error.issues[0]?.message ?? 'schema validation failed'}`,
      1
    );
  }

  const candidates = parsedRows.data;
  const baseResult = {
    command: 'review.feedback',
    entity: target.entity,
    dialect,
    schema: target.schema,
    executed: true,
    decision_source_filter: options.decisionSource ?? null,
    limit,
    candidate_count: candidates.length,
  };

  if (candidates.length === 0) {
    if (options.json) {
      out.json({
        ...baseResult,
        recorded_count: 0,
        correct_count: 0,
        incorrect_count: 0,
        needs_revision_count: 0,
        skipped_count: 0,
        quit_early: false,
      });
      return;
    }

    out.info(`No review decisions pending feedback for ${target.entity}.`);
    return;
  }

  const promptSession = await createFeedbackPromptSession();
  let recordedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let needsRevisionCount = 0;
  let skippedCount = 0;
  let quitEarly = false;

  try {
    for (const row of candidates) {
      renderFeedbackCandidate(row);
      const outcome = await promptForOutcome(promptSession);

      if (outcome === 'skip') {
        skippedCount += 1;
        writeInteractiveLine();
        continue;
      }

      if (outcome === 'quit') {
        quitEarly = true;
        break;
      }

      const reason =
        outcome === 'incorrect' || outcome === 'needs_revision'
          ? await promptForReason(promptSession, outcome)
          : null;
      if (row.decided_at == null) {
        throw new CommandError(
          `Cannot record feedback for ${row.pair_id}: decided_at is missing on the candidate row.`,
          1
        );
      }
      const updateSql = buildFeedbackUpdateQuery(
        target.entity,
        target.schema,
        dialect,
        row.pair_id,
        row.decided_at,
        outcome,
        reason
      );

      try {
        await runner.run(updateSql);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown runner error';
        throw new CommandError(`Failed to record feedback for ${row.pair_id}: ${message}`, 1);
      }

      recordedCount += 1;
      if (outcome === 'correct') {
        correctCount += 1;
      } else if (outcome === 'incorrect') {
        incorrectCount += 1;
      } else {
        needsRevisionCount += 1;
      }

      out.success(`Feedback recorded for ${row.pair_id}`);
      writeInteractiveLine();
    }
  } finally {
    promptSession.close();
  }

  if (options.json) {
    out.json({
      ...baseResult,
      recorded_count: recordedCount,
      correct_count: correctCount,
      incorrect_count: incorrectCount,
      needs_revision_count: needsRevisionCount,
      skipped_count: skippedCount,
      quit_early: quitEarly,
    });
    return;
  }

  out.success(
    `Recorded ${recordedCount} feedback item(s)` +
      (skippedCount > 0 ? `, skipped ${skippedCount}` : '') +
      (quitEarly ? ', session stopped early' : '')
  );
}

export function registerFeedbackSubcommand(
  review: Command,
  program: Command,
  resolveReviewTargets: ResolveReviewTargets
): void {
  review
    .command('feedback')
    .description('Interactively annotate agent or human review decisions with human feedback')
    .requiredOption('--entity <name>', 'Entity name for the resolution')
    .addOption(
      new Option('--decision-source <value>', 'Filter decisions by source prefix').choices([
        'agent',
        'human',
      ])
    )
    .addOption(
      new Option('--limit <n>', 'Maximum number of decisions to review').argParser(
        parsePositiveIntOption
      )
    )
    .option('--json', 'Output final session results as JSON to stdout')
    .requiredOption('--runner <path>', 'Path to SQL runner module with run(sql) and query(sql)')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ReviewFeedbackOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await feedbackHandler(opts, globalOptions, resolveReviewTargets);
    });
}
