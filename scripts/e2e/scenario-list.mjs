import assert from 'node:assert/strict';

export const expectedScenarioIds = [
  'S01',
  'S03',
  'S04',
  'S05',
  'S06',
  'S07',
  'S11',
  'S12',
  'S14',
  'S15',
  'S17',
  'S22',
  'S23',
  'S24',
  'S25',
];
export function assertScenarioIds(ids) {
  assert.deepEqual(
    [...ids].sort(),
    expectedScenarioIds,
    'The full suite must discover every expected showcase exactly once'
  );
}
export function assertScenarioResults(passed, skipped, outsider) {
  assert.equal(
    passed,
    expectedScenarioIds.length - (outsider ? 1 : 0),
    'Every applicable showcase must pass'
  );
  assert.equal(
    skipped,
    outsider ? 1 : 0,
    'Only Explorer may be not applicable in the outsider suite'
  );
}
