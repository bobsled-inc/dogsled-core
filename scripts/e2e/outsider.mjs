import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, root } from './harness.mjs';
import { postgres, postgresContainerName, stopServices } from './services.mjs';

// A pg release that predates the locked one, so a project that already has it
// proves Dogsled shares the project's driver instead of nesting its own.
export const USER_PG_VERSION = '8.16.3';

export async function releaseAgeCutoff(now = Date.now()) {
  const workspace = parseYaml(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
  if (!Number.isFinite(workspace.minimumReleaseAge) || workspace.minimumReleaseAge <= 0) {
    throw new Error('The outsider check requires the workspace release-age policy.');
  }
  return new Date(now - workspace.minimumReleaseAge * 60_000).toISOString();
}

export async function runOutsider({ auditOnly = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dogsled-outsider-'));
  const containerName = `dogsled-e2e-outsider-${randomUUID()}`;
  const imageName = containerName;
  try {
    const { stageBobsledPackage } = await import('../release/stage-package.mjs');
    const stage = path.join(directory, 'stage');
    const pack = path.join(directory, 'pack');
    await mkdir(pack);
    stageBobsledPackage(stage, { build: false });
    await command('pnpm', ['--config.node-linker=hoisted', 'pack', '--pack-destination', pack], {
      cwd: stage,
      timeout: 180_000,
    });
    const tarballs = (await readdir(pack)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('Expected exactly one CLI tarball');
    const context = path.join(directory, 'context');
    await mkdir(path.join(context, 'suite/examples'), { recursive: true });
    await cp(path.join(pack, tarballs[0]), path.join(context, 'dogsled.tgz'));
    await cp(path.join(root, 'scripts/e2e'), path.join(context, 'suite/scripts/e2e'), {
      recursive: true,
    });
    for (const entry of await readdir(path.join(root, 'examples'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(path.join(root, 'examples', entry.name, 'showcase.mjs'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await cp(
        path.join(root, 'examples', entry.name),
        path.join(context, 'suite/examples', entry.name),
        { recursive: true }
      );
    }
    await cp(path.join(root, 'scripts/e2e/outsider.Dockerfile'), path.join(context, 'Dockerfile'));
    await cp(
      path.join(root, 'scripts/e2e/inside-outsider.sh'),
      path.join(context, 'inside-outsider.sh')
    );
    process.stdout.write('Building and running a clean outsider image (expected 3–8 minutes).\n');
    await postgres();
    const container = postgresContainerName();
    if (!container) throw new Error('Outsider launcher requires its task-owned Postgres container');
    const results = path.join(root, 'test-results/e2e/outsider');
    await mkdir(results, { recursive: true });
    await cp(path.join(pack, tarballs[0]), path.join(results, 'dogsled.tgz'));
    const build = await command(
      'docker',
      [
        'build',
        '--progress=plain',
        '--build-arg',
        `BOBSLED_CORE_E2E_BEFORE=${await releaseAgeCutoff()}`,
        '--build-arg',
        `BOBSLED_CORE_E2E_USER_PG_VERSION=${USER_PG_VERSION}`,
        '--tag',
        imageName,
        context,
      ],
      { timeout: 600_000 }
    );
    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      `container:${container}`,
      '--volume',
      `${results}:/evidence`,
      '--env',
      'BOBSLED_CORE_E2E_POSTGRES_PORT=5432',
      imageName,
    ];
    if (auditOnly) args.push('S24');
    await command('docker', args, { timeout: 900_000, stream: true });
  } finally {
    await command('docker', ['rm', '--force', containerName], { expected: null });
    await stopServices();
    await command('docker', ['image', 'rm', imageName], { expected: null });
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await runOutsider();
