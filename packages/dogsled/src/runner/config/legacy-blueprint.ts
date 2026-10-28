import {
  CommandError,
  LegacyBlueprintKeyConflictError,
  REJECTED_LEGACY_DESTINATION_TYPES,
  formatLegacyBlueprintDeprecation,
  normalizeLegacyBlueprintKeys,
} from '@bobsled-inc/protocol';
import type { ProjectIndex } from '@bobsled-inc/project-index';
import { z } from 'zod';

export function normalizeDestinationBlueprint(input: unknown, ctx: z.RefinementCtx): unknown {
  try {
    const { document } = normalizeLegacyBlueprintKeys(input, { kind: 'destination' });
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      const type = (document as Record<string, unknown>)['type'];
      if (typeof type === 'string' && Object.hasOwn(REJECTED_LEGACY_DESTINATION_TYPES, type)) {
        ctx.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'This destination type is retired; use dogsled_managed.',
        });
        return z.NEVER;
      }
    }
    return document;
  } catch (error) {
    if (!(error instanceof LegacyBlueprintKeyConflictError)) throw error;
    ctx.addIssue({ code: 'custom', message: error.message, params: { code: error.code } });
    return z.NEVER;
  }
}

export function normalizePipelineBlueprint(document: unknown, path: string): unknown {
  try {
    return normalizeLegacyBlueprintKeys(document, { path, kind: 'pipeline_config' }).document;
  } catch (error) {
    if (!(error instanceof LegacyBlueprintKeyConflictError)) throw error;
    throw Object.assign(new CommandError(error.message, 2), { code: error.code });
  }
}

export function legacyBlueprintWarnings(index: ProjectIndex): string[] {
  return (index.deprecations ?? []).map(formatLegacyBlueprintDeprecation);
}
