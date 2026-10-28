import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseArgs } from './lib.mjs';

const args = parseArgs();
if (!args.export) throw new Error('Pass --export <directory>.');
const exportDir = path.resolve(args.export);
const outputDir = mkdtempSync(path.join(path.dirname(exportDir), '.gitleaks-'));
chmodSync(outputDir, 0o777);
const reportPath = path.join(outputDir, 'gitleaks.json');
writeFileSync(reportPath, '[]\n', { mode: 0o666 });
chmodSync(reportPath, 0o666);

try {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${exportDir}:/repo:ro`,
      '-v',
      `${outputDir}:/out:rw`,
      'zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
      'dir',
      '/repo',
      '--config',
      '/repo/.gitleaks.toml',
      '--report-format',
      'json',
      '--report-path',
      '/out/gitleaks.json',
      '--no-banner',
      '--redact=100',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    }
  );
  process.stderr.write(result.stderr ?? result.error?.message ?? '');
  process.stdout.write(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '[]\n');
  process.exitCode = result.status ?? 2;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
