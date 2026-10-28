/**
 * YAML and text file reading utilities.
 *
 * Extracted subset of the Dogsled CLI reader — only the generic
 * file reading helpers needed by the compiler.
 */

import * as fs from 'node:fs';

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface ReadSuccess<T> {
  ok: true;
  data: T;
}

interface ReadFailure {
  ok: false;
  error: string;
}

type ReadResult<T> = ReadSuccess<T> | ReadFailure;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readTextFile(filePath: string): ReadResult<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, data: content };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `File not found: ${filePath}` };
    }
    return {
      ok: false,
      error: `Cannot read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function readYamlFileWithContent(
  filePath: string
): ReadResult<{ data: unknown; content: string }> {
  const textResult = readTextFile(filePath);
  if (!textResult.ok) return textResult;

  try {
    const data: unknown = YAML.parse(textResult.data);
    return { ok: true, data: { data, content: textResult.data } };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function readYamlFile(filePath: string): ReadResult<unknown> {
  const result = readYamlFileWithContent(filePath);
  if (!result.ok) return result;
  return { ok: true, data: result.data.data };
}
