import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyStandardizeTransform,
  previewStandardizeTransforms,
} from '../src/lib/entity-graph-standardize-preview';

test('preview lowercases text', () => {
  assert.deepEqual(applyStandardizeTransform('AcMe', 'lowercase'), {
    output: 'acme',
    supported: true,
  });
});

test('preview uppercases text', () => {
  assert.deepEqual(applyStandardizeTransform('AcMe', 'uppercase'), {
    output: 'ACME',
    supported: true,
  });
});

test('preview trims outer whitespace', () => {
  assert.deepEqual(applyStandardizeTransform('  Acme  ', 'trim'), {
    output: 'Acme',
    supported: true,
  });
});

test('preview collapses internal whitespace', () => {
  assert.deepEqual(applyStandardizeTransform('Acme   Corporation', 'collapse_whitespace'), {
    output: 'Acme Corporation',
    supported: true,
  });
});

test('preview keeps only digits', () => {
  assert.deepEqual(applyStandardizeTransform('(312) 555-0199', 'digits_only'), {
    output: '3125550199',
    supported: true,
  });
});

test('preview strips legal suffixes and trailing punctuation', () => {
  assert.deepEqual(applyStandardizeTransform('Acme Corp.', 'strip_legal_suffixes'), {
    output: 'Acme',
    supported: true,
  });
});

test('preview keeps non-terminal legal words intact', () => {
  assert.deepEqual(applyStandardizeTransform('Acme Corp Holdings', 'strip_legal_suffixes'), {
    output: 'Acme Corp Holdings',
    supported: true,
  });
});

test('preview removes punctuation when requested', () => {
  assert.deepEqual(applyStandardizeTransform('Acme, Inc.!', 'remove_punctuation'), {
    output: 'Acme Inc',
    supported: true,
  });
});

test('preview applies the transform chain in order', () => {
  const preview = previewStandardizeTransforms('  Acme Corp.  ', [
    'trim',
    'strip_legal_suffixes',
    'lowercase',
  ]);

  assert.equal(preview.output, 'acme');
  assert.deepEqual(
    preview.steps.map((step) => `${step.transform}:${step.output}`),
    ['trim:Acme Corp.', 'strip_legal_suffixes:Acme', 'lowercase:acme']
  );
  assert.deepEqual(preview.unsupportedTransforms, []);
});
