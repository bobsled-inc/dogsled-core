import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
import { z } from 'zod';

import { SpecNameSchema } from '../core/index.js';

export const IntegrationSpecBase = {
  spec_version: z.literal('1'),
  type: z.literal('integration'),
  auth_env_vars: AuthEnvVarsSchema,
  name: SpecNameSchema,
  description: z.string().optional(),
} as const;
