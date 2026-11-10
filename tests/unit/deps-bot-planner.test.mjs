import { describe, expect, it } from 'vitest';

import {
  buildConsumerAuditActions,
  buildPlan,
  classifyAdvisory,
  classifyConsumerFinding,
  findExpiredExemptions,
  findFirstPatchedVersion,
  findUpcomingDeadlines,
  formatPlanSummary,
  identifyRemovableOverrides,
  normalizeAlerts,
  normalizeAuditReport,
} from '../../scripts/deps/planner.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function makePackument(name, versions) {
  const time = {};
  const versionMap = {};
  for (const [v, publishedAt] of Object.entries(versions)) {
    time[v] = publishedAt;
    versionMap[v] = { version: v };
  }
  return { name, time, versions: versionMap };
}

describe('findFirstPatchedVersion', () => {
  const packument = makePackument('example', {
    '1.0.0': '2026-01-01T00:00:00Z',
    '1.0.1': '2026-02-01T00:00:00Z',
    '1.1.0': '2026-03-01T00:00:00Z',
    '2.0.0': '2026-04-01T00:00:00Z',
  });

  it('finds the first version outside a simple range', () => {
    expect(findFirstPatchedVersion('<1.1.0', packument)).toBe('1.1.0');
  });

  it('finds the fix for a bounded range', () => {
    expect(findFirstPatchedVersion('>=1.0.0 <2.0.0', packument)).toBe('2.0.0');
  });

  it('returns null when no fix exists', () => {
    expect(findFirstPatchedVersion('>=0.0.0', packument)).toBeNull();
  });

  it('returns null for a missing or empty packument', () => {
    expect(findFirstPatchedVersion('<2.0.0', null)).toBeNull();
    expect(findFirstPatchedVersion('<2.0.0', { versions: {} })).toBeNull();
  });

  it('returns null when the vulnerable range is empty', () => {
    expect(findFirstPatchedVersion(null, packument)).toBeNull();
  });
});

describe('classifyAdvisory', () => {
  const packument = makePackument('fast-uri', {
    '3.1.8': '2026-09-01T00:00:00Z',
    '3.1.9': '2026-10-19T23:05:26Z',
  });

  const advisory = {
    ghsaId: 'GHSA-w74x-v6f9-j3xg',
    package: 'fast-uri',
    severity: 'moderate',
    vulnerableRange: '<3.1.9',
    firstPatchedVersion: '3.1.9',
    isDirect: false,
  };

  it('classifies as bump when the fix is old enough', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const result = classifyAdvisory(advisory, packument, 30240, now);
    expect(result.kind).toBe('bump');
    expect(result.package).toBe('fast-uri');
    expect(result.version).toBe('3.1.9');
  });

  it('classifies as exempt when the fix is too young', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const result = classifyAdvisory(advisory, packument, 30240, now);
    expect(result.kind).toBe('exempt');
    expect(result.removeAfter).toBeTruthy();
  });

  it('classifies as no-fix when there is no patched version', () => {
    const noFix = { ...advisory, firstPatchedVersion: null };
    const result = classifyAdvisory(noFix, packument, 30240, Date.now());
    expect(result.kind).toBe('no-fix');
    expect(result.reason).toMatch(/No fixed version/);
  });

  it('classifies as no-fix when the version has no publish time', () => {
    const emptyPackument = makePackument('fast-uri', {});
    const result = classifyAdvisory(advisory, emptyPackument, 30240, Date.now());
    expect(result.kind).toBe('no-fix');
    expect(result.reason).toMatch(/not found on the registry/);
  });
});

