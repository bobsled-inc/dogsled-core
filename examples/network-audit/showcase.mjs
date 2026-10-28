import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cliPath, command, isolatedEnv, root } from '../../scripts/e2e/harness.mjs';
import { postgres } from '../../scripts/e2e/services.mjs';
export const id = 'S24';
export async function run(ctx) {
  if (process.platform !== 'linux') {
    const { runOutsider } = await import('../../scripts/e2e/outsider.mjs');
    await runOutsider({ auditOnly: true });
    return;
  }
  const port = await postgres();
  const trace = path.join(ctx.project, 'network.trace');
  const preparationHome = path.join(ctx.project, 'extension-home');
  const auditHome = path.join(ctx.project, 'audit-home');
  await mkdir(preparationHome, { recursive: true });
  await command(process.execPath, [path.join(root, 'scripts/e2e/prepare-extensions.mjs')], {
    cwd: ctx.project,
    env: isolatedEnv(preparationHome, { DOGSLED_E2E_CLI: cliPath }),
    timeout: 240_000,
  });
  await cp(path.join(preparationHome, '.duckdb'), path.join(auditHome, '.duckdb'), {
    recursive: true,
  });
  const env = isolatedEnv(auditHome, {
    DOGSLED_E2E_HOME: auditHome,
    DOGSLED_E2E_CLI: cliPath,
    DOGSLED_E2E_POSTGRES_PORT: String(port),
  });
  await command(
    'strace',
    [
      '-f',
      '--seccomp-bpf',
      '-qq',
      '-e',
      'trace=connect,sendto,sendmsg',
      '-s',
      '256',
      '-o',
      trace,
      process.execPath,
      path.join(root, 'scripts/e2e/run.mjs'),
      'S01',
      'S03',
      'S14',
    ],
    { env, timeout: 240_000 }
  );
  const text = await readFile(trace, 'utf8');
  const addresses = [
    ...text.matchAll(/(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)")/g),
  ].map((match) => match[1] ?? match[2]);
  assert.ok(addresses.length > 0, 'Audit must observe real socket operations');
  const unexpected = [
    ...new Set(
      addresses.filter((address) => !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
    ),
  ];
  assert.deepEqual(unexpected, [], 'Toolkit contacted an unconfigured address');
  const evidence =
    process.env.DOGSLED_E2E_OUTSIDER === '1' ? '/evidence' : path.join(root, 'test-results/e2e');
  await mkdir(evidence, { recursive: true });
  await cp(trace, path.join(evidence, 'network-audit.trace'));
  await writeFile(
    path.join(evidence, 'network-audit.json'),
    JSON.stringify(
      {
        status: 'PASS',
        scenarios: ['S01', 'S03', 'S14'],
        connections: addresses.length,
        addresses: [...new Set(addresses)],
      },
      null,
      2
    ) + '\n'
  );
}
