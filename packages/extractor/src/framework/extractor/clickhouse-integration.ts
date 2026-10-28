import { z } from 'zod';

import {
  ClickHouseAuthSchema,
  ClickHouseConnectionSchema,
  ClickHouseSslConfigSchema,
} from '../core/index.js';
import { IntegrationSpecBase } from './integration-base.js';

export const ClickHouseIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('clickhouse'),
    connection: ClickHouseConnectionSchema,
    auth: ClickHouseAuthSchema,
    ssl: ClickHouseSslConfigSchema.optional(),
  })
  .strict();

export type ClickHouseIntegrationSpec = z.infer<typeof ClickHouseIntegrationSpecSchema>;
