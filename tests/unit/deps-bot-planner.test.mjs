import { describe, expect, it } from 'vitest';

import {
  classifyConsumerFinding,
  classifyConsumerFindings,
  findExpiredExemptions,
  findUpcomingDeadlines,
  formatHealthReport,
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

// ---------------------------------------------------------------------------
// Expiry detection
// ---------------------------------------------------------------------------

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
    const results = findExpiredExemptions(exemptions, packuments, 30240, now);

    expect(results).toHaveLength(1);
    expect(results[0].package).toBe('fast-uri');
    expect(results[0].kind).toBe('expired-exemption');
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

// ---------------------------------------------------------------------------
// Deadline detection
// ---------------------------------------------------------------------------

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
    const results = findUpcomingDeadlines(allowlist, [], 7, now);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('deadline-warning');
    expect(results[0].source).toBe('audit-ci');
    expect(results[0].daysLeft).toBe(3);
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
    const results = findUpcomingDeadlines([], exceptions, 7, now);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('consumer-exception');
  });

  it('ignores entries outside the warning window', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const allowlist = [{ key: { expiry: '2026-11-05T00:00:00Z' } }];
    expect(findUpcomingDeadlines(allowlist, [], 7, now)).toHaveLength(0);
  });

  it('ignores already-expired entries', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    const exceptions = [
      {
        advisory: 'GHSA-xxx',
        package: 'x',
        expiry: '2026-11-01T00:00:00Z',
      },
    ];
    expect(findUpcomingDeadlines([], exceptions, 7, now)).toHaveLength(0);
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

describe('classifyConsumerFindings', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');

  it('produces stale-exception and new-finding', () => {
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

    const results = classifyConsumerFindings(
      findings,
      parentVersionMap,
      FIXTURE_EXCEPTIONS,
      false,
      now
    );

    expect(results).toHaveLength(2);

    const stale = results.find((r) => r.kind === 'stale-exception');
    expect(stale).toBeTruthy();
    expect(stale.advisory).toBe('GHSA-c475-qrg2-pj4r');
    expect(stale.staleParents['@databricks/sql'].actual).toBe('2.3.0');
    expect(stale.staleParents['@databricks/sql'].reviewed).toEqual(['2.0.0', '2.2.0']);

    const newFinding = results.find((r) => r.kind === 'new-finding');
    expect(newFinding).toBeTruthy();
    expect(newFinding.advisory).toBe('GHSA-new-one');
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
    const results = classifyConsumerFindings(findings, {}, FIXTURE_EXCEPTIONS, true, now);
    expect(results[0].isLookahead).toBe(true);
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
    const results = classifyConsumerFindings(
      [finding, finding],
      {},
      FIXTURE_EXCEPTIONS,
      false,
      now
    );
    expect(results).toHaveLength(1);
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
    const results = classifyConsumerFindings(findings, {}, FIXTURE_EXCEPTIONS, false, now);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Health report formatting
// ---------------------------------------------------------------------------

describe('formatHealthReport', () => {
  it('formats a clean report', () => {
    const md = formatHealthReport({
      timestamp: '2026-11-10T06:17:00.000Z',
      releaseAgeMinutes: 30240,
      expiredExemptions: [],
      deadlines: [],
      consumerFindings: [],
      consumerPassed: true,
      lookaheadPassed: true,
    });
    expect(md).toContain('# Daily release health check');
    expect(md).toContain('All checks passed');
  });

  it('formats expired exemptions', () => {
    const md = formatHealthReport({
      timestamp: '2026-11-10T06:17:00.000Z',
      releaseAgeMinutes: 30240,
      expiredExemptions: [
        {
          kind: 'expired-exemption',
          package: 'fast-uri',
          version: '3.1.9',
          publishedAt: '2026-10-19T23:05:26Z',
          agedOutAt: '2026-11-09T23:05:26Z',
        },
      ],
      deadlines: [],
      consumerFindings: [],
      consumerPassed: true,
      lookaheadPassed: true,
    });
    expect(md).toContain('**1 expired**');
    expect(md).toContain('fast-uri@3.1.9');
  });

  it('formats stale exceptions with exact instructions', () => {
    const md = formatHealthReport({
      timestamp: '2026-11-10T06:17:00.000Z',
      releaseAgeMinutes: 30240,
      expiredExemptions: [],
      deadlines: [],
      consumerFindings: [
        {
          kind: 'stale-exception',
          advisory: 'GHSA-c475-qrg2-pj4r',
          package: 'basic-ftp',
          version: '5.3.1',
          path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
          staleParents: {
            '@databricks/sql': {
              reviewed: ['2.0.0', '2.2.0'],
              actual: '2.3.0',
            },
          },
          isLookahead: false,
        },
      ],
      consumerPassed: false,
      lookaheadPassed: true,
    });
    expect(md).toContain('Stale consumer exceptions');
    expect(md).toContain('add `"2.3.0"`');
    expect(md).toContain('consumer-exceptions.json');
  });

  it('formats new findings', () => {
    const md = formatHealthReport({
      timestamp: '2026-11-10T06:17:00.000Z',
      releaseAgeMinutes: 30240,
      expiredExemptions: [],
      deadlines: [],
      consumerFindings: [
        {
          kind: 'new-finding',
          advisory: 'GHSA-new',
          package: 'vuln-pkg',
          version: '1.0.0',
          path: 'driver>vuln-pkg',
          isLookahead: false,
        },
      ],
      consumerPassed: false,
      lookaheadPassed: true,
    });
    expect(md).toContain('New consumer audit findings');
    expect(md).toContain('GHSA-new');
  });

  it('formats deadlines', () => {
    const md = formatHealthReport({
      timestamp: '2026-11-10T06:17:00.000Z',
      releaseAgeMinutes: 10080,
      expiredExemptions: [],
      deadlines: [
        {
          kind: 'deadline-warning',
          source: 'consumer-exception',
          advisory: 'GHSA-test',
          package: 'pkg',
          expiry: '2026-11-15T00:00:00Z',
          daysLeft: 5,
        },
      ],
      consumerFindings: [],
      consumerPassed: true,
      lookaheadPassed: true,
    });
    expect(md).toContain('Approaching deadlines');
    expect(md).toContain('5 days');
  });
});
