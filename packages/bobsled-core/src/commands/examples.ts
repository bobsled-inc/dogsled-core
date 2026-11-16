import { tutorials } from '../runtime/onboarding/tutorials.js';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

export function getExamplesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // Bundled CLI: dist/index.js. Source tests/dev: src/commands/examples.ts.
  const roots = [resolve(dirname(thisFile), '..'), resolve(dirname(thisFile), '../..')];
  const packageRoot = roots.find((root) => existsSync(join(root, 'examples'))) ?? roots[0]!;
  return join(packageRoot, 'examples');
}

function listAvailableExamples(): string[] {
  const dir = getExamplesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function copyExample(name: string, targetDir: string): void {
  const examplesDir = getExamplesDir();
  const sourceDir = join(examplesDir, name);

  if (!existsSync(sourceDir)) {
    const available = listAvailableExamples();
    const list = available.length > 0 ? available.join(', ') : '(none found)';
    throw new Error(`Unknown example "${name}". Available: ${list}`);
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    // Keep teaching templates in the package, not in the learner's working project.
    filter: (source) =>
      !tutorials.some((tutorial) => tutorial.example === name) ||
      source !== join(sourceDir, 'reference'),
  });
  makeScriptsExecutable(targetDir);
}

export function makeScriptsExecutable(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) makeScriptsExecutable(entryPath);
    else if (entry.isFile() && entry.name.endsWith('.sh')) chmodSync(entryPath, 0o755);
  }
}

const ENV_HINTS: Record<string, string> = {
  github: "GITHUB_TOKEN='<your-token>'",
  slack: "SLACK_BOT_TOKEN='xoxb-<your-token>'",
  notion: "NOTION_API_TOKEN='ntn_<your-token>'",
  linear: "LINEAR_API_KEY='lin_api_<your-key>'",
  s3_documents: "S3_BUCKET='<your-bucket>'",
  gcs_documents: "GCS_BUCKET='<your-bucket>'",
};

export function exampleNextSteps(targetDir: string, displayDir: string): string[] {
  const integrations = listIntegrations(targetDir).filter((name) => ENV_HINTS[name]);
  const steps = [`cd ${displayDir}`];
  if (existsSync(join(targetDir, 'walkthrough.sh'))) {
    steps.push(...integrations.map((name) => `export ${ENV_HINTS[name]}`), './walkthrough.sh');
  } else {
    for (const name of integrations) {
      steps.push(`export ${ENV_HINTS[name]}`, `dogsled extract validate ${name}`);
    }
  }
  if (existsSync(join(targetDir, 'models'))) {
    steps.push('dogsled model validate', 'dogsled model compile -o ./compiled');
  }
  steps.push('See README.md for the full walkthrough.');
  return steps;
}

function listIntegrations(exampleDir: string): string[] {
  const integrationsDir = join(exampleDir, 'integrations');
  if (!existsSync(integrationsDir)) return [];
  return readdirSync(integrationsDir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => f.replace('.yml', ''))
    .sort();
}

export function registerExamplesCommand(program: Command): void {
  const cmd = program.command('examples').description('List or scaffold bundled example projects');

  cmd
    .command('list')
    .description('List available example projects')
    .action(() => {
      const examples = listAvailableExamples();
      if (examples.length === 0) {
        process.stdout.write('No bundled examples found.\n');
        return;
      }

      for (const name of examples) {
        const exampleDir = join(getExamplesDir(), name);
        const integrations = listIntegrations(exampleDir);
        const integrationList = integrations.length > 0 ? ` (${integrations.join(', ')})` : '';
        process.stdout.write(`  ${name}${integrationList}\n`);
      }

      process.stdout.write(`\nScaffold with: dogsled examples init <name>\n`);
    });

  cmd
    .command('init <name>')
    .description('Copy an example project into the current directory')
    .option('-d, --dir <path>', 'Target directory (default: ./<name>)')
    .action((name: string, opts: { dir?: string }) => {
      const targetDir = resolve(opts.dir ?? name);

      if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
        throw new Error(`Directory "${targetDir}" already exists and is not empty`);
      }

      copyExample(name, targetDir);

      const integrations = listIntegrations(targetDir);
      process.stdout.write(`Scaffolded "${name}" example → ${targetDir}\n`);
      process.stdout.write(`Integrations: ${integrations.join(', ')}\n`);

      process.stdout.write(`\nNext steps:\n`);
      for (const step of exampleNextSteps(targetDir, opts.dir ?? name)) {
        process.stdout.write(`  ${step}\n`);
      }
    });
}
