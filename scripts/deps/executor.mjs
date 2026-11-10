import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Executor for the dependency maintenance bot.
 *
 * Two phases, each in a separate CI job:
 *   prepare  (plan job, no write token): apply file changes, refresh lockfile,
 *            capture patches.
 *   execute  (act job, write token): apply patches, push branches, open PRs.
 *
 * Git and GitHub operations go through injectable interfaces so the executor
 * is testable without network or a real repository.
 */

// ---------------------------------------------------------------------------
// Branch and PR metadata
// ---------------------------------------------------------------------------

function sanitizePkg(name) {
  return name.replace(/^@/, '').replace(/\//g, '-');
}

export function branchName(action) {
  const pkg = sanitizePkg(action.package);
  switch (action.kind) {
    case 'bump':
      return `deps-bot/bump/${pkg}-${action.version}`;
    case 'exempt':
      return `deps-bot/exempt/${pkg}-${action.version}`;
    case 'remove-exemption':
      return `deps-bot/remove-exemption/${pkg}-${action.version}`;
    case 'remove-override':
      return `deps-bot/remove-override/${pkg}-${action.pinnedVersion}`;
    case 'update-exception':
      return `deps-bot/update-exception/${pkg}-${action.advisory}`;
    default:
      return null;
  }
}

export function commitMessage(action) {
  switch (action.kind) {
    case 'bump':
      return `Bump ${action.package} to ${action.version} (${action.ghsaId})`;
    case 'exempt':
      return `Exempt ${action.package}@${action.version} (${action.ghsaId})`;
    case 'remove-exemption':
      return `Remove aged exemption for ${action.package}@${action.version}`;
    case 'remove-override':
      return `Remove unneeded override for ${action.package}`;
    case 'update-exception':
      return `Update consumer exception for ${action.package} (${action.advisory})`;
    default:
      return null;
  }
}

export function prTitle(action) {
  return commitMessage(action);
}

export function prBody(action) {
  const lines = [];
  lines.push('## What does this change?');
  lines.push('');

  switch (action.kind) {
    case 'bump':
      lines.push(
        `Bumps \`${action.package}\` to \`${action.version}\` to fix ${action.ghsaId} (${action.severity}).`
      );
      lines.push('');
      lines.push(`- Published: ${action.publishedAt}`);
      lines.push(
        `- Dependency type: ${action.isDirect ? 'direct (catalog)' : 'transitive (override)'}`
      );
      break;
    case 'exempt':
      lines.push(
        `Exempts \`${action.package}@${action.version}\` from the release-age policy to fix ${action.ghsaId} (${action.severity}).`
      );
      lines.push('');
      lines.push(`- Published: ${action.publishedAt}`);
      lines.push(`- Remove after: ${action.removeAfter}`);
      lines.push('');
      lines.push('### Evidence');
      lines.push('');
      lines.push('> Filled by the bot from registry data. Owner reviews before merging.');
      break;
    case 'remove-exemption':
      lines.push(`Removes the release-age exemption for \`${action.package}@${action.version}\`.`);
      lines.push('');
      lines.push(
        `The version was published ${action.publishedAt} and met the release-age policy on ${action.agedOutAt}.`
      );
      break;
    case 'remove-override':
      lines.push(
        `Removes the override for \`${action.package}\` (pinned ${action.pinnedVersion}).`
      );
      lines.push('');
      lines.push(
        `Without the override, pnpm resolves \`${action.resolvedWithout}\`, which is at or above the pin.`
      );
      break;
    case 'update-exception': {
      lines.push(
        `Updates the consumer exception for \`${action.package}\` (${action.advisory}) to add a new parent version.`
      );
      lines.push('');
      lines.push(`- Path: \`${action.path}\``);
      lines.push('');
      lines.push('### Parent version changes');
      lines.push('');
      for (const [parent, info] of Object.entries(action.newParentVersions ?? {})) {
        lines.push(
          `- \`${parent}\`: reviewed ${info.reviewed.join(', ')} — now \`${info.actual}\``
        );
        lines.push(
          `  - [Diff ${info.reviewed.at(-1)} → ${info.actual}](https://www.npmjs.com/package/${parent}/v/${info.actual})`
        );
      }
      lines.push('');
      lines.push('### Owner checklist');
      lines.push('');
      lines.push(
        '- [ ] Confirmed the reachability reasoning still holds for the new parent version'
      );
      lines.push(
        '- [ ] Reviewed the parent package diff between the reviewed version and the new one'
      );
      if (action.isLookahead) {
        lines.push('');
        lines.push(
          '> This finding is from the 3-day look-ahead. The parent version has not yet aged into the release window.'
        );
      }
      break;
    }
  }

  lines.push('');
  lines.push('## Contribution checklist');
  lines.push('');
  lines.push('- [x] Every commit has my DCO sign-off.');
  lines.push(
    '- [x] No secrets, credentials or non-public information in the code, commits or this description.'
  );
  lines.push('');
  lines.push('## Change Type');
  lines.push('');
  lines.push('- [x] `dependencies` - 🔩 Dependency Updates');

  return lines.join('\n');
}

export function prLabels(action) {
  if (action.kind === 'exempt' || action.kind === 'update-exception')
    return ['needs-owner-approval'];
  return [];
}

// ---------------------------------------------------------------------------
// File-modification helpers (text-based to preserve YAML formatting)
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove a single exemption entry from pnpm-workspace.yaml text.
 * Handles both simple entries (`pkg@version`) and compound entries
 * (`pkg@v1 || v2 || v3`).
 */
export function removeExemptionEntry(text, name, version) {
  const eName = escapeRegex(name);
  const eVersion = escapeRegex(version);

  // Simple line: "  - pkg@version" or "  - 'pkg@version'"
  const simpleLine = new RegExp(`^[ \\t]*-\\s+['"]?${eName}@${eVersion}['"]?\\s*\\n`, 'm');
  if (simpleLine.test(text)) return text.replace(simpleLine, '');

  // Compound line: "  - pkg@v1 || v2 || v3"
  const compoundLine = new RegExp(`^([ \\t]*-\\s+['"]?${eName}@)(.*?)(['"]?\\s*)$`, 'm');
  const match = text.match(compoundLine);
  if (match) {
    const versions = match[2].split('||').map((v) => v.trim());
    const filtered = versions.filter((v) => v !== version);
    if (filtered.length === 0) {
      return text.replace(new RegExp(`^${escapeRegex(match[0])}\\n`, 'm'), '');
    }
    return text.replace(compoundLine, `${match[1]}${filtered.join(' || ')}${match[3]}`);
  }

  return text;
}

/**
 * Add an exemption entry to the minimumReleaseAgeExclude list.
 */
export function addExemptionEntry(text, name, version) {
  const spec = `${name}@${version}`;
  const needsQuotes = name.startsWith('@');
  const entry = needsQuotes ? `  - '${spec}'` : `  - ${spec}`;

  // Find the last entry in minimumReleaseAgeExclude
  const lines = text.split('\n');
  let lastExemptionIdx = -1;
  let inExemptions = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^minimumReleaseAgeExclude:/.test(lines[i])) {
      inExemptions = true;
      continue;
    }
    if (inExemptions) {
      if (/^\s+-\s/.test(lines[i])) {
        lastExemptionIdx = i;
      } else if (/^\S/.test(lines[i]) && lines[i].trim() !== '') {
        break;
      }
    }
  }

  if (lastExemptionIdx >= 0) {
    lines.splice(lastExemptionIdx + 1, 0, entry);
  }
  return lines.join('\n');
}

