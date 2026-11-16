import { agenticMetadataRole, isAgenticMetadataName } from './metadata-names.js';

/**
 * Renames metadata columns of an existing agentic target that an earlier Core
 * generation created (an earlier spelling listed in legacy-names.ts),
 * position by position, so the strict schema check that
 * follows sees the current names. Only a column whose current name is a
 * metadata column of the same role is renamed; anything else is left for the
 * schema check to report. A target with both an earlier and the current column of one role
 * stops with an error naming them. `columns` is updated in place.
 */
export async function renameLegacyMetadataColumns(
  columns: Record<string, unknown>[],
  expected: readonly { name: string }[],
  fold: (name: string) => string,
  rename: (from: string, to: string) => Promise<unknown>,
  table: string
): Promise<void> {
  // Both generations of one metadata column: Core cannot know which holds the data, so it stops
  // rather than merge or drop either.
  const byRole = new Map<string, string[]>();
  for (const column of columns) {
    const name = String(column['column_name']);
    const role = agenticMetadataRole(name);
    if (role) byRole.set(role, [...(byRole.get(role) ?? []), name]);
  }
  for (const names of byRole.values()) {
    if (names.length > 1) {
      throw new Error(
        `Agentic target ${table} has both ${names.map((name) => `\`${name}\``).join(' and ')}; keep the one with your data and drop the other.`
      );
    }
  }
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
        `Agentic target ${table} has the earlier metadata column ${actual}, and renaming it to ${name} failed. ` +
          'If another run renamed it at the same time, run again. On Databricks (Delta), enable column ' +
          "mapping first (ALTER TABLE … SET TBLPROPERTIES ('delta.columnMapping.mode' = 'name')). " +
          'Otherwise rename the column by hand or rebuild the target.',
        { cause: error }
      );
    }
    column['column_name'] = name;
  }
}
