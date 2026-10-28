import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFinding, redactText, repoRoot } from './lib.mjs';

const candidates = [
  { scope: 'repository', path: path.join(repoRoot, '.npmrc') },
  { scope: 'user', path: path.join(os.homedir(), '.npmrc') },
].filter((entry) => existsSync(entry.path));

const findings = [];
const inspected = [];
for (const candidate of candidates) {
  const content = readFileSync(candidate.path, 'utf8');
  const keys = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')).trim());
  inspected.push({
    scope: candidate.scope,
    path: candidate.scope === 'user' ? '<home>/.npmrc' : '.npmrc',
    keys,
  });

  for (const key of keys) {
    const privateRegistry = /pkg\.dev\/bobsled|bobsled-registry/i.test(key);
    const credentialKey = /(?:_authToken|_password|username|always-auth)$/i.test(key);
    if (candidate.scope === 'user' && privateRegistry && credentialKey) {
      findings.push(
        createFinding({
          tool: 'npm-config-audit',
          rule: 'stale-user-private-registry-auth',
          severity: 'medium',
          message:
            'User npm configuration retains authentication for the retired private registry.',
          evidence: `Configuration key ${redactText(key)} exists in <home>/.npmrc; its value was not read into the report.`,
          location: { path: '<home>/.npmrc' },
          classification: 'confirmed',
          disposition: 'deferred',
          confidence: 'high',
          reachability: 'local maintainer environment',
          recommendation:
            'Revoke or rotate the credential, then remove the stale npm configuration keys.',
          effort: 'small',
          humanDecision:
            'Confirm credential revocation and local configuration removal before promotion.',
        })
      );
    }
    if (candidate.scope === 'repository' && credentialKey) {
      findings.push(
        createFinding({
          tool: 'npm-config-audit',
          rule: 'repository-npm-credential',
          severity: 'high',
          message: 'Repository npm configuration declares a credential-bearing key.',
          evidence: `Configuration key ${redactText(key)} exists; its value was not read into the report.`,
          location: { path: '.npmrc' },
          recommendation: 'Remove credentials from repository configuration.',
        })
      );
    }
  }
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, inspected, findings }, null, 2)}\n`);
if (findings.some((finding) => finding.severity === 'P1')) process.exitCode = 1;