describe('findExpiredExemptions', () => {
  it('identifies exemptions that met the release age', () => {
    const exemptions = [
      { name: 'fast-uri', version: '3.1.9' },
      { name: 'body-parser', version: '2.4.0' },
    ];
    const packuments = new Map([
      ['fast-uri', makePackument('fast-uri', { '3.1.9': '2026-10-19T23:05:26Z' })],
      ['body-parser', makePackument('body-parser', { '2.4.0': '2026-10-22T11:39:38Z' })],
    ]);
    const now = Date.parse('2026-11-10T00:00:00Z');
    const actions = findExpiredExemptions(exemptions, packuments, 30240, now);

    expect(actions).toHaveLength(1);
    expect(actions[0].package).toBe('fast-uri');
    expect(actions[0].kind).toBe('remove-exemption');
  });

  it('returns nothing when all exemptions are still young', () => {
    const exemptions = [{ name: 'body-parser', version: '2.4.0' }];
    const packuments = new Map([
      ['body-parser', makePackument('body-parser', { '2.4.0': '2026-10-22T11:39:38Z' })],
    ]);
    const now = Date.parse('2026-10-25T00:00:00Z');
    expect(findExpiredExemptions(exemptions, packuments, 30240, now)).toHaveLength(0);
  });

  it('skips exemptions with no packument', () => {
    const exemptions = [{ name: 'missing', version: '1.0.0' }];
    expect(findExpiredExemptions(exemptions, new Map(), 30240, Date.now())).toHaveLength(0);
  });
});

describe('findUpcomingDeadlines', () => {
  it('warns about audit-ci entries expiring within the window', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    const allowlist = [
      {
        'GHSA-xcx6-jx8p-x3h5|path': {
          active: true,
          expiry: '2026-11-05T00:00:00Z',
        },
      },
    ];
    const actions = findUpcomingDeadlines(allowlist, [], 7, now);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('deadline-warning');
    expect(actions[0].source).toBe('audit-ci');
    expect(actions[0].daysLeft).toBe(3);
  });

  it('warns about consumer exceptions expiring within the window', () => {
    const now = Date.parse('2026-11-16T00:00:00Z');
    const exceptions = [
      {
        advisory: 'GHSA-c475-qrg2-pj4r',
        package: 'basic-ftp',
        expiry: '2026-11-20T00:00:00Z',
      },
    ];
    const actions = findUpcomingDeadlines([], exceptions, 7, now);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('deadline-warning');
    expect(actions[0].source).toBe('consumer-exception');
  });

  it('ignores entries outside the warning window', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const allowlist = [{ key: { expiry: '2026-11-05T00:00:00Z' } }];
    expect(findUpcomingDeadlines(allowlist, [], 7, now)).toHaveLength(0);
  });

  it('ignores already-expired entries', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    const exceptions = [{ advisory: 'GHSA-xxx', package: 'x', expiry: '2026-11-01T00:00:00Z' }];
    expect(findUpcomingDeadlines([], exceptions, 7, now)).toHaveLength(0);
  });
});

describe('identifyRemovableOverrides', () => {
  it('identifies overrides where the resolved version is at or above the pin', () => {
    const results = [
      { name: 'qs', pinnedVersion: '6.16.1', resolvedWithout: '6.17.0', error: null },
      { name: 'lodash', pinnedVersion: '4.18.1', resolvedWithout: '4.18.1', error: null },
      { name: 'axios', pinnedVersion: '1.20.0', resolvedWithout: '1.19.0', error: null },
    ];
    const actions = identifyRemovableOverrides(results);
    expect(actions).toHaveLength(2);
    expect(actions[0].package).toBe('qs');
    expect(actions[1].package).toBe('lodash');
  });

  it('skips overrides with errors', () => {
    const results = [
      { name: 'pkg', pinnedVersion: '1.0.0', resolvedWithout: null, error: 'install failed' },
    ];
    expect(identifyRemovableOverrides(results)).toHaveLength(0);
  });
});

