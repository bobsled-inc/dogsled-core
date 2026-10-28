import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseArgs, readJson, resolveRunDir, sha256File, writeJson } from './lib.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args);
const runPath = path.join(runDir, 'run.json');
const normalizedPath = path.join(runDir, 'normalized.json');
const violations = [];

if (!existsSync(runPath)) violations.push('run.json is missing');
if (!existsSync(normalizedPath)) violations.push('normalized.json is missing');

let run;
let normalized;
if (violations.length === 0) {
  run = readJson(runPath);
  normalized = readJson(normalizedPath);
  if (run.runId !== normalized.runId) violations.push('run identifiers do not match');
  if (run.repositoryCommit !== normalized.repositoryCommit) {
    violations.push('repository commits do not match');
  }

  for (const [stageName, stage] of Object.entries(normalized.stages)) {
    if (stage.status !== 'complete' && args['allow-incomplete'] !== true) {
      violations.push(`${stageName} stage is incomplete`);
    }
    for (const command of stage.commands) {
      const stdoutPath = path.join(runDir, 'raw', command.stdoutPath);
      const stderrPath = path.join(runDir, 'raw', command.stderrPath);
      if (!existsSync(stdoutPath) || !existsSync(stderrPath)) {
        violations.push(`${stageName}/${command.id} is missing raw evidence`);
        continue;
      }
      if (
        sha256File(stdoutPath) !== command.stdoutSha256 ||
        sha256File(stderrPath) !== command.stderrSha256
      ) {
        violations.push(`${stageName}/${command.id} evidence checksum does not match`);
      }
      if (command.parseStatus !== 'parsed' && args['allow-incomplete'] !== true) {
        violations.push(`${stageName}/${command.id} output was not parsed`);
      }
    }
  }

  for (const finding of normalized.findings) {
    if (finding.classification === 'false_positive' && !finding.codexRationale.trim()) {
      violations.push(`${finding.fingerprint} is dismissed without Codex rationale`);
    }
    if (
      ['accepted', 'not_applicable'].includes(finding.disposition) &&
      !finding.codexRationale.trim()
    ) {
      violations.push(
        `${finding.fingerprint} has disposition ${finding.disposition} without rationale`
      );
    }
    if (finding.disposition === 'fixed' && finding.verification.length === 0) {
      violations.push(`${finding.fingerprint} is fixed without verification evidence`);
    }
  }
}

const result = {
  schemaVersion: 1,
  runId: run?.runId ?? null,
  verified: violations.length === 0,
  violations,
};
writeJson(path.join(runDir, 'verification.json'), result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (violations.length > 0) process.exitCode = 1;