/**
 * Find the line range of the overrides section (start inclusive, end exclusive).
 */
function findOverridesRange(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^overrides:/.test(lines[i])) {
      start = i + 1;
      continue;
    }
    if (start >= 0 && /^\S/.test(lines[i]) && lines[i].trim() !== '') {
      return { start, end: i };
    }
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

/**
 * Add or update an override entry in pnpm-workspace.yaml.
 */
export function addOrUpdateOverride(text, name, version, comment) {
  const eName = escapeRegex(name);
  const lines = text.split('\n');
  const range = findOverridesRange(lines);

  if (range) {
    const pattern = new RegExp(`^([ \\t]+${eName}(?:@\\S+)?:\\s+)\\S+$`);
    for (let i = range.start; i < range.end; i++) {
      if (pattern.test(lines[i])) {
        lines[i] = lines[i].replace(pattern, `$1${version}`);
        return lines.join('\n');
      }
    }
  }

  // Add new override after the "overrides:" line
  for (let i = 0; i < lines.length; i++) {
    if (/^overrides:/.test(lines[i])) {
      const newLines = comment
        ? [`  # ${comment}`, `  ${name}: ${version}`]
        : [`  ${name}: ${version}`];
      lines.splice(i + 1, 0, ...newLines);
      break;
    }
  }
  return lines.join('\n');
}

