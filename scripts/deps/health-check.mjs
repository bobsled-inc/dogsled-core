#!/usr/bin/env node

/**
 * Daily release health check.
 *
 * Reads expiry data, consumer audit findings, builds a health report in the
 * Husky contract schema, uploads it as an artifact, and POSTs it to Husky
 * via OIDC. Fails the job when findings exist.
 *
 * Usage:
 *   node scripts/deps/health-check.mjs [--output /tmp/health-check]
 *
 * Environment:
 *   HUSKY_ORIGIN                     Base URL for Husky (skip POST when unset)
 *   ACTIONS_ID_TOKEN_REQUEST_URL     GitHub Actions OIDC endpoint
 *   ACTIONS_ID_TOKEN_REQUEST_TOKEN   GitHub Actions OIDC request token
 *   GITHUB_RUN_ID                    Current workflow run ID
 *   GITHUB_SERVER_URL                GitHub server URL
 *   GITHUB_REPOSITORY                owner/repo
 *   GITHUB_STEP_SUMMARY              Path to write the step summary
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { collectExpiryDates } from '../security/expiry-dates.mjs';
import { buildContractFindings, validateFinding } from './health-findings.mjs';

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

  const now = Date.now();

  // --- Expiry data (reuse #58's collectExpiryDates) ---
  process.stdout.write('Collecting expiry dates...\n');
  const expiries = collectExpiryDates(repoRoot, now);
  const expired = expiries.filter((e) => e.status === 'expired' || e.status === 'warning');
  const deadlines = expiries.filter((e) => e.daysLeft > 0 && e.daysLeft <= 7);
  process.stdout.write(
    `Expiries: ${expired.length} expired/warning, ${deadlines.length} within 7 days\n`
  );

  // --- Consumer findings (written by consumer-check.mjs) ---
  // B2: a missing findings file is an error, not zero findings. The consumer
  // audit must have run and written the file even when it found nothing.
  let consumerResults = [];
  const consumerFindingsPath = path.join(outputDir, 'consumer-findings.json');
  if (existsSync(consumerFindingsPath)) {
    consumerResults = JSON.parse(readFileSync(consumerFindingsPath, 'utf8'));
    process.stdout.write(`Consumer findings: ${consumerResults.length}\n`);
  } else {
    process.stderr.write(
      'consumer-findings.json is missing: the consumer audit did not complete.\n'
    );
    process.exitCode = 1;
    return;
  }

  // --- Build contract findings ---
  const { findings, dropped, truncated } = buildContractFindings(expiries, consumerResults);
  process.stdout.write(
    `Contract findings: ${findings.length} valid` +
      (dropped > 0 ? `, ${dropped} dropped (failed validation)` : '') +
      '\n'
  );

  // S3: fail if entries were dropped
  if (dropped > 0) {
    process.stderr.write(`${dropped} finding(s) failed validation and were dropped.\n`);
  }

  // --- Build the report ---
  const repo = process.env.GITHUB_REPOSITORY ?? 'bobsled-inc/dogsled-core';
  const runId = Number(process.env.GITHUB_RUN_ID) || 0;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '';

  const report = {
    schemaVersion: 1,
    product: 'dogsled-core',
    runId,
    runUrl,
    findings,
    truncated,
  };

  const reportPath = path.join(outputDir, 'health-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`Report written to ${reportPath}\n`);

  // --- Step summary (L3: include dropped count and truncation) ---
  const summary = formatStepSummary(report, dropped);
  process.stdout.write('\n');
  process.stdout.write(summary);
  process.stdout.write('\n');

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, summary, { flag: 'a' });
  }

  // The report job handles OIDC and Husky POST (S1: separate job, no
  // third-party code near the token). This script only writes the file.

  // --- Fail on findings or drops ---
  if (findings.length > 0 || dropped > 0) {
    process.stdout.write(
      `\nHealth check failed: ${findings.length} finding(s)${dropped > 0 ? `, ${dropped} dropped` : ''}.\n`
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('\nHealth check passed.\n');
  }
}

function formatStepSummary(report, dropped = 0) {
  const lines = [];
  lines.push('# Daily release health check');
  lines.push('');

  if (report.findings.length === 0 && dropped === 0) {
    lines.push('All checks passed. No findings.');
    return lines.join('\n');
  }

  const parts = [`**${report.findings.length} finding(s)**`];
  if (dropped > 0) parts.push(`${dropped} dropped (failed validation)`);
  if (report.truncated) parts.push('truncated to 50');
  lines.push(`${parts.join(', ')}.`);
  lines.push('');
  lines.push('| Kind | Package | Details |');
  lines.push('| --- | --- | --- |');

  const today = new Date().toISOString().split('T')[0];

  for (const f of report.findings) {
    switch (f.kind) {
      case 'stale_parent':
        lines.push(
          `| stale_parent | \`${f.package}@${f.version}\` | Add \`${f.parentPackage}@${f.parentVersion}\` to parentVersions (${f.advisory}) |`
        );
        break;
      case 'expired_exemption':
        lines.push(
          `| expired_exemption | \`${f.package}@${f.version}\` | Remove from \`${f.file}\` |`
        );
        break;
      case 'deadline_soon': {
        const isPast = f.due < today;
        const label = f.package ? `\`${f.package}\`` : (f.advisory ?? '');
        const timing = isPast ? `expired ${f.due}` : `due ${f.due}`;
        lines.push(`| deadline_soon | ${label} | ${f.advisory ?? ''} ${timing} in \`${f.file}\` |`);
        break;
      }
      case 'new_finding':
        lines.push(
          `| new_finding | \`${f.package}@${f.version}\` | ${f.advisory} (${f.severity}) |`
        );
        break;
    }
  }

  if (dropped > 0) {
    lines.push('');
    lines.push(
      `> **Warning:** ${dropped} finding(s) failed validation and were dropped from the report.`
    );
  }

  lines.push('');
  return lines.join('\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
