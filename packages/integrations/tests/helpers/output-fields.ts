/** Extract output field names from a raw resource spec object. */
export function getOutputFieldNames(resource: Record<string, unknown>): Set<string> | null {
  const output = resource['output'] as Record<string, unknown> | undefined;
  if (!output || Array.isArray(output)) {
    return null;
  }

  const fields = output['fields'];
  if (Array.isArray(fields)) {
    return new Set(fields.map((field) => String((field as Record<string, unknown>)['name'])));
  }

  return new Set(Object.keys(output));
}