describe('normalizeAlerts', () => {
  it('normalizes open Dependabot alerts', () => {
    const alerts = [
      {
        state: 'open',
        security_advisory: { ghsa_id: 'GHSA-w74x-v6f9-j3xg', severity: 'moderate' },
        security_vulnerability: {
          package: { name: 'fast-uri' },
          vulnerable_version_range: '<3.1.9',
          first_patched_version: { identifier: '3.1.9' },
          severity: 'moderate',
        },
        dependency: { scope: 'development' },
      },
      {
        state: 'dismissed',
        security_advisory: { ghsa_id: 'GHSA-xxx', severity: 'low' },
        security_vulnerability: {
          package: { name: 'dismissed-pkg' },
          vulnerable_version_range: '<1.0.0',
          first_patched_version: { identifier: '1.0.0' },
        },
        dependency: { scope: 'runtime' },
      },
    ];

    const result = normalizeAlerts(alerts);
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe('GHSA-w74x-v6f9-j3xg');
    expect(result[0].package).toBe('fast-uri');
    expect(result[0].isDirect).toBe(false);
  });

  it('handles alerts with no patched version', () => {
    const alerts = [
      {
        state: 'open',
        security_advisory: { ghsa_id: 'GHSA-nopatch', severity: 'high' },
        security_vulnerability: {
          package: { name: 'no-patch' },
          vulnerable_version_range: '<99.0.0',
          first_patched_version: null,
        },
        dependency: { scope: 'runtime' },
      },
    ];
    const result = normalizeAlerts(alerts);
    expect(result).toHaveLength(1);
    expect(result[0].firstPatchedVersion).toBeNull();
  });
});

describe('normalizeAuditReport', () => {
  it('normalizes v1 format (pnpm audit)', () => {
    const auditJson = {
      advisories: {
        1: {
          github_advisory_id: 'GHSA-test-1234-abcd',
          module_name: 'example-pkg',
          severity: 'high',
          vulnerable_versions: '<2.0.0',
          patched_versions: '>=2.0.0',
          findings: [{ paths: ['example-pkg'] }],
        },
      },
    };
    const result = normalizeAuditReport(auditJson, new Map());
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe('GHSA-test-1234-abcd');
    expect(result[0].firstPatchedVersion).toBe('2.0.0');
    expect(result[0].isDirect).toBe(true);
  });

  it('normalizes v2 format (npm audit)', () => {
    const packument = makePackument('example', {
      '1.0.0': '2026-01-01T00:00:00Z',
      '1.0.1': '2026-06-01T00:00:00Z',
    });
    const auditJson = {
      auditReportVersion: 2,
      vulnerabilities: {
        example: {
          name: 'example',
          isDirect: true,
          via: [
            {
              url: 'https://github.com/advisories/GHSA-v2-test-1234',
              severity: 'high',
              range: '<1.0.1',
            },
          ],
        },
      },
    };
    const result = normalizeAuditReport(auditJson, new Map([['example', packument]]));
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe('GHSA-v2-test-1234');
    expect(result[0].firstPatchedVersion).toBe('1.0.1');
  });

  it('skips string via entries in v2 format', () => {
    const auditJson = {
      auditReportVersion: 2,
      vulnerabilities: {
        indirect: {
          name: 'indirect',
          via: ['some-other-pkg'],
        },
      },
    };
    expect(normalizeAuditReport(auditJson, new Map())).toHaveLength(0);
  });
});

