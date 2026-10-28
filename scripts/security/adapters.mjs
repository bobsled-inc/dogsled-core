import { createFinding } from './lib.mjs';

function parseJson(raw, label) {
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} output is not valid JSON: ${error.message}`);
  }
}

function portablePath(value) {
  return String(value ?? '')
    .replace(/^\/(?:repo|src)\//, '')
    .replaceAll('\\', '/');
}

function secretlintAdapter(raw, context) {
  const parsed = parseJson(raw, 'secretlint');
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error('secretlint output must be an array');

  return parsed.flatMap((file) =>
    (file.messages ?? []).map((message) =>
      createFinding({
        tool: context.tool,
        rule: message.ruleId,
        severity: message.severity === 2 ? 'high' : 'medium',
        message: message.message,
        evidence: message.message,
        location: {
          path: file.filePath,
          line: message.loc?.start?.line ?? message.line,
          column: message.loc?.start?.column ?? message.column,
        },
        fingerprint: message.fingerprint,
      })
    )
  );
}

function gitleaksAdapter(raw, context) {
  const parsed = parseJson(raw, 'gitleaks');
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error('gitleaks output must be an array');
  return parsed.map((finding) =>
    createFinding({
      tool: context.tool,
      rule: finding.RuleID,
      severity: 'high',
      message: finding.Description || `Potential secret matched ${finding.RuleID}`,
      evidence: finding.Match || '',
      location: {
        path: portablePath(finding.File),
        line: finding.StartLine,
        column: finding.StartColumn,
      },
    })
  );
}

function semgrepAdapter(raw, context) {
  const parsed = parseJson(raw, 'semgrep');
  if (parsed === null) return [];
  if (!Array.isArray(parsed.results)) throw new Error('semgrep output must contain results[]');
  return parsed.results.map((finding) =>
    createFinding({
      tool: context.tool,
      rule: finding.check_id,
      severity: finding.extra?.severity,
      message: finding.extra?.message,
      evidence: finding.extra?.lines ?? '',
      location: {
        path: portablePath(finding.path),
        line: finding.start?.line,
        column: finding.start?.col,
      },
      fingerprint:
        finding.extra?.fingerprint && finding.extra.fingerprint !== 'requires login'
          ? finding.extra.fingerprint
          : undefined,
    })
  );
}

function sarifAdapter(raw, context) {
  const parsed = parseJson(raw, 'SARIF');
  if (parsed === null) return [];
  if (parsed.version !== '2.1.0' || !Array.isArray(parsed.runs)) {
    throw new Error('SARIF output must be a version 2.1.0 document with runs[]');
  }

  return parsed.runs.flatMap((run) =>
    (run.results ?? []).map((finding) => {
      const region = finding.locations?.[0]?.physicalLocation?.region;
      return createFinding({
        tool: context.tool,
        rule: finding.ruleId,
        severity: finding.level,
        message: finding.message?.text,
        evidence: finding.message?.text,
        location: {
          path: finding.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
          line: region?.startLine,
          column: region?.startColumn,
        },
        fingerprint:
          finding.fingerprints?.['matchBasedId/v1'] ??
          finding.partialFingerprints?.primaryLocationLineHash,
      });
    })
  );
}

function osvAdapter(raw, context) {
  const parsed = parseJson(raw, 'OSV-Scanner');
  if (parsed === null) return [];
  if (!Array.isArray(parsed.results)) throw new Error('OSV output must contain results[]');

  return parsed.results.flatMap((result) =>
    (result.packages ?? []).flatMap((pkg) =>
      (pkg.vulnerabilities ?? []).map((vulnerability) =>
        createFinding({
          tool: context.tool,
          rule: vulnerability.id,
          severity: vulnerability.database_specific?.severity ?? 'medium',
          message: `${pkg.package?.name ?? 'dependency'}: ${vulnerability.summary ?? vulnerability.id}`,
          evidence: (vulnerability.aliases ?? []).join(', '),
          location: { path: portablePath(result.source?.path ?? 'pnpm-lock.yaml') },
          rootCause: `dependency:${vulnerability.id}`,
        })
      )
    )
  );
}

function pnpmAuditAdapter(raw, context) {
  const parsed = parseJson(raw, 'pnpm audit');
  if (parsed === null) return [];
  if (!Object.hasOwn(parsed, 'advisories')) {
    throw new Error('pnpm audit output must contain an advisories object');
  }
  const advisories = parsed.advisories;
  if (typeof advisories !== 'object' || Array.isArray(advisories)) {
    throw new Error('pnpm audit output must contain an advisories object');
  }
  return Object.values(advisories).map((advisory) =>
    createFinding({
      tool: context.tool,
      rule: advisory.github_advisory_id ?? String(advisory.id),
      severity: advisory.severity,
      message: `${advisory.module_name}: ${advisory.title}`,
      evidence: advisory.url ?? '',
      location: { path: 'pnpm-lock.yaml' },
      rootCause: `dependency:${advisory.github_advisory_id ?? advisory.id}`,
    })
  );
}

function actionlintAdapter(raw, context) {
  const parsed = parseJson(raw, 'actionlint');
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error('actionlint output must be an array');
  return parsed.map((finding) =>
    createFinding({
      tool: context.tool,
      rule: finding.kind,
      severity: 'medium',
      message: finding.message,
      evidence: finding.snippet ?? finding.message,
      location: {
        path: finding.filepath,
        line: finding.line,
        column: finding.column,
      },
    })
  );
}

function policyAdapter(raw, context) {
  const parsed = parseJson(raw, 'Dogsled policy');
  if (parsed === null) return [];
  if (!Array.isArray(parsed.findings))
    throw new Error('Dogsled policy output must contain findings[]');
  return parsed.findings.map((finding) => createFinding({ ...finding, tool: context.tool }));
}

function metadataAdapter(raw) {
  const parsed = parseJson(raw, 'metadata');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata output must be a JSON object');
  }
  return [];
}

function vitestAdapter(raw, context) {
  const parsed = parseJson(raw, 'Vitest');
  if (parsed === null) return [];
  if (typeof parsed.success !== 'boolean') {
    throw new Error('Vitest JSON output must include success');
  }
  if (parsed.success) return [];
  return (parsed.testResults ?? [])
    .filter((test) => test.status === 'failed')
    .map((test) =>
      createFinding({
        tool: context.tool,
        rule: 'property-test-failure',
        severity: 'high',
        message: test.name ?? 'Security property test failed',
        evidence: (test.message ?? '').slice(0, 2_000),
        location: { path: test.startTime ? 'tests/security' : '' },
        rootCause: `property-test:${test.name ?? 'unknown'}`,
      })
    );
}

const ADAPTERS = {
  actionlint: actionlintAdapter,
  gitleaks: gitleaksAdapter,
  metadata: metadataAdapter,
  'pnpm-audit': pnpmAuditAdapter,
  policy: policyAdapter,
  sarif: sarifAdapter,
  secretlint: secretlintAdapter,
  semgrep: semgrepAdapter,
  osv: osvAdapter,
  vitest: vitestAdapter,
};

export function normalizeToolOutput(adapter, raw, context) {
  const implementation = ADAPTERS[adapter];
  if (!implementation) throw new Error(`Unknown security adapter: ${adapter}`);
  return implementation(raw, context);
}

export const adapterNames = Object.freeze(Object.keys(ADAPTERS).sort());
