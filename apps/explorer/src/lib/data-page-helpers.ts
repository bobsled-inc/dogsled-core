export interface HistoryEntry {
  sql: string;
  dbPath?: string;
  dbKey?: string;
  scenario?: string;
  entity?: string;
  timestamp: number;
  rowCount?: number;
}

export function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HistoryEntry>;
  if (typeof candidate.sql !== 'string') return false;
  if (typeof candidate.timestamp !== 'number') return false;
  if (candidate.dbPath !== undefined && typeof candidate.dbPath !== 'string') return false;
  if (candidate.dbKey !== undefined && typeof candidate.dbKey !== 'string') return false;
  if (candidate.scenario !== undefined && typeof candidate.scenario !== 'string') return false;
  if (candidate.entity !== undefined && typeof candidate.entity !== 'string') return false;
  if (candidate.rowCount !== undefined && typeof candidate.rowCount !== 'number') return false;
  return true;
}

export function loadHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => (isHistoryEntry(item) ? [item] : []));
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function inferColumnType(rows: Record<string, unknown>[], column: string): string {
  const values = rows.map((row) => row[column]).filter((value) => value !== undefined);
  if (values.length === 0 || values.every((value) => value === null)) return 'null';
  const nonNull = values.filter((value) => value !== null);
  if (nonNull.every((value) => typeof value === 'boolean')) return 'boolean';
  if (nonNull.every((value) => typeof value === 'number')) return 'number';
  return 'string';
}
