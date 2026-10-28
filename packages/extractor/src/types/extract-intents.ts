import type { z } from 'zod';

import type { ExtractIntentsSchema } from '../schemas/extract-intents.js';

export type ExtractIntentsManifest = z.infer<typeof ExtractIntentsSchema>;
export type ExtractIntentPlan = ExtractIntentsManifest['plans'][string];
export type ExtractIntentStep = ExtractIntentPlan['steps'][number];
export type ExtractIntentSeed = ExtractIntentPlan['seeds'][string];
