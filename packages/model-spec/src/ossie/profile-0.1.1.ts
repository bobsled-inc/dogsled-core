import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import { CommandError } from '../errors.js';
import upstreamSchema from './upstream-schema-0.1.1.json' with { type: 'json' };
import { OssieSemanticModelSchema, type ParsedOssieDocument } from './profile-types.js';

export const OSSIE_0_1_1_REVISION = 'faf581054dcf7964d5fe0ceae7d6f415c8ce32a5';
const validate = new Ajv2020({ strict: false, allErrors: false }).compile(upstreamSchema);
const documentSchema = z.object({
  version: z.literal('0.1.1'),
  semantic_model: z.array(OssieSemanticModelSchema),
});

export function readOssie011(document: unknown, path: string): ParsedOssieDocument {
  if (!validate(document)) {
    const error = validate.errors?.[0];
    throw new CommandError(
      `${path}: Invalid Ossie document (0.1.1, schema ${OSSIE_0_1_1_REVISION}): ${error?.instancePath || '/'} ${error?.message ?? 'schema validation failed'}`,
      2
    );
  }
  return { profile: '0.1.1', semanticModels: documentSchema.parse(document).semantic_model };
}
