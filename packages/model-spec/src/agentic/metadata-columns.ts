import { agenticMetadataRole, isAgenticMetadataName } from './metadata-names.js';

/**
 * Renames metadata columns of an existing agentic target that an earlier Core
 * generation created (for example `_dogsled_reason` once Core writes
 * `_bobsled_reason`), position by position, so the strict schema check that
 * follows sees the current names. Only a column whose current name is a
 * metadata column of the same role is renamed; anything else is left for the
 * schema check to report. `columns` is updated in place.
 */
export async function renameLegacyMetadataColumns(
  columns: Record<string, unknown>[],
  expected: readonly { name: string }[],
  fold: (name: string) => string,
  rename: (from: string, to: string) => Promise<unknown>,
  table: string
): Promise<void> {
  for (const [index, column] of columns.entries()) {
    const wanted = expected[index];
    const actual = String(column['column_name']);
    if (!wanted || !isAgenticMetadataName(wanted.name)) continue;
    const name = fold(wanted.name);
    if (actual === name || agenticMetadataRole(actual) !== agenticMetadataRole(wanted.name)) {
      continue;
    }
    try {
      await rename(actual, name);
    } catch (error) {
      throw new Error(
        `Agentic target ${table} has the earlier metadata column ${actual}, and the warehouse refused to rename it to ${name}. Rename it by hand, or rebuild the target.`,
        { cause: error }
      );
    }
    column['column_name'] = name;
  }
}
