import { z } from 'zod';

import { RateLimitConfigSchema, RetryConfigSchema } from './integration.js';

export const TransportPolicySchema = z
  .object({
    rate_limit: RateLimitConfigSchema.optional(),
    retry: RetryConfigSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export type TransportPolicy = z.infer<typeof TransportPolicySchema>;
