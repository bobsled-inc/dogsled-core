import { validateOssieDocument } from './schema.js';
import { OssieSemanticModelSchema, type ParsedOssieDocument } from './profile-types.js';

export function readOssie020Dev0(document: unknown, path: string): ParsedOssieDocument {
  const validated = validateOssieDocument(document, path);
  return {
    profile: '0.2.0.dev0',
    semanticModels: [OssieSemanticModelSchema.parse(validated)],
  };
}
