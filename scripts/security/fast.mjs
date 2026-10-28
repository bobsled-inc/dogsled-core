import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { executablePath, repoRoot } from './lib.mjs';

const node = process.execPath;
const checks = [
  {
    name: 'repository security policy',
    command: node,
    args: [path.join(repoRoot, 'scripts/security/policy.mjs')],
  },
];

let failed = false;
for (const check of checks) {
  const command = check.command.includes(path.sep) ? check.command : executablePath(check.command);
  const result = spawnSync(command, check.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`security:fast failed: ${check.name}\n`);
  }
}

if (!failed) {
  process.stdout.write('Security fast policy checks passed.\n');
} else {
  process.exitCode = 1;
}
