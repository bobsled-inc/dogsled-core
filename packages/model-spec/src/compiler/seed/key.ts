/** Build a stable composite key for seed uniqueness and diff comparisons. */
export function buildSeedKey(
  row: Record<string, string | null | undefined>,
  uniqueColumns: string[]
): string {
  return JSON.stringify(uniqueColumns.map((column) => [column.toLowerCase(), row[column] ?? null]));
}
