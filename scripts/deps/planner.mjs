import semver from 'semver';

/**
 * Pure planner for the dependency maintenance bot.
 *
 * Every function takes pre-fetched data and returns structured actions.
 * No I/O, no network, no file system. Testable with fixtures.
 */

/**
 * Find the first published version that is NOT in the vulnerable range and
 * follows at least one version that IS, i.e. the minimum fix version available
 * on the registry.
 */
export function findFirstPatchedVersion(vulnerableRange, packument) {
  if (!vulnerableRange || !packument?.versions) return null;

  const versions = Object.keys(packument.versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.compare);

  let maxVulnerable = null;
  for (const v of versions) {
    if (semver.satisfies(v, vulnerableRange, { includePrerelease: false })) {
      maxVulnerable = v;
    }
  }
  if (!maxVulnerable) return null;

  for (const v of versions) {
    if (semver.gt(v, maxVulnerable) && !semver.satisfies(v, vulnerableRange)) {
      return v;
    }
  }
  return null;
}

/**
 * Classify a single advisory into a bump, exempt, or no-fix action.
 *
 * @param {object} advisory  Normalized: {ghsaId, package, severity, vulnerableRange, firstPatchedVersion, isDirect}
 * @param {object} packument npm packument with a `time` map
 * @param {number} releaseAgeMinutes  From pnpm-workspace.yaml `minimumReleaseAge`
 * @param {number} now  Current timestamp (ms)
 */
export function classifyAdvisory(advisory, packument, releaseAgeMinutes, now) {
  if (!advisory.firstPatchedVersion) {
    return {
      kind: 'no-fix',
      ghsaId: advisory.ghsaId,
      package: advisory.package,
      severity: advisory.severity,
      reason: 'No fixed version available.',
    };
  }

  const version = advisory.firstPatchedVersion;
  const publishTime = packument?.time?.[version];
  if (!publishTime || !Number.isFinite(Date.parse(publishTime))) {
    return {
      kind: 'no-fix',
      ghsaId: advisory.ghsaId,
      package: advisory.package,
      severity: advisory.severity,
      reason: `Fixed version ${version} not found on the registry or has no publish time.`,
    };
  }

  const publishMs = Date.parse(publishTime);
  const policyMs = releaseAgeMinutes * 60 * 1000;

  if (now - publishMs >= policyMs) {
    return {
      kind: 'bump',
      ghsaId: advisory.ghsaId,
      package: advisory.package,
      version,
      severity: advisory.severity,
      isDirect: advisory.isDirect,
      publishedAt: publishTime,
    };
  }

  return {
    kind: 'exempt',
    ghsaId: advisory.ghsaId,
    package: advisory.package,
    version,
    severity: advisory.severity,
    isDirect: advisory.isDirect,
    publishedAt: publishTime,
    removeAfter: new Date(publishMs + policyMs).toISOString(),
  };
}

/**
 * Identify exemptions whose version has reached the release-age policy.
 */
export function findExpiredExemptions(exemptions, packuments, releaseAgeMinutes, now) {
  const actions = [];
  const policyMs = releaseAgeMinutes * 60 * 1000;

  for (const { name, version } of exemptions) {
    const packument = packuments.get(name);
    const publishTime = packument?.time?.[version];
    if (!publishTime) continue;

    const publishMs = Date.parse(publishTime);
    if (!Number.isFinite(publishMs)) continue;

    if (now - publishMs >= policyMs) {
      actions.push({
        kind: 'remove-exemption',
        package: name,
        version,
        publishedAt: publishTime,
        agedOutAt: new Date(publishMs + policyMs).toISOString(),
      });
    }
  }
  return actions;
}

/**
 * Find audit-ci allowlist entries and consumer-exception deadlines that expire
 * within `warningDays`.
 */