describe('buildPlan', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');

  const packuments = new Map([
    [
      'fast-uri',
      makePackument('fast-uri', {
        '3.1.8': '2026-09-01T00:00:00Z',
        '3.1.9': '2026-10-19T23:05:26Z',
      }),
    ],
    [
      'body-parser',
      makePackument('body-parser', {
        '2.3.0': '2026-08-01T00:00:00Z',
        '2.4.0': '2026-10-22T11:39:38Z',
      }),
    ],
    [
      'unfixed',
      makePackument('unfixed', {
        '1.0.0': '2026-01-01T00:00:00Z',
      }),
    ],
  ]);

  it('produces a complete plan with all action types', () => {
    const plan = buildPlan({
      advisories: [
        {
          ghsaId: 'GHSA-w74x-v6f9-j3xg',
          package: 'fast-uri',
          severity: 'moderate',
          vulnerableRange: '<3.1.9',
          firstPatchedVersion: '3.1.9',
          isDirect: false,
        },
        {
          ghsaId: 'GHSA-27r3-jxmh-p828',
          package: 'body-parser',
          severity: 'high',
          vulnerableRange: '<2.4.0',
          firstPatchedVersion: '2.4.0',
          isDirect: false,
        },
        {
          ghsaId: 'GHSA-unfixed',
          package: 'unfixed',
          severity: 'critical',
          vulnerableRange: '>=1.0.0',
          firstPatchedVersion: null,
          isDirect: true,
        },
      ],
      exemptions: [
        { name: 'fast-uri', version: '3.1.9' },
        { name: 'body-parser', version: '2.4.0' },
      ],
      packuments,
      releaseAgeMinutes: 30240,
      auditCiAllowlist: [{ 'GHSA-xcx6|path': { expiry: '2026-11-12T00:00:00Z' } }],
      consumerExceptions: [],
      now,
    });

    expect(plan.releaseAgeMinutes).toBe(30240);
    expect(plan.releaseAgeDays).toBe(21);

    expect(plan.summary.bump).toBe(1);
    expect(plan.summary.exempt).toBe(1);
    expect(plan.summary.noFix).toBe(1);
    expect(plan.summary.deadlineWarning).toBe(1);

    const bump = plan.actions.find((a) => a.kind === 'bump');
    expect(bump.package).toBe('fast-uri');

    const exempt = plan.actions.find((a) => a.kind === 'exempt');
    expect(exempt.package).toBe('body-parser');

    const noFix = plan.actions.find((a) => a.kind === 'no-fix');
    expect(noFix.package).toBe('unfixed');
  });

  it('deduplicates advisory + exemption removal for the same spec', () => {
    const plan = buildPlan({
      advisories: [
        {
          ghsaId: 'GHSA-w74x-v6f9-j3xg',
          package: 'fast-uri',
          severity: 'moderate',
          vulnerableRange: '<3.1.9',
          firstPatchedVersion: '3.1.9',
          isDirect: false,
        },
      ],
      exemptions: [{ name: 'fast-uri', version: '3.1.9' }],
      packuments,
      releaseAgeMinutes: 30240,
      now,
    });

    const removals = plan.actions.filter(
      (a) => a.kind === 'remove-exemption' && a.package === 'fast-uri'
    );
    expect(removals).toHaveLength(0);

    expect(plan.summary.bump).toBe(1);
  });

  it('deduplicates advisories by ghsaId + package', () => {
    const plan = buildPlan({
      advisories: [
        {
          ghsaId: 'GHSA-dup',
          package: 'dup-pkg',
          severity: 'high',
          firstPatchedVersion: null,
          isDirect: false,
        },
        {
          ghsaId: 'GHSA-dup',
          package: 'dup-pkg',
          severity: 'high',
          firstPatchedVersion: null,
          isDirect: true,
        },
      ],
      exemptions: [],
      packuments: new Map(),
      releaseAgeMinutes: 30240,
      now,
    });

    expect(plan.actions.filter((a) => a.kind === 'no-fix')).toHaveLength(1);
  });
});