/**
 * Remove an override entry from pnpm-workspace.yaml.
 * Scoped to the overrides section so catalog entries are never touched.
 */
export function removeOverrideEntry(text, name) {
  const eName = escapeRegex(name);
  const lines = text.split('\n');
  const range = findOverridesRange(lines);
  if (!range) return text;

  const entryPattern = new RegExp(`^[ \\t]+${eName}(?:@\\S+)?:\\s+\\S+$`);
  for (let i = range.start; i < range.end; i++) {
    if (entryPattern.test(lines[i])) {
      // Check if the preceding line is a comment
      const hasComment = i > range.start && /^[ \t]*#/.test(lines[i - 1]);
      const removeFrom = hasComment ? i - 1 : i;
      lines.splice(removeFrom, hasComment ? 2 : 1);
      return lines.join('\n');
    }
  }
  return text;
}

/**
 * Remove a docs table row from dependency-security.md that references the spec.
 */
export function removeDocsTableRow(text, spec) {
  const escapedSpec = escapeRegex(spec);
  const rowPattern = new RegExp(`^\\|[^\\n]*\`${escapedSpec}\`[^\\n]*\\n`, 'gm');
  return text.replace(rowPattern, '');
}

/**
 * Add a docs table row for an exemption.
 */
export function addDocsTableRow(text, spec, advisory, published, removeAfter) {
  const section = '## Security-fix release-age exemptions';
  const idx = text.indexOf(section);
  if (idx === -1) return text;

  // Find the last table row in the section
  const sectionText = text.slice(idx);
  const nextSection = sectionText.indexOf('\n## ', 1);
  const sectionEnd = nextSection >= 0 ? idx + nextSection : text.length;
  const beforeEnd = text.slice(0, sectionEnd);
  const afterEnd = text.slice(sectionEnd);

  // Find the last `| ` line
  const lines = beforeEnd.split('\n');
  let lastRowIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\| /.test(lines[i])) {
      lastRowIdx = i;
      break;
    }
  }

  if (lastRowIdx >= 0) {
    const row = `| \`${spec}\` | ${advisory} | ${published} | ${removeAfter} | (bot: verify before merging) |`;
    lines.splice(lastRowIdx + 1, 0, row);
  }

  return lines.join('\n') + afterEnd;
}

// ---------------------------------------------------------------------------
// Apply file changes for a single action
// ---------------------------------------------------------------------------

