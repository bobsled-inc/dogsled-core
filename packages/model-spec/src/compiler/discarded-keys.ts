import { SourceSpecSchema, TransformSpecSchema } from './schemas.js';

/**
 * Lists keys present in `input` but missing from the schema's parsed `output`. Most
 * source and model schemas strip unknown keys instead of rejecting them, so a misspelled
 * or unsupported key is otherwise ignored without notice.
 */
export function discardedKeyPaths(input: unknown, output: unknown, path = ''): string[] {
  if (!input || typeof input !== 'object' || !output || typeof output !== 'object') return [];
  const paths: string[] = [];
  for (const key of Object.keys(input)) {
    const keyPath = Array.isArray(input) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    if (!Object.hasOwn(output, key)) {
      paths.push(keyPath);
      continue;
    }
    paths.push(...discardedKeyPaths(Reflect.get(input, key), Reflect.get(output, key), keyPath));
  }
  return paths;
}

/**
 * Warnings for keys a source or SQL model file declares that its schema ignores. Agentic
 * models are skipped because their schema already rejects unknown keys, and invalid
 * documents are skipped because validation reports them as errors.
 */
export function ignoredKeyWarnings(
  kind: 'source' | 'model',
  document: unknown,
  filePath: string
): string[] {
  if (kind === 'model' && Reflect.get(Object(document), 'model_kind') === 'agentic') return [];
  const parsed = (kind === 'source' ? SourceSpecSchema : TransformSpecSchema).safeParse(document);
  if (!parsed.success) return [];
  return discardedKeyPaths(document, parsed.data).map(
    (keyPath) =>
      `${filePath}: ignored unknown key ${keyPath}. Remove it or move it to a supported property.`
  );
}
