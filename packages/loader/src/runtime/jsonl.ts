import { createReadStream } from 'node:fs';

/**
 * Read object records from a JSONL file without retaining the whole file in memory.
 *
 * Empty lines are ignored. Each non-empty line must contain a JSON object so
 * destinations can process records in bounded write batches.
 */
export async function* readJsonlRecords(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  let remainder = '';
  let lineNumber = 0;

  try {
    for await (const chunk of input) {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newlineIndex = remainder.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = remainder.slice(0, newlineIndex).replace(/\r$/, '');
        remainder = remainder.slice(newlineIndex + 1);
        lineNumber += 1;
        if (line.trim() !== '') {
          yield parseJsonlRecord(line, lineNumber);
        }
        newlineIndex = remainder.indexOf('\n');
      }
    }

    const finalLine = remainder.replace(/\r$/, '');
    if (finalLine.trim() !== '') {
      lineNumber += 1;
      yield parseJsonlRecord(finalLine, lineNumber);
    }
  } finally {
    input.destroy();
  }
}

function parseJsonlRecord(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON on JSONL line ${lineNumber}: ${message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON record on JSONL line ${lineNumber}: expected object`);
  }

  return parsed as Record<string, unknown>;
}