export function applyAction(action, repoRoot) {
  const wsPath = path.join(repoRoot, 'pnpm-workspace.yaml');
  const docsPath = path.join(repoRoot, 'docs', 'dependency-security.md');
  const modified = new Set();

  let ws = readFileSync(wsPath, 'utf8');
  let docs = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : '';

  switch (action.kind) {
    case 'bump': {
      if (action.isDirect) {
        // Update catalog entry
        const pattern = new RegExp(
          `(^[ \\t]+['"]?${escapeRegex(action.package)}['"]?:\\s+)\\S+`,
          'm'
        );
        if (pattern.test(ws)) {
          ws = ws.replace(pattern, `$1${action.version}`);
        }
      } else {
        ws = addOrUpdateOverride(ws, action.package, action.version, action.ghsaId);
      }
      // Remove exemption if present
      ws = removeExemptionEntry(ws, action.package, action.version);
      modified.add(wsPath);

      // Remove docs row if present
      const spec = `${action.package}@${action.version}`;
      if (docs.includes(`\`${spec}\``)) {
        docs = removeDocsTableRow(docs, spec);
        modified.add(docsPath);
      }
      break;
    }

    case 'exempt': {
      ws = addExemptionEntry(ws, action.package, action.version);
      if (!action.isDirect) {
        ws = addOrUpdateOverride(ws, action.package, action.version, action.ghsaId);
      }
      modified.add(wsPath);

      docs = addDocsTableRow(
        docs,
        `${action.package}@${action.version}`,
        action.ghsaId,
        action.publishedAt,
        action.removeAfter
      );
      modified.add(docsPath);
      break;
    }

    case 'remove-exemption': {
      ws = removeExemptionEntry(ws, action.package, action.version);
      modified.add(wsPath);

      const spec = `${action.package}@${action.version}`;
      if (docs.includes(`\`${spec}\``)) {
        docs = removeDocsTableRow(docs, spec);
        modified.add(docsPath);
      }
      break;
    }

    case 'remove-override': {
      ws = removeOverrideEntry(ws, action.package);
      modified.add(wsPath);
      break;
    }

    case 'update-exception': {
      const exceptionsPath = path.join(repoRoot, 'scripts', 'security', 'consumer-exceptions.json');
      const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
      for (const entry of exceptions) {
        if (
          entry.advisory !== action.advisory ||
          entry.package !== action.package ||
          !entry.versions?.includes(action.version)
        )
          continue;
        const pathMatch = action.path === entry.path || action.path.endsWith(`>${entry.path}`);
        if (!pathMatch) continue;

        for (const [parent, info] of Object.entries(action.newParentVersions ?? {})) {
          if (entry.parentVersions?.[parent]) {
            if (!entry.parentVersions[parent].includes(info.actual)) {
              entry.parentVersions[parent].push(info.actual);
            }
          }
        }
        break;
      }
      writeFileSync(exceptionsPath, `${JSON.stringify(exceptions, null, 2)}\n`);
      modified.add(exceptionsPath);
      break;
    }
  }

  writeFileSync(wsPath, ws);
  if (modified.has(docsPath) && docs) writeFileSync(docsPath, docs);

  return [...modified];
}

// ---------------------------------------------------------------------------
// Prepare phase (plan job, no write token)
// ---------------------------------------------------------------------------

const ACTIONABLE_KINDS = new Set([
  'bump',
  'exempt',
  'remove-exemption',
  'remove-override',
  'update-exception',
]);

export function prepareActions(plan, repoRoot, outputDir, exec) {
  const git = exec ?? ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }));
  const pnpm = exec
    ? () => {}
    : (args) => {
        try {
          execFileSync('pnpm', args, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
        } catch {
          /* lockfile refresh is best-effort */
        }
      };

  mkdirSync(path.join(outputDir, 'patches'), { recursive: true });
  writeFileSync(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2));

  const actionable = plan.actions.filter((a) => ACTIONABLE_KINDS.has(a.kind));
  const prepared = [];

  for (let i = 0; i < actionable.length; i++) {
    const action = actionable[i];
    const id = `${String(i).padStart(3, '0')}-${action.kind}-${sanitizePkg(action.package)}`;

    applyAction(action, repoRoot);
    pnpm(['install', '--lockfile-only']);

    git(['add', '-A']);
    const patch = git(['diff', '--cached', '--binary']);
    git(['reset', 'HEAD', '--', '.']);
    git(['checkout', '--', '.']);
    git(['clean', '-fd']);

    if (!patch.trim()) {
      prepared.push({ id, action, empty: true });
      continue;
    }

    writeFileSync(path.join(outputDir, 'patches', `${id}.patch`), patch);
    writeFileSync(
      path.join(outputDir, 'patches', `${id}.meta.json`),
      JSON.stringify(
        {
          branch: branchName(action),
          title: prTitle(action),
          body: prBody(action),
          commitMessage: commitMessage(action),
          labels: prLabels(action),
          action,
        },
        null,
        2
      )
    );
    prepared.push({ id, action, empty: false });
  }

  return prepared;
}

// ---------------------------------------------------------------------------
// Execute phase (act job, write token)
// ---------------------------------------------------------------------------

/**
 * Create real git operations for the act job.
 */
