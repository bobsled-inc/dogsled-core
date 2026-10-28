import * as fs from 'node:fs';

import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../compiler/survivorship/parser.js';

import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../compiler/survivorship/types.js';

type ColocatedResolutionSpec = Pick<ResolvedResolutionSpec, 'entity' | 'name' | 'targetSchema'>;

export function discoverColocatedSurvivorshipSpec(
  spec: ColocatedResolutionSpec,
  targetSchema: string,
  entityGraphDir: string
): ResolvedSurvivorshipSpec | undefined {
  if (!fs.existsSync(entityGraphDir)) {
    return undefined;
  }

  return discoverSurvivorshipSpecs(entityGraphDir)
    .map((candidate) =>
      resolveSurvivorshipSpec(candidate, entityGraphDir, spec.targetSchema ?? targetSchema)
    )
    .find(
      (candidate) =>
        candidate.entity === spec.entity ||
        candidate.resolutionEntity === spec.entity ||
        candidate.resolutionRef === spec.name
    );
}
