#!/usr/bin/env node

/**
 * Daily release health check.
 *
 * Reads workspace config and consumer audit results, checks for expired
 * exemptions and approaching deadlines, classifies consumer findings,
 * writes a step summary, sends Slack alerts, and fails the job when
 * something is unhandled or expired.
 *
 * Usage:
 *   node scripts/deps/health-check.mjs [--output /tmp/health-check]
 *
 * Environment:
 *   RELEASE_HEALTH          off | on (default off)
 *   GITHUB_STEP_SUMMARY     Path to write the step summary
 *   SLACK_DEPS_WEBHOOK_URL  Optional Slack incoming webhook
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

import { parseReleaseAgeExemptions } from '../security/consumer-policy.mjs';
import { findExpiredExemptions, findUpcomingDeadlines, formatHealthReport } from './planner.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const { values: flags } = parseArgs({
  options: {
    output: { type: 'string', default: '/tmp/health-check' },
  },
  strict: false,
});

async function main() {
  const outputDir = flags.output;
  mkdirSync(outputDir, { recursive: true });

  // --- Read workspace config ---
  const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const releaseAgeMinutes = workspace.minimumReleaseAge;
  const exemptions = parseReleaseAgeExemptions(workspace.minimumReleaseAgeExclude);

  process.stdout.write(
    `Release-age policy: ${releaseAgeMinutes} minutes (${Math.round(releaseAgeMinutes / 60 / 24)} days)\n`
  );
  process.stdout.write(`Exemptions: ${exemptions.length}\n`);

  // --- Read audit-ci and consumer exceptions ---
  const auditCiConfig = JSON.parse(readFileSync(path.join(repoRoot, 'audit-ci.json'), 'utf8'));
  const auditCiAllowlist = auditCiConfig.allowlist ?? [];

  const consumerExceptions = JSON.parse(
    readFileSync(path.join(repoRoot, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
  );

  // --- Fetch packuments for exemption age checks ---
  const exemptionPackageNames = new Set(exemptions.map((e) => e.name));
  process.stdout.write(
    `Fetching packuments for ${exemptionPackageNames.size} exemption package(s)...\n`
  );
  const packuments = new Map();
  for (const name of exemptionPackageNames) {
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) packuments.set(name, await response.json());
    } catch {
      process.stdout.write(`Could not fetch packument for ${name}; skipping.\n`);
    }
  }

  // --- Check expiries and deadlines ---
  const now = Date.now();
  const expiredExemptions = findExpiredExemptions(exemptions, packuments, releaseAgeMinutes, now);
  const deadlines = findUpcomingDeadlines(auditCiAllowlist, consumerExceptions, 7, now);

  // --- Read consumer findings (written by consumer-check.mjs) ---
  let consumerFindings = [];
  let consumerPassed = true;
  let lookaheadPassed = true;
  const consumerFindingsPath = path.join(outputDir, 'consumer-findings.json');
  const consumerReportPath = path.join(outputDir, 'consumer-report.json');

  if (existsSync(consumerFindingsPath)) {
    consumerFindings = JSON.parse(readFileSync(consumerFindingsPath, 'utf8'));
    process.stdout.write(
      `Consumer findings: ${consumerFindings.length} (${consumerFindings.filter((f) => f.kind === 'stale-exception').length} stale, ${consumerFindings.filter((f) => f.kind === 'new-finding').length} new)\n`
    );
  }
  if (existsSync(consumerReportPath)) {
    const report = JSON.parse(readFileSync(consumerReportPath, 'utf8'));
    consumerPassed = report.current?.passed ?? true;
    lookaheadPassed = report.lookahead?.passed ?? true;
  }

  // --- Build and write the report ---
  const report = formatHealthReport({
    timestamp: new Date(now).toISOString(),
    releaseAgeMinutes,
    expiredExemptions,
    deadlines,
    consumerFindings,
    consumerPassed,
    lookaheadPassed,
  });

  process.stdout.write('\n');
  process.stdout.write(report);
  process.stdout.write('\n');

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, report, { flag: 'a' });
  }

  writeFileSync(
    path.join(outputDir, 'health-report.json'),
    JSON.stringify(
      {
        timestamp: new Date(now).toISOString(),
        expiredExemptions,
        deadlines,
        consumerFindings,
        consumerPassed,
        lookaheadPassed,
      },
      null,
      2
    )
  );

  // --- Slack alerts ---
  await sendSlackAlerts({
    expiredExemptions,
    deadlines,
    consumerFindings,
    consumerPassed,
  });

  // --- Fail if anything is unhandled or expired ---
  const hasFailures =
    expiredExemptions.length > 0 ||
    !consumerPassed ||
    consumerFindings.some((f) => f.kind === 'new-finding' && !f.isLookahead);

  if (hasFailures) {
    process.stdout.write('\nHealth check failed: see findings above.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\nHealth check passed.\n');
  }
}

async function sendSlackAlerts({ expiredExemptions, deadlines, consumerFindings, consumerPassed }) {
  const slackUrl = process.env.SLACK_DEPS_WEBHOOK_URL;
  const stale = consumerFindings.filter((f) => f.kind === 'stale-exception');
  const newFindings = consumerFindings.filter((f) => f.kind === 'new-finding');

  const hasAlerts =
    expiredExemptions.length > 0 ||
    deadlines.length > 0 ||
    stale.length > 0 ||
    newFindings.length > 0;

  if (!hasAlerts) return;

  if (!slackUrl) {
    process.stdout.write('SLACK_DEPS_WEBHOOK_URL is not set; skipping Slack notification.\n');
    return;
  }

  const lines = ['*Daily release health check*\n'];

  for (const e of expiredExemptions) {
    lines.push(`Expired exemption: \`${e.package}@${e.version}\` (aged out ${e.agedOutAt})`);
  }

  for (const d of deadlines) {
    const label = d.advisory ?? d.key ?? '';
    lines.push(`Deadline in ${d.daysLeft}d: ${d.source} ${label} expires ${d.expiry}`);
  }

  for (const s of stale) {
    const prefix = s.isLookahead ? '(look-ahead) ' : '';
    const parents = Object.entries(s.staleParents)
      .map(
        ([parent, info]) =>
          `add \`"${info.actual}"\` to \`${parent}\` (reviewed: ${info.reviewed.join(', ')})`
      )
      .join('; ');
    lines.push(`${prefix}Stale exception: \`${s.package}\` (${s.advisory}) — ${parents}`);
  }

  for (const f of newFindings) {
    const prefix = f.isLookahead ? '(look-ahead) ' : '';
    lines.push(`${prefix}New consumer finding: \`${f.package}\` ${f.advisory} via \`${f.path}\``);
  }

  try {
    await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
    process.stdout.write('Slack notification sent.\n');
  } catch (error) {
    process.stdout.write(`Slack notification failed: ${error.message}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
