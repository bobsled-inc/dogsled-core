import { ZodError } from 'zod';

import { CommandError } from '@bobsled-inc/protocol';
import { createLogger } from '../runtime/logger.js';

function formatZodError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => {
        const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      })
      .join('\n');
  }

  return error instanceof Error ? error.message : String(error);
}

/** Render a command failure once, preserving JSONL framing for machine callers. */
export function handleRunError(error: unknown, logFormat: 'text' | 'json' = 'text'): void {
  const message = formatZodError(error);
  const exitCode =
    error instanceof CommandError ? error.exitCode : error instanceof ZodError ? 2 : 1;
  if (logFormat === 'json') {
    createLogger(process.stderr, 'json').error(message);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = exitCode;
}
