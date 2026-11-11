/**
 * Pure functions for the daily release health check.
 *
 * Produces findings in the Husky contract schema (v1). Every field is
 * validated against a strict pattern. No free text from the registry or
 * audit output ever reaches the output.
 *
 * No I/O, no network, no file system. Testable with fixtures.
 */

// ---------------------------------------------------------------------------
// Validation (contract-mandated patterns)
// ---------------------------------------------------------------------------

const NPM_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const SEVERITY_VALUES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export const ALLOWED_FILES = new Set([
  'pnpm-workspace.yaml',
  'docs/dependency-security.md',
  'scripts/security/consumer-exceptions.json',
  'audit-ci.json',
]);

export function validateNpmName(name) {
  return typeof name === 'string' && NPM_NAME_RE.test(name) ? name : null;
}

export function validateVersion(version) {
  return typeof version === 'string' && SEMVER_RE.test(version) ? version : null;
}

export function validateGhsaId(id) {
  return typeof id === 'string' && GHSA_RE.test(id) ? id : null;
}

export function validateIsoDate(date) {
  return typeof date === 'string' && ISO_DATE_RE.test(date) ? date : null;
}

export function validateSeverity(severity) {
  return typeof severity === 'string' && SEVERITY_VALUES.has(severity) ? severity : null;
}

export function validateFile(file) {
  return ALLOWED_FILES.has(file) ? file : null;
}

/**
 * Validate a single finding against the contract schema.
 * Returns the finding unchanged if valid, null if any field fails.
 */
export function validateFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;

  switch (finding.kind) {
    case 'stale_parent':
      if (
        !validateGhsaId(finding.advisory) ||
        !validateNpmName(finding.package) ||
        !validateVersion(finding.version) ||
        !validateNpmName(finding.parentPackage) ||
        !validateVersion(finding.parentVersion) ||
        !Array.isArray(finding.reviewedParentVersions) ||
        finding.reviewedParentVersions.some((v) => !validateVersion(v)) ||
        !validateFile(finding.file)
      )
        return null;
      return finding;

    case 'expired_exemption':
      if (
        !validateNpmName(finding.package) ||
        !validateVersion(finding.version) ||
        !validateFile(finding.file)
      )
        return null;
      return finding;

    case 'deadline_soon':
      if (
        !validateNpmName(finding.package) ||
        !validateIsoDate(finding.due) ||
        !validateFile(finding.file)
      )
        return null;
      if (finding.advisory && !validateGhsaId(finding.advisory)) return null;
      return finding;

    case 'new_finding':
      if (
        !validateGhsaId(finding.advisory) ||
        !validateNpmName(finding.package) ||
        !validateVersion(finding.version) ||
        !validateSeverity(finding.severity)
      )
        return null;
      return finding;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Consumer audit finding classification
// ---------------------------------------------------------------------------

/**
 * Classify an unhandled consumer audit finding as either a stale exception
 * (same advisory/package/version/path exists but parentVersions mismatch)
 * or a genuinely new finding.
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
        severity: finding.severity,
        isLookahead,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Contract findings builder
// ---------------------------------------------------------------------------

/**
 * Map source names from collectExpiryDates to contract file paths.
 */
const SOURCE_TO_FILE = {
  'release-age exemption': 'pnpm-workspace.yaml',
  'audit-ci allowlist': 'audit-ci.json',
  'consumer exception': 'scripts/security/consumer-exceptions.json',
};

/**
 * Build the contract-schema findings array from expiry data and consumer
 * classification results. Every field is validated; invalid entries are
 * silently dropped.
 *
 * @param {Array} expiries       From collectExpiryDates()
 * @param {Array} consumerResults From classifyConsumerFindings()
 * @returns {Array} Contract-schema findings (max 50)
 */
export function buildContractFindings(expiries, consumerResults) {
  const findings = [];

  for (const entry of expiries) {
    if (
      entry.source === 'release-age exemption' &&
      (entry.status === 'expired' || entry.status === 'warning')
    ) {
      const match = entry.label?.match(/^((?:@[\w.-]+\/)?[\w.-]+)@([\d][\w.-]*)$/);
      if (!match) continue;
      const f = {
        kind: 'expired_exemption',
        package: match[1],
        version: match[2],
        file: SOURCE_TO_FILE[entry.source],
      };
      if (validateFinding(f)) findings.push(f);
    }

    if (entry.daysLeft > 0 && entry.daysLeft <= 7) {
      const advisory = entry.label?.match(/^(GHSA(?:-[\w]+){3})/)?.[1] ?? null;
      const pkg =
        entry.label?.match(/(?:^|[\s])(@?[a-z0-9][\w./-]*)(?:@[\d][\w.-]*)?$/)?.[1] ?? null;
      const f = {
        kind: 'deadline_soon',
        ...(advisory ? { advisory } : {}),
        package: pkg ?? entry.label?.split('@')[0],
        due: entry.date?.split('T')[0] ?? entry.date,
        file: SOURCE_TO_FILE[entry.source] ?? 'scripts/security/consumer-exceptions.json',
      };
      if (validateFinding(f)) findings.push(f);
    }
  }

  for (const result of consumerResults) {
    if (result.kind === 'stale-exception') {
      for (const [parent, info] of Object.entries(result.staleParents ?? {})) {
        const f = {
          kind: 'stale_parent',
          advisory: result.advisory,
          package: result.package,
          version: result.version,
          parentPackage: parent,
          parentVersion: info.actual,
          reviewedParentVersions: [...info.reviewed],
          file: 'scripts/security/consumer-exceptions.json',
        };
        if (validateFinding(f)) findings.push(f);
      }
    } else if (result.kind === 'new-finding') {
      const f = {
        kind: 'new_finding',
        advisory: result.advisory,
        package: result.package,
        version: result.version,
        severity: result.severity ?? 'high',
      };
      if (validateFinding(f)) findings.push(f);
    }
  }

  return findings.slice(0, 50);
}
