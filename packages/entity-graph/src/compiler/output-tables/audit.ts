import type { OutputTableDef } from './index.js';

export const AUDIT_OUTPUT_TABLES = [
  {
    suffix: 'audit_log',
    stage: 'audit',
    ddlStrategy: 'create_if_not_exists',
    columns: [
      { name: 'event_id', type: 'STRING' },
      { name: 'category', type: 'STRING' },
      { name: 'subject_type', type: 'STRING' },
      { name: 'subject_id', type: 'STRING' },
      { name: 'cluster_id', type: 'STRING', nullable: true },
      { name: 'edge_id', type: 'STRING', nullable: true },
      { name: 'payload', type: 'JSON' },
      { name: 'reason', type: 'STRING', nullable: true },
      { name: 'actor', type: 'STRING' },
      { name: 'actor_type', type: 'STRING' },
      { name: 'occurred_at', type: 'TIMESTAMP' },
    ],
  },
] as const satisfies readonly OutputTableDef[];
