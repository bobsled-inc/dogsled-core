#!/usr/bin/env node

/**
 * CLI entry point for the dependency maintenance bot.
 *
 * Usage:
 *   node scripts/deps/run.mjs [--mode off|dry-run|on] [--source alerts|audit]
 *
 * Environment:
 *   DEPS_BOT          off | dry-run | on (overridden by --mode)
 *   GITHUB_TOKEN      For Dependabot alerts and PR creation
 *   GITHUB_REPOSITORY owner/repo
 *   GITHUB_STEP_SUMMARY  Path to write the step summary
 *   SLACK_DEPS_WEBHOOK_URL  Optional Slack incoming webhook
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildPlan, formatPlanSummary, normalizeAlerts, normalizeAuditReport } from './planner.mjs';
import {
  fetchDependabotAlerts,
  fetchPackument,
  readAuditCiConfig,
  readConsumerExceptions,
  readWorkspaceConfig,
  runPnpmAudit,
} from './io.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const { values: flags } = parseArgs({
  options: {
    mode: { type: 'string', default: process.env.DEPS_BOT ?? 'dry-run' },
    source: { type: 'string', default: 'auto' },
  },
  strict: false,
});

const mode = flags.mode;
if (mode === 'off') {
  process.stdout.write('DEPS_BOT is off; exiting.\n');
  process.exit(0);
}

async function main() {
  const config = readWorkspaceConfig(repoRoot);
  const auditCiAllowlist = readAuditCiConfig(repoRoot);
  const consumerExceptions = readConsumerExceptions(repoRoot);

  process.stdout.write(
    `Release-age policy: ${config.releaseAgeMinutes} minutes (${Math.round(config.releaseAgeMinutes / 60 / 24)} days)\n`
  );
  process.stdout.write(`Exemptions: ${config.exemptions.length}\n`);
  process.stdout.write(`Overrides: ${Object.keys(config.overrides).length}\n`);

  let advisories = [];
  let advisorySource = 'none';

  const token = process.env.GITHUB_TOKEN ?? null;
  const repo = process.env.GITHUB_REPOSITORY ?? 'bobsled-inc/dogsled-core';
  const [owner, repoName] = repo.split('/');

  if (flags.source !== 'audit' && token) {
    try {
      process.stdout.write('Fetching Dependabot alerts...\n');
      const alerts = await fetchDependabotAlerts(owner, repoName, token);
      advisories = normalizeAlerts(alerts);
      advisorySource = 'Dependabot alerts API';
      process.stdout.write(`Found ${advisories.length} open advisory/advisories.\n`);
    } catch (error) {
      process.stdout.write(`Dependabot alerts unavailable: ${error.message}\n`);
      process.stdout.write('Falling back to pnpm audit.\n');
    }
  }

  if (advisories.length === 0 && flags.source !== 'alerts') {
    try {
      process.stdout.write('Running pnpm audit...\n');
      const auditJson = runPnpmAudit(repoRoot);
      const packageNames = new Set();
      if (auditJson?.advisories) {
        for (const a of Object.values(auditJson.advisories)) {
          if (a.module_name) packageNames.add(a.module_name);
        }
      }
      if (auditJson?.vulnerabilities) {
        for (const name of Object.keys(auditJson.vulnerabilities)) packageNames.add(name);
      }

      const packuments = new Map();
      for (const name of packageNames) {
        try {
          packuments.set(name, await fetchPackument(name));
        } catch {
          process.stdout.write(`Could not fetch packument for ${name}; skipping.\n`);
        }
      }

      advisories = normalizeAuditReport(auditJson, packuments);
      advisorySource = 'pnpm audit (fallback)';
      process.stdout.write(`Found ${advisories.length} advisory/advisories from pnpm audit.\n`);
    } catch (error) {
      process.stdout.write(`pnpm audit failed: ${error.message}\n`);
      advisorySource = 'none (both sources failed)';
    }
  }

  const exemptionPackageNames = new Set(config.exemptions.map((e) => e.name));
  const allPackageNames = new Set([...advisories.map((a) => a.package), ...exemptionPackageNames]);

  process.stdout.write(`Fetching packuments for ${allPackageNames.size} package(s)...\n`);
  const packuments = new Map();
  for (const name of allPackageNames) {
    try {
      packuments.set(name, await fetchPackument(name));
    } catch {
      process.stdout.write(`Could not fetch packument for ${name}; skipping.\n`);
    }
  }

  const plan = buildPlan({
    advisories,
    exemptions: config.exemptions,
    packuments,
    releaseAgeMinutes: config.releaseAgeMinutes,
    auditCiAllowlist,
    consumerExceptions,
    now: Date.now(),
  });

  const summary = formatPlanSummary(plan, advisorySource);
  process.stdout.write('\n');
  process.stdout.write(summary);
  process.stdout.write('\n');

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, summary, { flag: 'a' });
  }

  if (mode === 'dry-run') {
    process.stdout.write('\nDry-run mode: no PRs will be created.\n');
    process.stdout.write(JSON.stringify(plan, null, 2));
    process.stdout.write('\n');
    return;
  }

  if (mode === 'on') {
    process.stdout.write('\nLive mode: PR creation would happen here.\n');
    process.stdout.write(
      'PR creation requires the GitHub App token and is handled by the workflow.\n'
    );

    const slackUrl = process.env.SLACK_DEPS_WEBHOOK_URL;
    const noFixActions = plan.actions.filter((a) => a.kind === 'no-fix');
    const deadlineActions = plan.actions.filter((a) => a.kind === 'deadline-warning');

    if (slackUrl && (noFixActions.length > 0 || deadlineActions.length > 0)) {
      const slackLines = ['*Dependency maintenance bot*\n'];
      for (const a of noFixActions) {
        slackLines.push(
          `No fix available for \`${a.package}\` (${a.ghsaId}, ${a.severity}): ${a.reason}`
        );
      }
      for (const a of deadlineActions) {
        slackLines.push(
          `Deadline in ${a.daysLeft} day(s): ${a.source} ${a.advisory ?? a.key ?? ''} expires ${a.expiry}`
        );
      }
      try {
        await fetch(slackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: slackLines.join('\n') }),
        });
        process.stdout.write('Slack notification sent.\n');
      } catch (error) {
        process.stdout.write(`Slack notification failed: ${error.message}\n`);
      }
    } else if (!slackUrl && (noFixActions.length > 0 || deadlineActions.length > 0)) {
      process.stdout.write('SLACK_DEPS_WEBHOOK_URL is not set; skipping Slack notification.\n');
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
