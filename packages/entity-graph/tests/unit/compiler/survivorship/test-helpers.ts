import * as path from 'node:path';

import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../../../../src/compiler/survivorship/parser.js';

const FIXTURE_ENTITY_GRAPH_DIR = path.resolve(
  import.meta.dirname,
  '../../../fixtures/specs/resolutions'
);

export function loadResolvedSurvivorshipFixture(name: string, schema = 'PUBLIC') {
  const parsed = discoverSurvivorshipSpecs(FIXTURE_ENTITY_GRAPH_DIR).find(
    (spec) => spec.name === name
  );

  if (!parsed) {
    throw new Error(`Expected ${name} fixture to exist`);
  }

  return resolveSurvivorshipSpec(parsed, FIXTURE_ENTITY_GRAPH_DIR, schema);
}