describe('formatPlanSummary', () => {
  it('formats an empty plan', () => {
    const plan = {
      timestamp: '2026-11-10T00:00:00.000Z',
      releaseAgeMinutes: 30240,
      releaseAgeDays: 21,
      advisoryCount: 0,
      actions: [],
      summary: {
        bump: 0,
        exempt: 0,
        noFix: 0,
        removeExemption: 0,
        removeOverride: 0,
        deadlineWarning: 0,
      },
    };
    const md = formatPlanSummary(plan, 'test');
    expect(md).toContain('# Dependency maintenance plan');
    expect(md).toContain('No actions needed.');
  });

  it('formats actions with all types', () => {
    const plan = {
      timestamp: '2026-11-10T00:00:00.000Z',
      releaseAgeMinutes: 30240,
      releaseAgeDays: 21,
      advisoryCount: 2,
      actions: [
        {
          kind: 'bump',
          ghsaId: 'GHSA-bump',
          package: 'pkg-a',
          version: '2.0.0',
          severity: 'high',
          isDirect: true,
          publishedAt: '2026-09-01T00:00:00Z',
        },
        {
          kind: 'remove-exemption',
          package: 'pkg-b',
          version: '1.5.0',
          publishedAt: '2026-09-15T00:00:00Z',
          agedOutAt: '2026-10-06T00:00:00Z',
        },
        {
          kind: 'deadline-warning',
          source: 'audit-ci',
          key: 'GHSA-test|path',
          expiry: '2026-11-12T00:00:00Z',
          daysLeft: 2,
        },
      ],
      summary: {
        bump: 1,
        exempt: 0,
        noFix: 0,
        removeExemption: 1,
        removeOverride: 0,
        deadlineWarning: 1,
      },
    };
    const md = formatPlanSummary(plan, 'Dependabot alerts API');
    expect(md).toContain('### Bump `pkg-a` to `2.0.0`');
    expect(md).toContain('### Remove exemption: `pkg-b@1.5.0`');
    expect(md).toContain('### Deadline warning: audit-ci');
    expect(md).toContain('2 days');
  });
});

// ---------------------------------------------------------------------------
// Consumer audit finding classification (fixtures from run 42786680563)
// ---------------------------------------------------------------------------

const FIXTURE_EXCEPTIONS = [
  {
    advisory: 'GHSA-c475-qrg2-pj4r',
    package: 'basic-ftp',
    versions: ['5.3.1'],
    path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
    owner: 'security/release maintainers',
    status: 'not_applicable',
    expiry: '2026-11-20T00:00:00Z',
    reason: 'Databricks uses plain HTTP/HTTPS agents; FTP/PAC cannot reach Client.list.',
    parentVersions: {
      '@databricks/sql': ['2.0.0', '2.2.0'],
    },
  },
  {
    advisory: 'GHSA-xcx6-jx8p-x3h5',
    package: '@azure/msal-node',
    versions: ['6.0.1'],
    path: 'snowflake-sdk>@azure/identity>@azure/msal-node',
    owner: 'security/release maintainers',
    status: 'not_applicable',
    expiry: '2026-11-05T00:00:00Z',
    reason: 'Authorization-code flow not used.',
    parentVersions: {
      'snowflake-sdk': ['3.4.0'],
      '@azure/identity': ['4.13.3', '4.14.0'],
    },
  },
];

describe('classifyConsumerFinding', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');

  it('identifies a stale exception when parentVersions mismatch', () => {
    const finding = {
      advisory: 'GHSA-c475-qrg2-pj4r',
      package: 'basic-ftp',
      version: '5.3.1',
      location: 'node_modules/basic-ftp',
      path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
      disposition: 'unhandled',
    };
    const result = classifyConsumerFinding(finding, FIXTURE_EXCEPTIONS, now);
    expect(result.classification).toBe('stale-exception');
    expect(result.exception.advisory).toBe('GHSA-c475-qrg2-pj4r');
  });

  it('identifies a new finding when no exception matches', () => {
    const finding = {
      advisory: 'GHSA-brand-new',
      package: 'unknown-pkg',
      version: '1.0.0',
      location: 'node_modules/unknown-pkg',
      path: 'unknown-pkg',
      disposition: 'unhandled',
    };
    const result = classifyConsumerFinding(finding, FIXTURE_EXCEPTIONS, now);
    expect(result.classification).toBe('new-finding');
  });

  it('does not match an expired exception', () => {
    const finding = {
      advisory: 'GHSA-xcx6-jx8p-x3h5',
      package: '@azure/msal-node',
      version: '6.0.1',
      location: 'node_modules/@azure/msal-node',
      path: 'snowflake-sdk>@azure/identity>@azure/msal-node',
      disposition: 'unhandled',
    };
    // Exception expires 2026-11-05, now is 2026-11-10
    const result = classifyConsumerFinding(finding, FIXTURE_EXCEPTIONS, now);
    expect(result.classification).toBe('new-finding');
  });

  it('matches when the finding path ends with the exception path', () => {
    const finding = {
      advisory: 'GHSA-c475-qrg2-pj4r',
      package: 'basic-ftp',
      version: '5.3.1',
      location: 'node_modules/basic-ftp',
      path: 'dogsled>@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
      disposition: 'unhandled',
    };
    const result = classifyConsumerFinding(finding, FIXTURE_EXCEPTIONS, now);
    expect(result.classification).toBe('stale-exception');
  });
});

