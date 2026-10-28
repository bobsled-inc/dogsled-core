import type { ClaudeFailureCode } from '@/lib/claude-failure';
import { classifyClaudeFailure, runClaudeStreamJson } from '@/lib/claude-process';

export interface ClaudeJsonOptions {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTurns?: number;
}

export class ClaudeJsonRequestError extends Error {
  readonly code: ClaudeFailureCode;
  readonly hint?: string;
  readonly rawText?: string;

  constructor(
    message: string,
    options: { code: ClaudeFailureCode; hint?: string; rawText?: string }
  ) {
    super(message);
    this.name = 'ClaudeJsonRequestError';
    this.code = options.code;
    this.hint = options.hint;
    this.rawText = options.rawText;
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function candidateJsonSlices(text: string): string[] {
  const trimmed = stripJsonFence(text);
  const candidates = [trimmed];
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

export function parseJsonFromClaudeText(text: string): unknown {
  for (const candidate of candidateJsonSlices(text)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next plausible JSON slice.
    }
  }
  throw new SyntaxError('Claude did not return parseable JSON.');
}

export async function requestClaudeJson(options: ClaudeJsonOptions): Promise<unknown> {
  const { systemPrompt, userPrompt, signal, timeoutMs = 120_000, maxTurns = 1 } = options;

  const chunks: string[] = [];
  const result = await runClaudeStreamJson({
    systemPrompt,
    userPrompt,
    signal,
    timeoutMs,
    maxTurns,
    onText: (text) => chunks.push(text),
  });

  const fail = (message: string, rawText?: string): never => {
    const failure = classifyClaudeFailure(message, { timedOut: result.timedOut });
    throw new ClaudeJsonRequestError(failure.message, { ...failure, rawText });
  };

  if (result.error) {
    fail(String(result.error));
  }
  if (result.code == null) {
    fail(`Claude process terminated by signal ${result.signalName ?? 'unknown'}`);
  }
  if (result.code !== 0) {
    fail(result.stderr || `Claude CLI exited with code ${result.code}`);
  }

  const rawText = chunks.join('').trim();
  try {
    return parseJsonFromClaudeText(rawText);
  } catch {
    throw new ClaudeJsonRequestError('Claude returned an invalid JSON response.', {
      code: 'runtime',
      hint: 'Retry once. If it keeps failing, inspect the local Claude CLI output.',
      rawText,
    });
  }
}
