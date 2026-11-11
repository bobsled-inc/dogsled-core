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
import { buildContractFindings, validateFinding } from './planner.mjs';

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
  let consumerResults = [];
  const consumerFindingsPath = path.join(outputDir, 'consumer-findings.json');
  if (existsSync(consumerFindingsPath)) {
    consumerResults = JSON.parse(readFileSync(consumerFindingsPath, 'utf8'));
    process.stdout.write(`Consumer findings: ${consumerResults.length}\n`);
  }

  // --- Build contract findings ---
  const findings = buildContractFindings(expiries, consumerResults);
  process.stdout.write(`Contract findings: ${findings.length} (all validated)\n`);

  // Double-check: every finding must pass validation
  const valid = findings.every((f) => validateFinding(f) !== null);
  if (!valid) {
    process.stderr.write('Internal error: a finding failed validation after construction.\n');
    process.exitCode = 1;
    return;
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
  };

  const reportPath = path.join(outputDir, 'health-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`Report written to ${reportPath}\n`);

  // --- Step summary ---
  const summary = formatStepSummary(report);
  process.stdout.write('\n');
  process.stdout.write(summary);
  process.stdout.write('\n');

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, summary, { flag: 'a' });
  }

  // --- POST to Husky ---
  const huskyOrigin = process.env.HUSKY_ORIGIN || '';
  if (huskyOrigin && findings.length > 0) {
    await postToHusky(huskyOrigin, report);
  } else if (!huskyOrigin && findings.length > 0) {
    process.stdout.write('HUSKY_ORIGIN is not set; skipping Husky notification.\n');
  }

  // --- Fail on findings ---
  if (findings.length > 0) {
    process.stdout.write(`\nHealth check failed: ${findings.length} finding(s).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nHealth check passed.\n');
  }
}

async function postToHusky(huskyOrigin, report) {
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!oidcUrl || !oidcToken) {
    process.stdout.write('OIDC token request variables not available; skipping Husky POST.\n');
    return;
  }

  try {
    // Request OIDC token with audience "husky"
    const tokenResponse = await fetch(`${oidcUrl}&audience=husky`, {
      headers: { Authorization: `bearer ${oidcToken}` },
    });
    if (!tokenResponse.ok) {
      process.stdout.write(`OIDC token request failed: ${tokenResponse.status}\n`);
      return;
    }
    const { value: idToken } = await tokenResponse.json();

    // POST report to Husky
    const response = await fetch(`${huskyOrigin}/api/health/report`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(report),
    });
    if (response.ok) {
      process.stdout.write('Report sent to Husky.\n');
    } else {
      const text = await response.text().catch(() => '');
      process.stdout.write(`Husky responded ${response.status}: ${text}\n`);
    }
  } catch (error) {
    process.stdout.write(`Husky POST failed: ${error.message}\n`);
  }
}

function formatStepSummary(report) {
  const lines = [];
  lines.push('# Daily release health check');
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('All checks passed. No findings.');
    return lines.join('\n');
  }

  lines.push(`**${report.findings.length} finding(s)** reported to Husky.`);
  lines.push('');
  lines.push('| Kind | Package | Details |');
  lines.push('| --- | --- | --- |');

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
      case 'deadline_soon':
        lines.push(
          `| deadline_soon | \`${f.package}\` | ${f.advisory ?? ''} due ${f.due} in \`${f.file}\` |`
        );
        break;
      case 'new_finding':
        lines.push(
          `| new_finding | \`${f.package}@${f.version}\` | ${f.advisory} (${f.severity}) |`
        );
        break;
    }
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