describe('buildConsumerAuditActions', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');

  it('produces update-exception for stale and consumer-alert for new', () => {
    const findings = [
      {
        advisory: 'GHSA-c475-qrg2-pj4r',
        package: 'basic-ftp',
        version: '5.3.1',
        location: 'node_modules/basic-ftp',
        path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
        disposition: 'unhandled',
      },
      {
        advisory: 'GHSA-new-one',
        package: 'new-vuln',
        version: '1.0.0',
        location: 'node_modules/new-vuln',
        path: 'some-driver>new-vuln',
        disposition: 'unhandled',
      },
    ];
    const parentVersionMap = {
      'GHSA-c475-qrg2-pj4r:basic-ftp:5.3.1:@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp':
        { '@databricks/sql': '2.3.0' },
    };

    const actions = buildConsumerAuditActions(
      findings,
      parentVersionMap,
      FIXTURE_EXCEPTIONS,
      false,
      now
    );

    expect(actions).toHaveLength(2);

    const update = actions.find((a) => a.kind === 'update-exception');
    expect(update).toBeTruthy();
    expect(update.advisory).toBe('GHSA-c475-qrg2-pj4r');
    expect(update.newParentVersions['@databricks/sql'].actual).toBe('2.3.0');
    expect(update.newParentVersions['@databricks/sql'].reviewed).toEqual(['2.0.0', '2.2.0']);

    const alert = actions.find((a) => a.kind === 'consumer-alert');
    expect(alert).toBeTruthy();
    expect(alert.advisory).toBe('GHSA-new-one');
  });

  it('marks look-ahead findings', () => {
    const findings = [
      {
        advisory: 'GHSA-c475-qrg2-pj4r',
        package: 'basic-ftp',
        version: '5.3.1',
        location: 'node_modules/basic-ftp',
        path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
        disposition: 'unhandled',
      },
    ];
    const actions = buildConsumerAuditActions(findings, {}, FIXTURE_EXCEPTIONS, true, now);
    expect(actions[0].isLookahead).toBe(true);
  });

  it('deduplicates by advisory:package:version:path', () => {
    const finding = {
      advisory: 'GHSA-c475-qrg2-pj4r',
      package: 'basic-ftp',
      version: '5.3.1',
      location: 'node_modules/basic-ftp',
      path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
      disposition: 'unhandled',
    };
    const actions = buildConsumerAuditActions(
      [finding, finding],
      {},
      FIXTURE_EXCEPTIONS,
      false,
      now
    );
    expect(actions).toHaveLength(1);
  });

  it('skips non-unhandled findings', () => {
    const findings = [
      {
        advisory: 'GHSA-c475-qrg2-pj4r',
        package: 'basic-ftp',
        version: '5.3.1',
        disposition: 'not_applicable',
        path: 'x',
      },
    ];
    const actions = buildConsumerAuditActions(findings, {}, FIXTURE_EXCEPTIONS, false, now);
    expect(actions).toHaveLength(0);
  });
});
