import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

const CursorPayloadSchema = z.object({ offset: z.number().int().nonnegative() });

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorPayload {
  if (cursor === undefined || cursor.length === 0) return { offset: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new CommandError('Invalid cursor. Use the next_cursor returned by the previous page.', 2);
  }
  const result = CursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new CommandError('Invalid cursor payload. Use entity_search/list results to restart.', 2);
  }
  return result.data;
}

export function pageLimit(limit: number | undefined, max = 100): number {
  const resolved = limit ?? 25;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new CommandError(`limit must be an integer between 1 and ${max}.`, 2);
  }
  return resolved;
}
