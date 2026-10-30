import { AgenticRunSnapshotSchema } from '../../src/agentic/state.js';

/** Counts complete snapshot validations. Nested schema checks are not counted. */
export function countSnapshotValidations(counters: { validations: number }): () => void {
  const schema = AgenticRunSnapshotSchema as unknown as Record<
    'parse' | 'safeParse',
    (...args: unknown[]) => unknown
  >;
  const original = { parse: schema.parse, safeParse: schema.safeParse };
  for (const name of ['parse', 'safeParse'] as const) {
    schema[name] = (...args: unknown[]) => {
      counters.validations++;
      return original[name](...args);
    };
  }
  return () => Object.assign(schema, original);
}
