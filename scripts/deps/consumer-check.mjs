#!/usr/bin/env node

/**
 * Consumer audit wrapper for the daily release health check.
 *
 * Builds the packed tarball, runs the consumer audit at the current cutoff
 * and again with a 3-day look-ahead, classifies unhandled findings as
 * stale-exception or new-finding, and writes results to the output directory.
 *
 * Usage:
 *   node scripts/deps/consumer-check.mjs --output /tmp/health-check [--lookahead-days 3]
 *
 * The output directory receives:
 *   consumer-findings.json   Classified findings array
 *   consumer-report.json     Audit pass/fail summary
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { auditPackedConsumers } from '../security/consumer-audit.mjs';
import { explainPaths, validateConsumerExceptions } from '../security/consumer-policy.mjs';
import { stageBobsledPackage } from '../release/stage-package.mjs';
import { repoRoot } from '../security/lib.mjs';
import { classifyConsumerFindings } from './health-findings.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const { values: flags } = parseArgs({
  options: {
    output: { type: 'string', default: '/tmp/health-check' },
    'lookahead-days': { type: 'string', default: '3' },
  },
  strict: false,
});

const lookaheadDays = Number(flags['lookahead-days']);
const outputDir = flags.output;

async function main() {
  mkdirSync(outputDir, { recursive: true });

  // --- Build the packed tarball ---
  process.stdout.write('Staging and packing the Dogsled tarball...\n');
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), 'health-check-stage-'));
  const stageDir = path.join(stageRoot, 'package');
  let tarball;
  try {
    stageBobsledPackage(stageDir);
    const tarballDir = path.join(stageRoot, 'tarballs');
    mkdirSync(tarballDir, { recursive: true });
    const packOutput = execFileSync('npm', ['pack', '--pack-destination', tarballDir], {
      cwd: stageDir,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    tarball = path.join(tarballDir, packOutput.trim().split(/\r?\n/).at(-1));
    process.stdout.write(`Packed: ${tarball}\n`);
  } catch (error) {
    process.stderr.write(`Tarball build failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const exceptions = validateConsumerExceptions(
    JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
    )
  );

  // --- Current audit ---
  process.stdout.write('Running consumer audit (current cutoff)...\n');
  const currentReport = await auditPackedConsumers({
    tarball,
    outputDir: path.join(outputDir, 'consumer-current'),
    repoRoot,
  });

  // --- Look-ahead audit ---
  const lookaheadNow = Date.now() + lookaheadDays * DAY_MS;
  process.stdout.write(
    `Running consumer audit (${lookaheadDays}-day look-ahead, cutoff as of ${new Date(lookaheadNow).toISOString()})...\n`
  );
  let lookaheadReport;
  try {
    lookaheadReport = await auditPackedConsumers({
      tarball,
      outputDir: path.join(outputDir, 'consumer-lookahead'),
      repoRoot,
      now: lookaheadNow,
    });
  } catch (error) {
    process.stdout.write(`Look-ahead audit failed (non-blocking): ${error.message}\n`);
    lookaheadReport = { passed: true, results: [] };
  }

  rmSync(stageRoot, { recursive: true, force: true });

  // --- Classify findings ---
  const now = Date.now();
  const allFindings = [];

  for (const result of currentReport.results) {
    const unhandled = result.findings.filter((f) => f.disposition === 'unhandled');
    if (unhandled.length === 0) continue;
    const parentVersionMap = buildParentVersionMap(
      unhandled,
      path.join(outputDir, 'consumer-current', result.mode)
    );
    allFindings.push(
      ...classifyConsumerFindings(unhandled, parentVersionMap, exceptions, false, now)
    );
  }

  for (const result of lookaheadReport.results) {
    const unhandled = result.findings.filter((f) => f.disposition === 'unhandled');
    if (unhandled.length === 0) continue;
    const parentVersionMap = buildParentVersionMap(
      unhandled,
      path.join(outputDir, 'consumer-lookahead', result.mode)
    );
    allFindings.push(
      ...classifyConsumerFindings(unhandled, parentVersionMap, exceptions, true, now)
    );
  }

  // --- Write results ---
  writeFileSync(
    path.join(outputDir, 'consumer-findings.json'),
    JSON.stringify(allFindings, null, 2)
  );
  writeFileSync(
    path.join(outputDir, 'consumer-report.json'),
    JSON.stringify(
      {
        current: {
          passed: currentReport.passed,
          resultCount: currentReport.results.length,
        },
        lookahead: {
          passed: lookaheadReport.passed,
          resultCount: lookaheadReport.results.length,
        },
        findings: allFindings.length,
      },
      null,
      2
    )
  );

  const stale = allFindings.filter((f) => f.kind === 'stale-exception').length;
  const newCount = allFindings.filter((f) => f.kind === 'new-finding').length;
  process.stdout.write(
    `Consumer audit complete: ${allFindings.length} finding(s) (${stale} stale, ${newCount} new).\n`
  );

  // B2: exit 0 after writing findings. health-check.mjs owns the job failure.
  if (!currentReport.passed) {
    process.stdout.write(
      'Current consumer audit has unhandled findings (health-check will report them).\n'
    );
  }
}

/**
 * Extract actual parent versions from the explanations evidence for each
 * unhandled finding.
 */
function buildParentVersionMap(findings, evidenceDir) {
  const map = {};
  try {
    const explanations = JSON.parse(
      readFileSync(path.join(evidenceDir, 'explanations.json'), 'utf8')
    );
    for (const finding of findings) {
      const explanation = explanations[finding.location];
      if (!explanation?.length) continue;
      for (const node of explanation) {
        if (node.location !== finding.location) continue;
        const paths = explainPaths([node], finding.package, true);
        const match = paths.find((p) => p.path === finding.path);
        if (match) {
          const key = `${finding.advisory}:${finding.package}:${finding.version}:${finding.path}`;
          map[key] = match.versions;
          break;
        }
      }
    }
  } catch (error) {
    process.stdout.write(`Could not read explanations from ${evidenceDir}: ${error.message}\n`);
  }
  return map;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
