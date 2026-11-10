/**
 * Pure functions for the daily release health check.
 *
 * Every function takes pre-fetched data and returns structured results.
 * No I/O, no network, no file system. Testable with fixtures.
 */

// ---------------------------------------------------------------------------
// Expiry and deadline detection
// ---------------------------------------------------------------------------

/**
 * Identify exemptions whose version has reached the release-age policy.
 */
export function findExpiredExemptions(exemptions, packuments, releaseAgeMinutes, now) {
  const results = [];
  const policyMs = releaseAgeMinutes * 60 * 1000;

  for (const { name, version } of exemptions) {
    const packument = packuments.get(name);
    const publishTime = packument?.time?.[version];
    if (!publishTime) continue;

    const publishMs = Date.parse(publishTime);
    if (!Number.isFinite(publishMs)) continue;

    if (now - publishMs >= policyMs) {
      results.push({
        kind: 'expired-exemption',
        package: name,
        version,
        publishedAt: publishTime,
        agedOutAt: new Date(publishMs + policyMs).toISOString(),
      });
    }
  }
  return results;
}

/**
 * Find audit-ci allowlist entries and consumer-exception deadlines that expire
 * within `warningDays`.
 */
export function findUpcomingDeadlines(auditCiAllowlist, consumerExceptions, warningDays, now) {
  const results = [];
  const warningMs = warningDays * 24 * 60 * 60 * 1000;

  for (const entry of auditCiAllowlist) {
    for (const [key, value] of Object.entries(entry)) {
      const expiry = value?.expiry;
      if (!expiry) continue;
      const expiryMs = Date.parse(expiry);
      if (Number.isFinite(expiryMs) && expiryMs > now && expiryMs - now <= warningMs) {
        results.push({
          kind: 'deadline-warning',
          source: 'audit-ci',
          key,
          expiry,
          daysLeft: Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)),
        });
      }
    }
  }

  for (const exception of consumerExceptions) {
    const expiry = exception?.expiry;
    if (!expiry) continue;
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs) && expiryMs > now && expiryMs - now <= warningMs) {
      results.push({
        kind: 'deadline-warning',
        source: 'consumer-exception',
        advisory: exception.advisory,
        package: exception.package,
        expiry,
        daysLeft: Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Consumer audit finding classification
// ---------------------------------------------------------------------------

/**
 * Classify an unhandled consumer audit finding as either a stale exception
 * (same advisory/package/version/path exists but parentVersions mismatch)
 * or a genuinely new finding.
 *
 * @param {object} finding  {advisory, package, version, path, disposition:'unhandled'}
 * @param {Array}  exceptions  consumer-exceptions.json entries
 * @param {number} now  current timestamp
 */
export function classifyConsumerFinding(finding, exceptions, now = Date.now()) {
  for (const entry of exceptions) {
    if (entry.advisory !== finding.advisory) continue;
    if (entry.package !== finding.package) continue;
    if (!entry.versions?.includes(finding.version)) continue;
    const pathMatch = finding.path === entry.path || finding.path.endsWith(`>${entry.path}`);
    if (!pathMatch) continue;
    if (!entry.owner || !entry.reason) continue;
    if (!Number.isFinite(Date.parse(entry.expiry)) || now >= Date.parse(entry.expiry)) continue;

    return { classification: 'stale-exception', exception: entry };
  }
  return { classification: 'new-finding' };
}

/**
 * Classify a batch of unhandled consumer audit findings.
 *
 * @param {Array}   findings          unhandled findings from triageConsumerAudit
 * @param {object}  parentVersionMap  { "advisory:pkg:ver:path": { parent: actualVersion } }
 * @param {Array}   exceptions        consumer-exceptions.json entries
 * @param {boolean} isLookahead       true if from the 3-day look-ahead
 * @param {number}  now
 * @returns {Array} classified findings with actionable details
 */
export function classifyConsumerFindings(
  findings,
  parentVersionMap,
  exceptions,
  isLookahead = false,
  now = Date.now()
) {
  const results = [];
  const seen = new Set();

  for (const finding of findings) {
    if (finding.disposition !== 'unhandled') continue;
    const key = `${finding.advisory}:${finding.package}:${finding.version}:${finding.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const result = classifyConsumerFinding(finding, exceptions, now);

    if (result.classification === 'stale-exception') {
      const actualParents = parentVersionMap[key] ?? {};
      const staleParents = {};
      for (const [parent, reviewed] of Object.entries(result.exception.parentVersions ?? {})) {
        const actual = actualParents[parent];
        if (actual && !reviewed.includes(actual)) {
          staleParents[parent] = { reviewed, actual };
        }
      }
      results.push({
        kind: 'stale-exception',
        advisory: finding.advisory,
        package: finding.package,
        version: finding.version,
        path: finding.path,
        exception: result.exception,
        staleParents,
        isLookahead,
      });
    } else {
      results.push({
        kind: 'new-finding',
        advisory: finding.advisory,
        package: finding.package,
        version: finding.version,
        path: finding.path,
        isLookahead,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Health report formatting
// ---------------------------------------------------------------------------

/**
 * Format the health check results as a step summary (markdown).
 */
export function formatHealthReport({
  timestamp,
  releaseAgeMinutes,
  expiredExemptions,
  deadlines,
  consumerFindings,
  consumerPassed,
  lookaheadPassed,
}) {
  const lines = [];
  const days = Math.round(releaseAgeMinutes / 60 / 24);
  lines.push('# Daily release health check');
  lines.push('');
  lines.push(`**Generated:** ${timestamp}`);
  lines.push(`**Release-age policy:** ${days} days (${releaseAgeMinutes} minutes)`);
  lines.push('');

  const stale = consumerFindings.filter((f) => f.kind === 'stale-exception');
  const newFindings = consumerFindings.filter((f) => f.kind === 'new-finding');

  lines.push('| Check | Status |');
  lines.push('| --- | --- |');
  lines.push(
    `| Expired exemptions | ${expiredExemptions.length === 0 ? 'clean' : `**${expiredExemptions.length} expired**`} |`
  );
  lines.push(
    `| Approaching deadlines | ${deadlines.length === 0 ? 'none' : `${deadlines.length} within 7 days`} |`
  );
  lines.push(
    `| Consumer audit (current) | ${consumerPassed ? 'passed' : '**unhandled findings**'} |`
  );
  lines.push(
    `| Consumer audit (3-day look-ahead) | ${lookaheadPassed ? 'passed' : '**unhandled findings**'} |`
  );
  lines.push(
    `| Stale exceptions | ${stale.length === 0 ? 'none' : `${stale.length} need parent update`} |`
  );
  lines.push(
    `| New findings | ${newFindings.length === 0 ? 'none' : `**${newFindings.length} new**`} |`
  );
  lines.push('');

  if (expiredExemptions.length > 0) {
    lines.push('## Expired exemptions');
    lines.push('');
    for (const e of expiredExemptions) {
      lines.push(
        `- \`${e.package}@${e.version}\` published ${e.publishedAt}, aged out ${e.agedOutAt}`
      );
    }
    lines.push('');
  }

  if (deadlines.length > 0) {
    lines.push('## Approaching deadlines');
    lines.push('');
    for (const d of deadlines) {
      const label = d.advisory ?? d.key ?? '';
      lines.push(
        `- ${d.source}: ${label} expires ${d.expiry} (${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'})`
      );
    }
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push('## Stale consumer exceptions');
    lines.push('');
    lines.push(
      'Each exception below matched an unhandled finding but its `parentVersions` is out of date.'
    );
    lines.push(
      'To fix, add the new parent version to the exception in `scripts/security/consumer-exceptions.json`:'
    );
    lines.push('');
    for (const s of stale) {
      const prefix = s.isLookahead ? '(look-ahead) ' : '';
      lines.push(`### ${prefix}\`${s.package}\` (${s.advisory})`);
      lines.push('');
      lines.push(`- Path: \`${s.path}\``);
      for (const [parent, info] of Object.entries(s.staleParents)) {
        lines.push(
          `- \`${parent}\`: reviewed ${info.reviewed.join(', ')} — add \`"${info.actual}"\``
        );
      }
      lines.push('');
    }
  }

  if (newFindings.length > 0) {
    lines.push('## New consumer audit findings');
    lines.push('');
    lines.push('These have no matching exception. A person must write the exception or fix.');
    lines.push('');
    for (const f of newFindings) {
      const prefix = f.isLookahead ? '(look-ahead) ' : '';
      lines.push(`- ${prefix}\`${f.package}\` ${f.advisory} via \`${f.path}\``);
    }
    lines.push('');
  }

  if (expiredExemptions.length === 0 && deadlines.length === 0 && consumerFindings.length === 0) {
    lines.push('All checks passed. No action needed.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Slack message building with prompt-injection safety
// ---------------------------------------------------------------------------

const NPM_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const GHSA_RE = /^GHSA-[\w-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

const SAFE_FILE_PATHS = new Set([
  'scripts/security/consumer-exceptions.json',
  'pnpm-workspace.yaml',
  'docs/dependency-security.md',
]);

/**
 * Validate and sanitize a value for inclusion in a Slack message.
 * Returns the value unchanged if it passes, or null if it fails.
 */
export function validateNpmName(name) {
  return typeof name === 'string' && NPM_NAME_RE.test(name) ? name : null;
}

export function validateVersion(version) {
  return typeof version === 'string' && SEMVER_RE.test(version) ? version : null;
}

export function validateGhsaId(id) {
  return typeof id === 'string' && GHSA_RE.test(id) ? id : null;
}

export function validateFilePath(filePath) {
  return SAFE_FILE_PATHS.has(filePath) ? filePath : null;
}

/**
 * Build a Slack instruction for Husky for a single actionable finding.
 * Uses ONLY validated values and fixed template text. No free-text fields
 * from the registry or audit output (advisory titles, descriptions, notes,
 * reasons) ever reach the message.
 *
 * @param {object} finding  A classified finding or expiry result
 * @param {string|null} huskyId  HUSKY_SLACK_USER_ID or null
 * @returns {string|null} The message text, or null if validation fails
 */
export function buildHuskyInstruction(finding, huskyId) {
  const mention = huskyId ? `<@${huskyId}> ` : '';

  switch (finding.kind) {
    case 'stale-exception': {
      const pkg = validateNpmName(finding.package);
      const version = validateVersion(finding.version);
      const advisory = validateGhsaId(finding.advisory);
      if (!pkg || !version || !advisory) return null;

      const parentLines = [];
      for (const [parent, info] of Object.entries(finding.staleParents ?? {})) {
        const parentName = validateNpmName(parent);
        const actual = validateVersion(info.actual);
        const lastReviewed = validateVersion(info.reviewed?.at(-1));
        if (!parentName || !actual) continue;
        parentLines.push(`add \`${parentName}\` \`${actual}\` to \`parentVersions\``);
        if (lastReviewed) {
          parentLines.push(
            `In the PR body, link the diff \`${parentName}@${lastReviewed}...${actual}\` and ask the owner to re-confirm reachability.`
          );
        }
      }
      if (parentLines.length === 0) return null;

      return [
        `${mention}Open a PR in bobsled-inc/dogsled-core: ${parentLines[0]} of the \`${advisory}\` / \`${pkg}\` \`${version}\` exception in \`scripts/security/consumer-exceptions.json\`.`,
        ...parentLines.slice(1),
        'Change Type `dependencies`.',
      ].join(' ');
    }

    case 'expired-exemption': {
      const pkg = validateNpmName(finding.package);
      const version = validateVersion(finding.version);
      if (!pkg || !version) return null;

      return `${mention}Open a PR removing \`${pkg}@${version}\` from \`minimumReleaseAgeExclude\` in \`pnpm-workspace.yaml\` and its docs row in \`docs/dependency-security.md\`. Change Type \`dependencies\`.`;
    }

    case 'deadline-warning': {
      const source = finding.source === 'audit-ci' ? 'audit-ci' : 'consumer-exception';
      const label =
        (finding.advisory ? validateGhsaId(finding.advisory) : null) ??
        finding.key?.replace(/[^\w|>@./-]/g, '') ??
        'unknown';
      return `${mention}Deadline in ${finding.daysLeft} day(s): ${source} entry \`${label}\` expires ${finding.expiry}. Decide whether to extend or fix before it blocks a release.`;
    }

    case 'new-finding': {
      const pkg = validateNpmName(finding.package);
      const advisory = validateGhsaId(finding.advisory);
      if (!pkg || !advisory) return null;
      const prefix = finding.isLookahead ? '(look-ahead) ' : '';
      return `${mention}${prefix}New consumer audit finding: \`${pkg}\` \`${advisory}\`. No matching exception exists. Write an exception or fix before the next release.`;
    }

    default:
      return null;
  }
}
