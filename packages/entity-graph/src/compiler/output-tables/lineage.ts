import type { OutputTableDef } from './index.js';

export const LINEAGE_OUTPUT_TABLE: OutputTableDef = {
  suffix: 'lineage',
  stage: 'lineage',
  ddlStrategy: 'create_if_not_exists',
  columns: [
    { name: 'entity_type', type: 'STRING' },
    { name: 'entity_id', type: 'STRING', nullable: true },
    { name: 'attribute', type: 'STRING' },
    { name: 'profile_table', type: 'STRING' },
    { name: 'profile_column', type: 'STRING' },
    { name: 'source_system', type: 'STRING', nullable: true },
    { name: 'source_table', type: 'STRING' },
    { name: 'source_column', type: 'STRING' },
    { name: 'field_path', type: 'STRING', nullable: true },
    { name: 'transform_ref', type: 'STRING', nullable: true },
    { name: 'transform_step', type: 'STRING', nullable: true },
    { name: 'is_complete', type: 'BOOLEAN' },
    { name: 'loaded_at', type: 'TIMESTAMP' },
  ],
};
