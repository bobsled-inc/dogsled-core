import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';
import { AgenticStateError } from './state-errors.js';

/** Safe identifiers and the executor's structured failure; never provider text. */
export interface AgenticAssignmentFailure {
  step_id: string;
  shard_id: string;
  attempts: number;
  max_attempts: number;
  kind?: string;
  code?: string;
  retryable?: boolean;
  /** Bobsled Core-generated validation summary of the last result; field names only. */
  detail?: string;
}

/** An assignment could not finish. Its saved outcome holds the same structured error. */
export class AgenticAssignmentError extends Error {
  constructor(readonly failure: AgenticAssignmentFailure) {
    const cause =
      failure.kind && failure.code ? ` with ${failure.kind} error "${failure.code}"` : '';
    const attempts = `${failure.attempts} of ${failure.max_attempts} attempt${failure.max_attempts === 1 ? '' : 's'}`;
    const hint =
      failure.code === 'source_access_denied'
        ? 'The executor kept requesting a source or operation this step does not allow. Check the step context_sources and the executor tool definitions, then resume with --agent-resume --agent-retry-failed.'
        : failure.code === 'turn_limit'
          ? 'The agent loop used all its turns without finishing. Raise the loop executor turn limit (the reference loop executor allows 16 through its maxTurns option) or narrow the step instructions, then resume with --agent-resume --agent-retry-failed.'
          : failure.kind === 'auth'
            ? 'The provider rejected the credentials for this model profile. Check the API key named in platform.models, then resume with --agent-resume --agent-retry-failed.'
            : failure.attempts >= failure.max_attempts
              ? failure.code === 'rate_limited'
                ? 'The provider kept rate-limiting the calls. Lower --agent-concurrency or raise --agent-min-dispatch-interval-ms, then start a new run ID.'
                : 'All attempts are used up. Fix the cause, then start a new run ID.'
              : 'The executor marked this failure as not retryable. Fix the cause, then resume with --agent-resume --agent-retry-failed.';
    const detail = failure.detail ? ` Last result: ${failure.detail}.` : '';
    super(
      `Agentic step "${failure.step_id}" assignment ${failure.shard_id} failed${cause} after ${attempts}.${detail} ${hint}`
    );
    this.name = 'AgenticAssignmentError';
  }
}

/**
 * A host callback failed. The cause is attached but may contain provider text or
 * credentials, so formatting shows only its type and numeric status.
 */
export class AgenticHostError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'AgenticHostError';
  }
}

function isSafe(error: unknown): error is Error {
  return (
    error instanceof AgenticStateError ||
    error instanceof AgenticAssignmentError ||
    error instanceof AgenticHostError ||
    error instanceof CommandError
  );
}

/** Type name and HTTP-like status are safe to show; messages from unknown errors are not. */
function describeHidden(error: unknown): string {
  if (!(error instanceof Error)) return 'a non-error value';
  const record = error as unknown as Record<string, unknown>;
  const status = [record['statusCode'], record['status']].find(
    (value): value is number => typeof value === 'number' && Number.isInteger(value)
  );
  // System codes such as EACCES or ENOSPC name the problem without exposing paths or text.
  const code =
    typeof record['code'] === 'string' && /^E[A-Z0-9_]{1,31}$/.test(record['code'])
      ? record['code']
      : undefined;
  const name = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const facts = [code, status === undefined ? undefined : `status ${status}`].filter(Boolean);
  return `${name}${facts.length ? ` (${facts.join(', ')})` : ''}; details hidden because they may contain secrets`;
}

/**
 * Render an agentic failure with every safe cause in its chain. Unknown causes appear
 * by type only, so provider messages and credentials are never printed.
 */
export function formatAgenticError(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 8; depth++) {
    if (depth === 0) {
      // Validation of host data can quote that data; summarize it by field instead.
      lines.push(
        current instanceof z.ZodError
          ? `Agentic data failed validation: ${describeZodIssues(current)}.`
          : current instanceof Error
            ? current.message
            : String(current)
      );
    } else {
      lines.push(`  caused by: ${isSafe(current) ? current.message : describeHidden(current)}`);
    }
    if (!(current instanceof Error) || (depth > 0 && !isSafe(current))) break;
    current = current.cause;
  }
  return lines.join('\n');
}

/** Zod issues can quote keys and values from host or executor data; keep field names only. */
export function describeZodIssues(error: unknown): string {
  if (!(error instanceof z.ZodError)) return 'the data could not be validated';
  const segment = (part: PropertyKey) =>
    typeof part === 'number' || /^[A-Za-z0-9_]{1,64}$/.test(String(part)) ? String(part) : '*';
  const issues = error.issues.slice(0, 5).map((issue) => {
    const message = issue.message.replace(/(["'`]).*?\1/g, '<value>').slice(0, 160);
    return `${issue.path.map(segment).join('.') || 'value'}: ${message}`;
  });
  const more = error.issues.length > 5 ? `; and ${error.issues.length - 5} more` : '';
  return `${issues.join('; ')}${more}`;
}
