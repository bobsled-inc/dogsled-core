export type ClaudeFailureCode = 'unavailable' | 'timeout' | 'auth' | 'runtime';

export function isClaudeFailureCode(v: unknown): v is ClaudeFailureCode {
  return v === 'unavailable' || v === 'timeout' || v === 'auth' || v === 'runtime';
}

export type ClaudeStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; code?: number }
  | { type: 'error'; message: string; code: ClaudeFailureCode; hint?: string };
