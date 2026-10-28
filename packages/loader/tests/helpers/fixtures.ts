import type { SchemaColumn } from '@bobsled-inc/protocol';

export const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

export function makeIssueRecord(
  id: number,
  title: string,
  timeExtracted: string
): Record<string, unknown> {
  return {
    id,
    title,
    _time_extracted: timeExtracted,
  };
}