export function createGitOps(repoRoot, token, repo) {
  const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });

  return {
    createBranch(branch) {
      git('checkout', '-b', branch);
    },
    applyPatch(patchPath) {
      git('apply', '--index', patchPath);
    },
    commit(message) {
      git('commit', '-s', '-m', message);
    },
    push(branch) {
      execFileSync('git', ['push', remoteUrl, `HEAD:refs/heads/${branch}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
      });
    },
    checkoutMain() {
      git('checkout', 'main');
    },
  };
}

/**
 * Create real GitHub API operations for the act job.
 */
export function createGitHubOps(token, repo) {
  const [owner, name] = repo.split('/');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  return {
    async hasOpenPR(branch) {
      const url = `https://api.github.com/repos/${owner}/${name}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=1`;
      const response = await fetch(url, { headers });
      if (!response.ok) return false;
      const prs = await response.json();
      return Array.isArray(prs) && prs.length > 0;
    },

    async createPR({ branch, title, body, labels }) {
      const prResponse = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ head: branch, base: 'main', title, body }),
      });
      if (!prResponse.ok) {
        const text = await prResponse.text();
        throw new Error(`PR creation failed: ${prResponse.status} ${text}`);
      }
      const pr = await prResponse.json();

      if (labels.length > 0 && pr.number) {
        await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${pr.number}/labels`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels }),
        }).catch(() => {});
      }

      return pr.html_url;
    },

    async sendSlack(message) {
      const url = process.env.SLACK_DEPS_WEBHOOK_URL;
      if (!url) {
        process.stdout.write('SLACK_DEPS_WEBHOOK_URL is not set; skipping Slack notification.\n');
        return;
      }
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
    },
  };
}

/**
 * Execute prepared actions: apply patches, push branches, open PRs.
 *
 * @param {string} inputDir   Directory with plan.json and patches/
 * @param {object} gitOps     Git operations (createBranch, applyPatch, commit, push, checkoutMain)
 * @param {object} githubOps  GitHub operations (hasOpenPR, createPR, sendSlack)
 * @returns {Promise<object[]>} Results per action
 */
export async function executeActions(inputDir, gitOps, githubOps) {
  const plan = JSON.parse(readFileSync(path.join(inputDir, 'plan.json'), 'utf8'));
  const patchesDir = path.join(inputDir, 'patches');
  const results = [];

  if (existsSync(patchesDir)) {
    const patchFiles = readdirSync(patchesDir)
      .filter((f) => f.endsWith('.patch'))
      .sort();

    for (const patchFile of patchFiles) {
      const id = patchFile.replace('.patch', '');
      const metaPath = path.join(patchesDir, `${id}.meta.json`);
      if (!existsSync(metaPath)) continue;

      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const patchPath = path.join(patchesDir, patchFile);

      const exists = await githubOps.hasOpenPR(meta.branch);
      if (exists) {
        process.stdout.write(`Skipping ${meta.branch}: PR already exists.\n`);
        results.push({ id, branch: meta.branch, skipped: true });
        continue;
      }

      gitOps.createBranch(meta.branch);
      gitOps.applyPatch(patchPath);
      gitOps.commit(meta.commitMessage);
      gitOps.push(meta.branch);

      const url = await githubOps.createPR({
        branch: meta.branch,
        title: meta.title,
        body: meta.body,
        labels: meta.labels,
      });

      process.stdout.write(`Opened ${url} for ${meta.branch}\n`);
      results.push({ id, branch: meta.branch, skipped: false, url });
      gitOps.checkoutMain();
    }
  }

  // Slack notifications for non-actionable items
  const slackItems = plan.actions.filter(
    (a) => a.kind === 'no-fix' || a.kind === 'deadline-warning'
  );
  if (slackItems.length > 0) {
    const lines = ['*Dependency maintenance bot*\n'];
    for (const a of slackItems) {
      if (a.kind === 'no-fix') {
        lines.push(`No fix for \`${a.package}\` (${a.ghsaId}, ${a.severity}): ${a.reason}`);
      } else {
        lines.push(
          `Deadline in ${a.daysLeft} day(s): ${a.source} ${a.advisory ?? a.key ?? ''} expires ${a.expiry}`
        );
      }
    }
    await githubOps.sendSlack(lines.join('\n'));
  }

  return results;
}