export function findUpcomingDeadlines(auditCiAllowlist, consumerExceptions, warningDays, now) {
  const actions = [];
  const warningMs = warningDays * 24 * 60 * 60 * 1000;

  for (const entry of auditCiAllowlist) {
    for (const [key, value] of Object.entries(entry)) {
      const expiry = value?.expiry;
      if (!expiry) continue;
      const expiryMs = Date.parse(expiry);
      if (Number.isFinite(expiryMs) && expiryMs > now && expiryMs - now <= warningMs) {
        actions.push({
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
      actions.push({
        kind: 'deadline-warning',
        source: 'consumer-exception',
        advisory: exception.advisory,
        package: exception.package,
        expiry,
        daysLeft: Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)),
      });
    }
  }

  return actions;
}

/**
 * Given pre-checked override results, identify overrides that can be removed.
 *
 * Each entry: {name, pinnedVersion, resolvedWithout: string|null, error: string|null}
 *   - resolvedWithout: the version pnpm resolves when the override is removed
 *   - error: set if the pnpm install check failed
 */
export function identifyRemovableOverrides(overrideResults) {
  const actions = [];
  for (const { name, pinnedVersion, resolvedWithout, error } of overrideResults) {
    if (error || !resolvedWithout) continue;
    if (semver.valid(resolvedWithout) && semver.gte(resolvedWithout, pinnedVersion)) {
      actions.push({
        kind: 'remove-override',
        package: name,
        pinnedVersion,
        resolvedWithout,
      });
    }
  }
  return actions;
}

/**
 * Build the full dependency maintenance plan from all inputs.
 */
export function buildPlan(inputs) {
  const {
    advisories,
    exemptions,
    packuments,
    releaseAgeMinutes,
    auditCiAllowlist = [],
    consumerExceptions = [],
    overrideResults = [],
    now = Date.now(),
  } = inputs;

  const actions = [];
  const seen = new Set();

  for (const advisory of advisories) {
    const key = `${advisory.ghsaId}:${advisory.package}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const packument = packuments.get(advisory.package);
    actions.push(classifyAdvisory(advisory, packument, releaseAgeMinutes, now));
  }

  actions.push(...findExpiredExemptions(exemptions, packuments, releaseAgeMinutes, now));
  actions.push(...findUpcomingDeadlines(auditCiAllowlist, consumerExceptions, 7, now));
  actions.push(...identifyRemovableOverrides(overrideResults));

  const bumpSpecs = new Set(
    actions.filter((a) => a.kind === 'bump').map((a) => `${a.package}@${a.version}`)
  );
  const deduplicated = actions.filter(
    (a) => !(a.kind === 'remove-exemption' && bumpSpecs.has(`${a.package}@${a.version}`))
  );

  const count = (kind) => deduplicated.filter((a) => a.kind === kind).length;

  return {
    timestamp: new Date(now).toISOString(),
    releaseAgeMinutes,
    releaseAgeDays: Math.round(releaseAgeMinutes / 60 / 24),
    advisoryCount: advisories.length,
    actions: deduplicated,
    summary: {
      bump: count('bump'),
      exempt: count('exempt'),
      noFix: count('no-fix'),
      removeExemption: count('remove-exemption'),
      removeOverride: count('remove-override'),
      deadlineWarning: count('deadline-warning'),
    },
  };
}

/**
 * Normalize open Dependabot alerts (REST API response) into the common
 * advisory shape the planner expects.
 */
export function normalizeAlerts(alerts) {
  const advisories = [];
  for (const alert of alerts) {
    if (alert.state !== 'open') continue;
    const vuln = alert.security_vulnerability;
    if (!vuln?.package?.name) continue;
    advisories.push({
      ghsaId: alert.security_advisory?.ghsa_id ?? null,
      package: vuln.package.name,
      severity: alert.security_advisory?.severity ?? vuln.severity,
      vulnerableRange: vuln.vulnerable_version_range ?? null,
      firstPatchedVersion: vuln.first_patched_version?.identifier ?? null,
      isDirect: alert.dependency?.scope === 'runtime',
    });
  }
  return advisories;
}

/**
 * Normalize pnpm/npm audit JSON into the common advisory shape.
 * Handles both npm audit v1 (advisories map) and v2 (vulnerabilities map).
 * When first_patched_version is not explicit, derives it from the packument.
 */
export function normalizeAuditReport(auditJson, packuments) {
  const advisories = [];

  if (auditJson?.advisories && typeof auditJson.advisories === 'object') {
    for (const advisory of Object.values(auditJson.advisories)) {
      let firstPatchedVersion = extractFirstPatchedVersion(advisory.patched_versions);
      if (!firstPatchedVersion && advisory.vulnerable_versions) {
        const packument = packuments?.get(advisory.module_name);
        if (packument) {
          firstPatchedVersion = findFirstPatchedVersion(advisory.vulnerable_versions, packument);
        }
      }
      advisories.push({
        ghsaId: advisory.github_advisory_id ?? null,
        package: advisory.module_name,
        severity: advisory.severity,
        vulnerableRange: advisory.vulnerable_versions ?? null,
        firstPatchedVersion,
        isDirect: advisory.findings?.some((f) => f.paths?.some((p) => !p.includes('>'))) ?? false,
      });
    }
  }

  if (auditJson?.auditReportVersion === 2 && auditJson?.vulnerabilities) {
    for (const [name, vuln] of Object.entries(auditJson.vulnerabilities)) {
      for (const via of vuln.via ?? []) {
        if (typeof via === 'string') continue;
        const ghsaId = via.url?.match(/GHSA-[\w-]+$/)?.[0] ?? null;
        const packument = packuments?.get(name);
        let firstPatchedVersion = null;
        if (packument && via.range) {
          firstPatchedVersion = findFirstPatchedVersion(via.range, packument);
        }
        advisories.push({
          ghsaId,
          package: name,
          severity: via.severity,
          vulnerableRange: via.range ?? null,
          firstPatchedVersion,
          isDirect: vuln.isDirect ?? false,
        });
      }
    }
  }

  return advisories;
}

function extractFirstPatchedVersion(patchedRange) {
  if (!patchedRange || patchedRange === '<0.0.0') return null;
  const match = patchedRange.match(/>=?\s*([\d][\w.-]*)/);
  return match ? match[1] : null;
}

/**
 * Format the plan as a GitHub step-summary (markdown).
 */
export function formatPlanSummary(plan, source) {
  const lines = [];
  lines.push('# Dependency maintenance plan');
  lines.push('');
  lines.push(`**Generated:** ${plan.timestamp}`);
  lines.push(
    `**Release-age policy:** ${plan.releaseAgeDays} days (${plan.releaseAgeMinutes} minutes)`
  );
  lines.push(`**Advisory source:** ${source}`);
  lines.push(`**Advisories scanned:** ${plan.advisoryCount}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Action | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Bump (fix old enough) | ${plan.summary.bump} |`);
  lines.push(`| Exempt (fix too young) | ${plan.summary.exempt} |`);
  lines.push(`| No fix available | ${plan.summary.noFix} |`);
  lines.push(`| Remove expired exemption | ${plan.summary.removeExemption} |`);
  lines.push(`| Remove unneeded override | ${plan.summary.removeOverride} |`);
  lines.push(`| Deadline warning (7 days or fewer) | ${plan.summary.deadlineWarning} |`);
  lines.push('');

  if (plan.actions.length === 0) {
    lines.push('No actions needed.');
    return lines.join('\n');
  }

  lines.push('## Actions');
  lines.push('');

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'bump':
        lines.push(`### Bump \`${action.package}\` to \`${action.version}\``);
        lines.push(`- Advisory: ${action.ghsaId}`);
        lines.push(`- Severity: ${action.severity}`);
        lines.push(`- Published: ${action.publishedAt}`);
        lines.push(
          `- Dependency type: ${action.isDirect ? 'direct' : 'transitive (needs override)'}`
        );
        lines.push('');
        break;
      case 'exempt':
        lines.push(`### Exempt \`${action.package}@${action.version}\` (needs owner approval)`);
        lines.push(`- Advisory: ${action.ghsaId}`);
        lines.push(`- Severity: ${action.severity}`);
        lines.push(`- Published: ${action.publishedAt}`);
        lines.push(`- Remove after: ${action.removeAfter}`);
        lines.push('');
        break;
      case 'no-fix':
        lines.push(`### No fix: \`${action.package}\` (${action.ghsaId})`);
        lines.push(`- Severity: ${action.severity}`);
        lines.push(`- ${action.reason}`);
        lines.push('');
        break;
      case 'remove-exemption':
        lines.push(`### Remove exemption: \`${action.package}@${action.version}\``);
        lines.push(`- Published: ${action.publishedAt}`);
        lines.push(`- Aged out: ${action.agedOutAt}`);
        lines.push('');
        break;
      case 'remove-override':
        lines.push(`### Remove override: \`${action.package}\``);
        lines.push(`- Pinned: ${action.pinnedVersion}`);
        lines.push(`- Resolved without override: ${action.resolvedWithout}`);
        lines.push('');
        break;
      case 'deadline-warning':
        lines.push(`### Deadline warning: ${action.source}`);
        if (action.advisory) lines.push(`- Advisory: ${action.advisory}`);
        if (action.key) lines.push(`- Entry: \`${action.key}\``);
        if (action.package) lines.push(`- Package: ${action.package}`);
        lines.push(
          `- Expires: ${action.expiry} (${action.daysLeft} day${action.daysLeft === 1 ? '' : 's'})`
        );
        lines.push('');
        break;
      case 'update-exception':
        lines.push(`### Update consumer exception: \`${action.package}\` (${action.advisory})`);
        lines.push(`- Path: \`${action.path}\``);
        for (const [parent, info] of Object.entries(action.newParentVersions ?? {})) {
          lines.push(`- \`${parent}\`: ${info.reviewed.join(', ')} -> ${info.actual}`);
        }
        if (action.isLookahead) lines.push('- Source: 3-day look-ahead');
        lines.push('');
        break;
      case 'consumer-alert':
        lines.push(`### Consumer audit alert: \`${action.package}\` (${action.advisory})`);
        lines.push(`- Path: \`${action.path}\``);
        if (action.isLookahead) lines.push('- Source: 3-day look-ahead');
        lines.push('');
        break;
    }
  }

  return lines.join('\n');
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
 * @returns {{ classification: 'stale-exception', exception: object } | { classification: 'new-finding' }}
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

    // All conditions match except parentVersions — the triage already
    // rejected this exception, so parentVersions must be the cause.
    return { classification: 'stale-exception', exception: entry };
  }
  return { classification: 'new-finding' };
}

