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

// S3c: lowercase only, matching Husky's regex (no uppercase legacy names)
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITY_VALUES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export const ALLOWED_FILES = new Set([
  'pnpm-workspace.yaml',
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
        finding.reviewedParentVersions.length > 20 ||
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
      if (!validateIsoDate(finding.due) || !validateFile(finding.file)) return null;
      // S3a: must have at least one of advisory or package
      if (!finding.advisory && !finding.package) return null;
      if (finding.advisory && !validateGhsaId(finding.advisory)) return null;
      if (finding.package && !validateNpmName(finding.package)) return null;
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
 *
 * S2: when a stale exception has no resolved parent versions (missing
 * explanations), it falls through to new_finding so it is never silent.
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
      // S2: if no parent version was resolved, fall through to new_finding
      if (Object.keys(staleParents).length > 0) {
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
          note: 'Matched a stale exception but could not resolve parent versions.',
        });
      }
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

const SOURCE_TO_FILE = {
  'release-age exemption': 'pnpm-workspace.yaml',
  'audit-ci allowlist': 'audit-ci.json',
  'consumer exception': 'scripts/security/consumer-exceptions.json',
};

/**
 * Build the contract-schema findings array from expiry data and consumer
 * classification results. Every field is validated; invalid entries are
 * counted and returned in `dropped`.
 *
 * S3: dropped entries are counted.
 * S4: package is optional for deadline_soon.
 * S5: deduplicates across all sources by kind + key fields.
 *
 * @param {Array} expiries        From collectExpiryDates()
 * @param {Array} consumerResults From classifyConsumerFindings()
 * @returns {{ findings: Array, dropped: number }}
 */
export function buildContractFindings(expiries, consumerResults) {
  const candidates = [];

  for (const entry of expiries) {
    // N8: release-age exemptions — only truly expired → expired_exemption;
    // warning (grace phase) → deadline_soon so Husky doesn't try to remove
    // an entry that isn't yet removable.
    if (entry.source === 'release-age exemption') {
      const match = entry.label?.match(
        /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d[\w.-]*)$/
      );
      if (match && entry.status === 'expired') {
        candidates.push({
          kind: 'expired_exemption',
          package: match[1],
          version: match[2],
          file: SOURCE_TO_FILE[entry.source],
        });
      } else if (match && entry.status === 'warning') {
        candidates.push({
          kind: 'deadline_soon',
          package: match[1],
          due: entry.date?.split('T')[0] ?? entry.date,
          file: SOURCE_TO_FILE[entry.source],
        });
      }
    }

    // Deadlines within 7 days (S4: handle each source properly)
    if (entry.daysLeft > 0 && entry.daysLeft <= 7) {
      const file = SOURCE_TO_FILE[entry.source];
      if (!file) continue;

      if (entry.source === 'audit-ci allowlist') {
        // Label is the GHSA ID (key before |)
        const advisory =
          entry.label?.match(/^(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})/)?.[1] ?? null;
        candidates.push({
          kind: 'deadline_soon',
          ...(advisory ? { advisory } : {}),
          due: entry.date?.split('T')[0] ?? entry.date,
          file,
        });
      } else if (entry.source === 'consumer exception') {
        // Label is "GHSA-xxx package-name"
        const advisory =
          entry.label?.match(/^(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})/)?.[1] ?? null;
        const pkg =
          entry.label?.match(
            /^GHSA(?:-[\w]+){3}\s+((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)$/
          )?.[1] ?? null;
        candidates.push({
          kind: 'deadline_soon',
          ...(advisory ? { advisory } : {}),
          ...(pkg ? { package: pkg } : {}),
          due: entry.date?.split('T')[0] ?? entry.date,
          file,
        });
      }
    }

    // Expired audit-ci or consumer-exception entries (docs: "fails on expired items")
    if (
      entry.source !== 'release-age exemption' &&
      (entry.status === 'expired' || entry.status === 'warning')
    ) {
      const file = SOURCE_TO_FILE[entry.source];
      if (!file) continue;
      const advisory = entry.label?.match(/^(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})/)?.[1] ?? null;
      const pkg =
        entry.label?.match(/(?:^|\s)((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)$/)?.[1] ?? null;
      candidates.push({
        kind: 'deadline_soon',
        ...(advisory ? { advisory } : {}),
        ...(pkg ? { package: pkg } : {}),
        due: entry.date?.split('T')[0] ?? entry.date,
        file,
      });
    }
  }

  // Consumer findings
  for (const result of consumerResults) {
    if (result.kind === 'stale-exception') {
      for (const [parent, info] of Object.entries(result.staleParents ?? {})) {
        candidates.push({
          kind: 'stale_parent',
          advisory: result.advisory,
          package: result.package,
          version: result.version,
          parentPackage: parent,
          parentVersion: info.actual,
          reviewedParentVersions: [...info.reviewed].slice(0, 20),
          file: 'scripts/security/consumer-exceptions.json',
        });
      }
    } else if (result.kind === 'new-finding') {
      // N4: do not invent severity; drop if missing
      if (!result.severity) continue;
      candidates.push({
        kind: 'new_finding',
        advisory: result.advisory,
        package: result.package,
        version: result.version,
        severity: result.severity,
      });
    }
  }

  // S5: deduplicate across all sources
  const deduped = [];
  const seenKeys = new Set();
  for (const f of candidates) {
    const key = dedupeKey(f);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(f);
  }

  // S3: validate and count drops
  const findings = [];
  let dropped = 0;
  for (const f of deduped) {
    if (validateFinding(f)) {
      findings.push(f);
    } else {
      dropped++;
    }
  }

  return { findings: findings.slice(0, 50), dropped };
}

function dedupeKey(finding) {
  switch (finding.kind) {
    case 'stale_parent':
      return `stale_parent:${finding.advisory}:${finding.package}:${finding.version}:${finding.parentPackage}`;
    case 'expired_exemption':
      return `expired_exemption:${finding.package}:${finding.version}`;
    case 'deadline_soon':
      return `deadline_soon:${finding.advisory ?? ''}:${finding.package ?? ''}:${finding.file}`;
    case 'new_finding':
      return `new_finding:${finding.advisory}:${finding.package}:${finding.version}`;
    default:
      return JSON.stringify(finding);
  }
}
