import {
  autoReleaseBumpForChangeType,
  changeTypeForPullRequest,
  highestBump,
} from './change-type.mjs';

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const RELEASE_BRANCH = 'main';

export function createGitHubReader({ repository, token, fetchImpl = fetch }) {
  if (!REPOSITORY_PATTERN.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be owner/repository.');
  if (!token) throw new Error('GH_TOKEN is required to read merged pull requests.');
  return async (route) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${route}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub request ${route} failed (${response.status}).`);
    return response.json();
  };
}

function isMergedIntoReleaseBranch(pullRequest) {
  return Boolean(pullRequest?.merged_at) && pullRequest.base?.ref === RELEASE_BRANCH;
}

export function mergedPullRequestForCommit(sha, pullRequests) {
  const merged = (Array.isArray(pullRequests) ? pullRequests : []).filter(
    isMergedIntoReleaseBranch
  );
  if (merged.length !== 1)
    throw new Error(
      `Commit ${sha} must belong to exactly one pull request merged into ${RELEASE_BRANCH}; found ${merged.length}. Release it manually after review.`
    );
  return merged[0];
}

export function describePullRequest(pullRequest) {
  if (!Number.isSafeInteger(pullRequest?.number) || pullRequest.number < 1)
    throw new Error('Pull request response has no valid number.');
  let changeType;
  try {
    changeType = changeTypeForPullRequest(pullRequest);
  } catch (error) {
    throw new Error(`PR #${pullRequest.number}: ${error.message}`);
  }
  return {
    number: pullRequest.number,
    title: String(pullRequest.title ?? ''),
    changeType,
    bump: autoReleaseBumpForChangeType(changeType),
  };
}

export function decideMergedPullRequest(mergeSha, pullRequests) {
  const pullRequest = mergedPullRequestForCommit(mergeSha, pullRequests);
  return describePullRequest(pullRequest);
}

function isAncestor(git, commit, head) {
  try {
    git(['merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch {
    return false;
  }
}

export function autoReleaseRange({ previousVersion, git }) {
  const tag = `v${previousVersion}`;
  let tagCommit;
  try {
    tagCommit = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error(`Auto release needs the stable tag ${tag}; use mode new instead.`);
  }
  const head = git(['rev-parse', 'HEAD']);
  let base = tagCommit;
  if (!isAncestor(git, tagCommit, head)) {
    base = git(['rev-parse', `${tagCommit}^1`]);
    if (!isAncestor(git, base, head))
      throw new Error(`Release tag ${tag} is not based on the checked-out main history.`);
  }
  const commits = git(['rev-list', '--first-parent', '--reverse', `${base}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  return { tag, base, head, commits };
}

export async function resolveAutoRelease({ previousVersion, git, listPullRequests }) {
  const range = autoReleaseRange({ previousVersion, git });
  const entries = new Map();
  for (const sha of range.commits) {
    const pullRequest = mergedPullRequestForCommit(sha, await listPullRequests(sha));
    if (!entries.has(pullRequest.number))
      entries.set(pullRequest.number, { ...describePullRequest(pullRequest), commits: [] });
    entries.get(pullRequest.number).commits.push(sha);
  }
  const pullRequests = [...entries.values()];
  return {
    ...range,
    pullRequests,
    bump: highestBump(pullRequests.map((entry) => entry.bump)),
    breaking: pullRequests
      .filter((entry) => entry.changeType === 'major')
      .map((entry) => entry.number),
  };
}

function markdownText(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>|#!]/g, '\\$&');
}

export function autoReleaseSummary({ tag, pullRequests, bump }, version) {
  const lines = [`### Automatic release since ${tag}`, ''];
  if (pullRequests.length === 0) lines.push('No pull requests merged since the last release.');
  else {
    lines.push('| PR | Title | Change Type | Bump |', '| --- | --- | --- | --- |');
    for (const entry of pullRequests)
      lines.push(
        `| #${entry.number} | ${markdownText(entry.title)} | \`${entry.changeType}\` | ${entry.bump ?? 'none'} |`
      );
  }
  lines.push('', bump ? `Result: **${bump}** release \`v${version}\`.` : 'Result: no release.');
  if (pullRequests.some((entry) => entry.changeType === 'major'))
    lines.push('', '**Breaking:** this release contains a breaking change.');
  return `${lines.join('\n')}\n`;
}

export function mergeDecisionSummary(decision, autoRelease) {
  const action = !decision.bump
    ? 'No release.'
    : autoRelease === 'on'
      ? 'Dispatching Release in `auto` mode.'
      : 'Dry run: Release would be dispatched in `auto` mode.';
  return `### Release decision for #${decision.number}\n\n| PR | Title | Change Type | Bump |\n| --- | --- | --- | --- |\n| #${decision.number} | ${markdownText(decision.title)} | \`${decision.changeType}\` | ${decision.bump ?? 'none'} |\n\n${action}\n`;
}

function slackText(text) {
  return text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

export function notifySummary({ pullRequests, bump, breaking }, version, repoUrl) {
  const tag = `v${version}`;
  const lines = [`Release ${tag}?`];
  if (pullRequests.length === 1) {
    lines.push(slackText(pullRequests[0].title));
  } else if (pullRequests.length > 1) {
    lines.push(`${pullRequests.length} changes, including "${slackText(pullRequests[0].title)}"`);
  }
  for (const entry of pullRequests)
    lines.push(`- <${repoUrl}/pull/${entry.number}|#${entry.number}> ${slackText(entry.title)}`);
  if (breaking.length > 0) lines.push('Breaking');
  return lines.join('\n');
}

const MAX_NOTIFY_PRS = 50;
const MAX_NOTIFY_TEXT = 300;

function truncate(text, max = MAX_NOTIFY_TEXT) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function notifyOneLine(pullRequests) {
  if (pullRequests.length === 1) return truncate(pullRequests[0].title);
  if (pullRequests.length > 1)
    return truncate(`${pullRequests.length} changes, including "${pullRequests[0].title}"`);
  return '';
}

export function notifyPullRequests(pullRequests) {
  return JSON.stringify(
    pullRequests.slice(0, MAX_NOTIFY_PRS).map(({ number, title, changeType }) => ({
      number,
      title: truncate(title),
      changeType,
    }))
  );
}
