import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedEntityGraphBanner } from '../src/components/entity-graph/saved-entity-graph-banner';
import {
  createBlankResolutionSpec,
  type PersistedEntityGraphWizardState,
} from '../src/lib/entity-graph-wizard-state';

const savedState: PersistedEntityGraphWizardState = {
  step: 'standardize',
  specName: 'company_resolution',
  spec: createBlankResolutionSpec('company_resolution'),
  yamlText: 'name: company_resolution',
  yamlDirty: false,
  savedAt: '2026-04-19T18:00:00.000Z',
};

test('SavedEntityGraphBanner renders nothing without a saved draft', () => {
  const html = renderToStaticMarkup(<SavedEntityGraphBanner initialSavedState={null} />);

  assert.equal(html, '');
});

test('SavedEntityGraphBanner renders the saved draft summary', () => {
  const html = renderToStaticMarkup(
    <SavedEntityGraphBanner
      initialSavedState={savedState}
      describeState={() => ({
        entityLabel: 'Company',
        stepIndex: 2,
        stepCount: 5,
      })}
    />
  );

  assert.match(html, /Saved Entity Graph draft/);
  assert.match(html, /Company is saved through step 2 of 5/);
  assert.match(html, /Load saved/);
});

test('SavedEntityGraphBanner links back to the saved wizard step', () => {
  const html = renderToStaticMarkup(<SavedEntityGraphBanner initialSavedState={savedState} />);

  assert.match(html, /href="\/entity-graph\/design\?step=standardize"/);
});
