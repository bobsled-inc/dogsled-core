export const CHANGE_TYPES = Object.freeze([
  'patch',
  'minor',
  'major',
  'internal',
  'documentation',
  'tests',
  'dependencies',
  'performance',
  'skip-release',
]);

const CHANGE_TYPE_SET = new Set(CHANGE_TYPES);

export function parseChangeType(body) {
  if (!body) {
    throw new Error('Cannot determine change type: PR body is empty.');
  }

  const match = body.match(/## Change Type\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  if (!match) {
    throw new Error('Cannot determine change type: `## Change Type` section was not found.');
  }

  const checked = [...match[1].matchAll(/^[ \t]*-[ \t]*\[[xX]\][ \t]*\\?`([^`\\]+)\\?`/gm)].map(
    (checkbox) => checkbox[1]
  );

  if (checked.length !== 1) {
    throw new Error(
      `Exactly one change-type checkbox must be checked before merging. Found ${checked.length}. Must be one of: ${CHANGE_TYPES.join(', ')}`
    );
  }

  const changeType = checked[0];
  if (!CHANGE_TYPE_SET.has(changeType)) {
    throw new Error(`Invalid change-type label. Must be one of: ${CHANGE_TYPES.join(', ')}`);
  }

  return changeType;
}

export function releaseBumpForChangeType(changeType) {
  if (!CHANGE_TYPE_SET.has(changeType)) {
    throw new Error(`Unsupported change type: ${changeType}`);
  }
  if (changeType === 'skip-release') return null;
  if (changeType === 'major' || changeType === 'minor') return changeType;
  return 'patch';
}

const AUTO_RELEASE_BUMPS = Object.freeze({
  patch: 'patch',
  minor: 'minor',
  major: 'major',
  performance: 'patch',
  dependencies: null,
  internal: 'patch',
  documentation: 'patch',
  tests: 'patch',
  'skip-release': null,
});

const BUMP_ORDER = [null, 'patch', 'minor', 'major'];

export function autoReleaseBumpForChangeType(changeType) {
  if (!CHANGE_TYPE_SET.has(changeType)) {
    throw new Error(`Unsupported change type: ${changeType}`);
  }
  return AUTO_RELEASE_BUMPS[changeType];
}

export function highestBump(bumps) {
  return bumps.reduce((highest, bump) => {
    if (!BUMP_ORDER.includes(bump)) throw new Error(`Unsupported release bump: ${bump}`);
    return BUMP_ORDER.indexOf(bump) > BUMP_ORDER.indexOf(highest) ? bump : highest;
  }, null);
}

const DEPENDABOT_LABEL_TYPES = new Map(
  ['patch', 'minor', 'major'].map((changeType) => [`change-type: ${changeType}`, changeType])
);

function dependabotChangeType(labels) {
  const names = (Array.isArray(labels) ? labels : [])
    .map((label) => String(label?.name ?? '').toLowerCase())
    .filter((name) => DEPENDABOT_LABEL_TYPES.has(name));
  if (names.length > 1) {
    throw new Error(
      `At most one change-type label may be set on a Dependabot PR. Found ${names.length}: ${names.join(', ')}`
    );
  }
  return names.length === 1 ? DEPENDABOT_LABEL_TYPES.get(names[0]) : 'dependencies';
}

export function changeTypeForPullRequest(pullRequest) {
  return pullRequest?.user?.login === 'dependabot[bot]'
    ? dependabotChangeType(pullRequest.labels)
    : parseChangeType(pullRequest?.body ?? '');
}
