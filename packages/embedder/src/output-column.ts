export function outputColumnName(field: string, alias?: string): string {
  return alias ?? `${field}_embedding`;
}
