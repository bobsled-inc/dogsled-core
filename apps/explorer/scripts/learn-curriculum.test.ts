import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTITY_GRAPH_TABLE_ATLAS,
  LEARN_MODULE_GROUPS,
  LEARN_MODULES,
  getCliPhaseCoverage,
  getLearnModuleById,
  isEntityGraphTableSuffix,
  type LearnStepKind,
} from '../src/lib/learn-curriculum';
import { validateCommand } from '../src/lib/bobsled-cli';

const VALID_STEP_KINDS = new Set<LearnStepKind>([
  'concept',
  'surface',
  'command',
  'query',
  'table',
  'spec',
  'check',
]);

test('Learn curriculum has unique modules, routes, and non-empty lessons', () => {
  const moduleIds = new Set<string>();
  const groupIds = new Set(LEARN_MODULE_GROUPS.map((group) => group.id));

  for (const module of LEARN_MODULES) {
    assert.ok(!moduleIds.has(module.id), `Duplicate module id: ${module.id}`);
    moduleIds.add(module.id);
    assert.match(module.id, /^[a-z0-9-]+$/);
    assert.ok(groupIds.has(module.group), `Unknown group for ${module.id}`);
    assert.ok(module.steps.length > 0, `${module.id} has no steps`);
    assert.ok(getLearnModuleById(module.id), `${module.id} can be looked up by route id`);

    const stepIds = new Set<string>();
    for (const step of module.steps) {
      assert.ok(!stepIds.has(step.id), `Duplicate step id ${module.id}/${step.id}`);
      stepIds.add(step.id);
      assert.ok(VALID_STEP_KINDS.has(step.kind), `Invalid step kind ${step.kind}`);
      assert.ok(step.title.trim().length > 0, `${module.id}/${step.id} has empty title`);
      assert.ok(step.body.trim().length > 0, `${module.id}/${step.id} has empty body`);
      if (step.action?.href.startsWith('/learn/')) {
        const routeId = step.action.href.replace('/learn/', '').split('?')[0];
        assert.ok(routeId);
        assert.ok(getLearnModuleById(routeId), `Invalid learn route ${step.action.href}`);
      }
      if (step.command) {
        assert.ok(
          validateCommand(step.command.command),
          `${module.id}/${step.id} uses disallowed command ${step.command.command}`
        );
      }
    }
  }
});

test('Learn curriculum covers each planned module group and CLI phases', () => {
  for (const group of LEARN_MODULE_GROUPS) {
    assert.ok(
      LEARN_MODULES.some((module) => module.group === group.id),
      `No module for group ${group.id}`
    );
  }

  const coverage = getCliPhaseCoverage();
  assert.ok(coverage.includes('unified-ingest'));
  assert.ok(coverage.includes('entity-graph-sdk'));
  assert.ok(coverage.includes('entity-graph-survivorship'));
  assert.ok(coverage.includes('mcp-client'));
  assert.ok(coverage.includes('warehouse-destinations'));
});

test('Learn curriculum includes unified-ingest first-ingest lessons without unsafe terminal claims', () => {
  const module = getLearnModuleById('unified-ingest');
  assert.ok(module);
  assert.equal(module.group, 'advanced-elt');

  const cliLessonIds = module.steps.map((step) => step.cliLessonId).filter(Boolean);
  assert.ok(cliLessonIds.includes('first-ingest-unified-grammar'));
  assert.ok(cliLessonIds.includes('first-ingest-document-streams'));
  assert.ok(cliLessonIds.includes('first-ingest-chunk-ids'));
  assert.ok(cliLessonIds.includes('first-ingest-acl-evidence'));
  assert.ok(cliLessonIds.includes('first-ingest-side-by-side'));
  assert.ok(cliLessonIds.includes('first-ingest-local-querying'));

  const terminalHrefs = module.steps
    .map((step) => step.action?.href)
    .filter((href): href is string => typeof href === 'string' && href.startsWith('/terminal'));
  assert.ok(terminalHrefs.length > 0);
  assert.ok(
    terminalHrefs.every((href) => !href.includes('walkthrough')),
    'Explorer Terminal must not claim it can run the cwd-dependent piped walkthrough'
  );
  assert.ok(
    module.steps.every((step) => {
      const commandText = step.command
        ? `${step.command.command} ${step.command.args.join(' ')}`
        : '';
      return !commandText.includes('walkthrough');
    }),
    'Unified-ingest Explorer commands must stay limited to safe Terminal-compatible commands'
  );
});

test('Learn curriculum distinguishes mention extraction thresholds from review labels', () => {
  const module = getLearnModuleById('entity-graph-sdk');
  assert.ok(module);

  const mentionStep = module.steps.find((step) => step.id === 'entity-graph-mention-extraction');
  assert.ok(mentionStep);
  assert.match(mentionStep.body, /> 0\.95/);
  assert.match(mentionStep.body, /0\.85-0\.95/);
  assert.match(mentionStep.body, /Review export labels are separate/);
  assert.match(mentionStep.body, />= 0\.92 auto-merge/);
  assert.match(mentionStep.body, />= 0\.75 agent-applied/);

  const relationshipStep = module.steps.find(
    (step) => step.id === 'entity-graph-relationship-extraction'
  );
  assert.ok(relationshipStep);
  assert.match(relationshipStep.body, /relationships review export\/apply/);
  assert.match(relationshipStep.body, /__entity_relationship_decisions/);
});

test('Entity Graph table atlas includes deep output tables and validates suffixes', () => {
  const suffixes = ENTITY_GRAPH_TABLE_ATLAS.map((entry) => entry.suffix);
  assert.ok(suffixes.includes('__components'));
  assert.ok(suffixes.includes('__entity_id_current'));
  assert.ok(suffixes.includes('__entity_id_events'));
  assert.ok(suffixes.includes('__golden_history'));
  assert.ok(suffixes.includes('__relationships'));
  assert.ok(suffixes.includes('__survivorship_audit'));
  assert.ok(suffixes.includes('__lineage'));
  assert.ok(suffixes.includes('__object_metadata'));
  assert.equal(new Set(suffixes).size, suffixes.length);
  assert.equal(isEntityGraphTableSuffix('__components'), true);
  assert.equal(isEntityGraphTableSuffix('__not_allowed'), false);
});
