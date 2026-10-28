import { InterchangeSchema } from './storage.js';
import { assertBounded, record } from './common.js';

/** Explicitly attach preserved metadata after a caller has renamed a native field.
 * This changes ownership only: callers still reconcile grain and semantic references.
 */
export function rebindOssieFieldMetadata(
  document: unknown,
  oldName: string,
  newName: string
): Record<string, unknown> {
  assertBounded(document);
  const native = structuredClone(record(document));
  const interchange = InterchangeSchema.parse(native['interchange']);
  const storage = interchange.ossie;
  const fields = storage.fields ?? [];
  const matches = fields.filter((field) => field.field === oldName);
  if (matches.length !== 1 || fields.some((field) => field.field === newName)) {
    throw new Error('Expected one old field owner and an unused new field owner');
  }
  const columns =
    native['type'] === 'source' ? record(native['schema'])['columns'] : native['columns'];
  if (
    !Array.isArray(columns) ||
    !columns.some((c) => record(c)['name'] === newName) ||
    columns.some((c) => record(c)['name'] === oldName)
  ) {
    throw new Error('Rename the native field before rebinding its metadata');
  }
  const owner = matches[0];
  if (!owner) throw new Error('Missing field owner');
  owner.field = newName;
  native['interchange'] = interchange;
  return native;
}
