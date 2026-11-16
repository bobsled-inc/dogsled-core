import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LearnModuleCard } from '../src/components/learn/learn-module-card';
import { LearnStepPanel } from '../src/components/learn/learn-step-panel';
import { getLearnModuleById } from '../src/lib/learn-curriculum';

test('LearnModuleCard renders module progress and route', () => {
  const module = getLearnModuleById('foundations');
  assert.ok(module);

  const html = renderToStaticMarkup(
    <LearnModuleCard module={module} completedCount={1} percent={25} isComplete={false} />
  );

  assert.match(html, /Bobsled Core Foundations/);
  assert.match(html, /1\/4 complete/);
  assert.match(html, /href="\/learn\/foundations"/);
});

test('LearnStepPanel renders table atlas context for table steps', () => {
  const module = getLearnModuleById('entity-graph-deep-dive');
  assert.ok(module);
  const step = module.steps.find((entry) => entry.id === 'inspect-review-queue');
  assert.ok(step);

  const html = renderToStaticMarkup(
    <LearnStepPanel
      module={module}
      step={step}
      nextStep={null}
      completed={false}
      onComplete={() => undefined}
      onNext={() => undefined}
    />
  );

  assert.match(html, /Inspect the review queue/);
  assert.match(html, /Entity Graph table/);
  assert.match(html, /Review Queue/);
});

test('LearnStepPanel renders next-step CTA when nextStep is provided', () => {
  const module = getLearnModuleById('foundations');
  assert.ok(module);
  const currentStep = module.steps[0];
  const nextStep = module.steps[1];
  assert.ok(currentStep);
  assert.ok(nextStep);

  const html = renderToStaticMarkup(
    <LearnStepPanel
      module={module}
      step={currentStep}
      nextStep={nextStep}
      completed={false}
      onComplete={() => undefined}
      onNext={() => undefined}
    />
  );

  assert.match(html, new RegExp(`Next: ${nextStep.title}`));
});