/**
 * Build plan actions from consumer audit findings.
 *
 * @param {Array}  findings  unhandled findings from triageConsumerAudit
 * @param {object} parentVersionMap  { "advisory:pkg:ver:path": { parent: actualVersion } }
 * @param {Array}  exceptions  consumer-exceptions.json entries
 * @param {boolean} isLookahead  true if these came from the 3-day look-ahead run
 * @param {number}  now
 */
export function buildConsumerAuditActions(
  findings,
  parentVersionMap,
  exceptions,
  isLookahead = false,
  now = Date.now()
) {
  const actions = [];
  const seen = new Set();

  for (const finding of findings) {
    if (finding.disposition !== 'unhandled') continue;
    const key = `${finding.advisory}:${finding.package}:${finding.version}:${finding.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const result = classifyConsumerFinding(finding, exceptions, now);

    if (result.classification === 'stale-exception') {
      const actualParents = parentVersionMap[key] ?? {};
      const newParentVersions = {};
      for (const [parent, reviewed] of Object.entries(result.exception.parentVersions ?? {})) {
        const actual = actualParents[parent];
        if (actual && !reviewed.includes(actual)) {
          newParentVersions[parent] = { reviewed, actual };
        }
      }
      actions.push({
        kind: 'update-exception',
        advisory: finding.advisory,
        package: finding.package,
        version: finding.version,
        path: finding.path,
        exception: result.exception,
        newParentVersions,
        isLookahead,
      });
    } else {
      actions.push({
        kind: 'consumer-alert',
        advisory: finding.advisory,
        package: finding.package,
        version: finding.version,
        path: finding.path,
        isLookahead,
      });
    }
  }
  return actions;
}
