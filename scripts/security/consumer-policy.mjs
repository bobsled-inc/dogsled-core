import semver from 'semver';

export function selectDriverVersions(metadata, ranges, cutoff) {
  const eligible = Object.keys(metadata.versions ?? {}).filter(
    (version) =>
      semver.valid(version) &&
      ranges.every((range) => semver.satisfies(version, range)) &&
      Number.isFinite(Date.parse(metadata.time?.[version])) &&
      Date.parse(metadata.time[version]) <= cutoff
  );
  eligible.sort(semver.compare);
  if (eligible.length === 0) throw new Error(`No age-eligible version for ${metadata.name}.`);
  return { floor: eligible[0], latest: eligible.at(-1) };
}

export function explainPaths(explanation, targetName, includeVersions = false) {
  const paths = [];
  function visit(node, suffix, ancestors, versions) {
    if (!node || typeof node !== 'object') throw new Error('Malformed npm explain report.');
    const name = node.name;
    if (!name) {
      paths.push({ path: suffix.join('>'), versions });
      return;
    }
    if (ancestors.has(node.location ?? name)) return;
    const next = [name, ...suffix];
    const nextVersions = { [name]: node.version, ...versions };
    if (!node.dependents?.length) {
      paths.push({ path: next.join('>'), versions: nextVersions });
      return;
    }
    const seen = new Set(ancestors).add(node.location ?? name);
    for (const dependent of node.dependents) visit(dependent.from, next, seen, nextVersions);
  }
  for (const node of explanation) {
    if (node.name !== targetName) throw new Error('Unexpected npm explain package.');
    visit(node, [], new Set(), {});
  }
  if (!paths.length) throw new Error(`No dependency paths for ${targetName}.`);
  return includeVersions ? paths : [...new Set(paths.map((entry) => entry.path))].sort();
}

const EXEMPTION_PATTERN = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(.+)$/;

export function parseReleaseAgeExemptions(entries = []) {
  if (!Array.isArray(entries)) throw new Error('minimumReleaseAgeExclude must be a list.');
  const exemptions = [];
  for (const entry of entries) {
    const match = typeof entry === 'string' ? EXEMPTION_PATTERN.exec(entry) : null;
    const versions = match ? match[2].split('||').map((version) => version.trim()) : [];
    if (!match || versions.some((version) => semver.valid(version) !== version)) {
      throw new Error(`Release-age exemption ${String(entry)} must name exact versions.`);
    }
    for (const version of versions) exemptions.push({ name: match[1], version });
  }
  return exemptions;
}

export function exemptionOverrides(exemptions, tarballs) {
  const overrides = {};
  for (const { name, version } of exemptions) {
    const { major, minor } = semver.parse(version);
    const key = `${name}@${major > 0 ? `${major}.x` : `0.${minor}.x`}`;
    if (key in overrides) throw new Error(`Release-age exemptions overlap at ${key}.`);
    const tarball = tarballs.get(`${name}@${version}`);
    if (!tarball) throw new Error(`Missing registry tarball for ${name}@${version}.`);
    overrides[key] = tarball;
  }
  return overrides;
}

export const EXCEPTION_STATUSES = ['accepted_risk', 'not_applicable'];

export function validateConsumerExceptions(exceptions) {
  if (!Array.isArray(exceptions)) throw new Error('Consumer exceptions must be a list.');
  for (const [index, entry] of exceptions.entries()) {
    const label = `Consumer exception ${index} (${entry?.advisory ?? 'unknown advisory'})`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`${label} must be an object.`);
    if (!EXCEPTION_STATUSES.includes(entry.status)) {
      throw new Error(`${label} requires status ${EXCEPTION_STATUSES.join(' or ')}.`);
    }
  }
  return exceptions;
}

export function triageConsumerAudit(audit, explanations, exceptions, now = Date.now()) {
  validateConsumerExceptions(exceptions);
  if (
    audit.auditReportVersion !== 2 ||
    !audit.vulnerabilities ||
    typeof audit.vulnerabilities !== 'object' ||
    Array.isArray(audit.vulnerabilities) ||
    audit.error
  ) {
    throw new Error('Missing or malformed npm audit report.');
  }
  const findings = [];
  const followups = [];
  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    if (
      !Array.isArray(vulnerability.via) ||
      !vulnerability.via.length ||
      !Array.isArray(vulnerability.nodes)
    ) {
      throw new Error(`Malformed npm audit vulnerability for ${name}.`);
    }
    for (const advisory of vulnerability.via) {
      if (typeof advisory === 'string' && !audit.vulnerabilities[advisory]) {
        throw new Error(`Missing npm audit dependency finding for ${name}.`);
      }
      if (
        typeof advisory !== 'string' &&
        (!advisory || !['info', 'low', 'moderate', 'high', 'critical'].includes(advisory.severity))
      ) {
        throw new Error(`Malformed npm audit advisory for ${name}.`);
      }
      if (typeof advisory !== 'object') continue;
      const blocking = ['high', 'critical'].includes(advisory.severity);
      if (!/^https:\/\/github\.com\/advisories\/GHSA-[\w-]+$/.test(advisory.url ?? '')) {
        throw new Error(`Missing advisory identity for ${name}.`);
      }
      if (
        typeof advisory.range !== 'string' ||
        !advisory.range.trim() ||
        !semver.validRange(advisory.range)
      ) {
        throw new Error(`Malformed npm audit semver range for ${name}.`);
      }
      const id = advisory.url.split('/').at(-1);
      for (const location of vulnerability.nodes ?? []) {
        const explanation = explanations[location];
        if (!explanation?.length)
          throw new Error(`Missing installed dependency evidence for ${location}.`);
        for (const node of explanation) {
          if (node.location !== location)
            throw new Error(`Unexpected installed location for ${name}.`);
          if (!semver.valid(node.version)) {
            throw new Error(`Malformed npm audit semver version for ${name}.`);
          }
          if (!semver.satisfies(node.version, advisory.range, { includePrerelease: true }))
            continue;
          const paths = explainPaths([node], name, true);
          for (const { path: dependencyPath, versions } of paths) {
            if (!blocking) {
              followups.push({
                advisory: id,
                severity: advisory.severity,
                package: name,
                version: node.version,
                location,
                path: dependencyPath,
                disposition: 'review_before_phase_6',
              });
              continue;
            }
            const exception = exceptions.find(
              (entry) =>
                entry.advisory === id &&
                entry.package === name &&
                entry.versions.includes(node.version) &&
                Object.entries(entry.parentVersions ?? {}).every(([parent, allowed]) =>
                  allowed.includes(versions[parent])
                ) &&
                (dependencyPath === entry.path || dependencyPath.endsWith(`>${entry.path}`)) &&
                entry.owner &&
                entry.reason &&
                Number.isFinite(Date.parse(entry.expiry)) &&
                now < Date.parse(entry.expiry)
            );
            findings.push({
              advisory: id,
              package: name,
              version: node.version,
              location,
              path: dependencyPath,
              disposition: exception ? exception.status : 'unhandled',
              ...(exception
                ? { owner: exception.owner, expiry: exception.expiry, reason: exception.reason }
                : {}),
            });
          }
        }
      }
      if (!vulnerability.nodes?.length) throw new Error(`Missing installed nodes for ${name}.`);
    }
  }
  return {
    passed: findings.every((finding) => finding.disposition !== 'unhandled'),
    findings,
    followups,
  };
}
