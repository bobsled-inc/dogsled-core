export type Cell = string | number | boolean | null;
export interface Table {
  name: string;
  columns: string[];
  rows: Record<string, Cell>[];
  totalRows: number;
}
export interface Chapter {
  id: string;
  label: string;
  status: 'not_started' | 'running' | 'needs_input' | 'complete' | 'failed' | 'stale';
  evidence?: { tables: Table[]; receipts: string[]; at: string; mode: string };
}
export interface Snapshot {
  question?: string;
  preferences?: string;
  renderedAt: string;
  state: { datasetVersion: string; steps: Chapter[] };
  progress?: { current: string; reviewed: string[] };
  tables: Table[];
  files?: { path: string; content: string; language: string }[];
  lineage?: {
    nodes: { id: string; label: string; kind: string; description: string; available: boolean }[];
    edges: { from: string; to: string }[];
  };
}
