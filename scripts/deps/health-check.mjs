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
import {
  buildHuskyInstruction,
  findExpiredExemptions,
  findUpcomingDeadlines,
  formatHealthReport,
} from './planner.mjs';

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

const CHANNEL_ID_RE = /^[A-Z0-9]+$/;

async function sendSlackAlerts({ expiredExemptions, deadlines, consumerFindings }) {
  const botToken = process.env.SLACK_BOT_TOKEN || '';
  const channelId =
    process.env.SLACK_HEALTH_CHANNEL_ID || process.env.SLACK_RELEASE_CHANNEL_ID || '';
  const huskyId = process.env.HUSKY_SLACK_USER_ID || null;

  const allFindings = [...expiredExemptions, ...deadlines, ...consumerFindings];
  if (allFindings.length === 0) return;

  if (!botToken) {
    process.stdout.write('SLACK_BOT_TOKEN is not set; skipping Slack notifications.\n');
    return;
  }
  if (!CHANNEL_ID_RE.test(channelId)) {
    process.stdout.write('SLACK_HEALTH_CHANNEL_ID / SLACK_RELEASE_CHANNEL_ID is not configured.\n');
    return;
  }

  let sent = 0;
  for (const finding of allFindings) {
    const text = buildHuskyInstruction(finding, huskyId);
    if (!text) continue;
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        process.stdout.write(`Slack rejected message: ${result.error}\n`);
      } else {
        sent++;
      }
    } catch (error) {
      process.stdout.write(`Slack message failed: ${error.message}\n`);
    }
  }
  process.stdout.write(`Sent ${sent} Slack message(s).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
