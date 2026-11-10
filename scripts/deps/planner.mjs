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
