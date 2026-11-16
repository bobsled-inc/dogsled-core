import { Command } from 'commander';
import YAML from 'yaml';

function explicitRootJson(command: Command): boolean {
  let root = command;
  while (root.parent) root = root.parent;
  return root !== command && root.getOptionValueSource('json') === 'cli';
}

export function createIntegrationsGroup(): Command {
  const group = new Command('integrations');

  group.description('Browse and scaffold from the integration library');

  group
    .command('list')
    .description('List all known integrations')
    .option('--category <category>', 'Filter by category')
    .option('--type <type>', 'Filter by type: api, mcp, db, or all', 'all')
    .option('--json', 'Output as JSON')
    .action(
      async (opts: { category?: string; type?: string; json?: boolean }, command: Command) => {
        const json = opts.json === true || explicitRootJson(command);
        const { listIntegrations } = await import('@bobsled-inc/integrations');
        let integrations = listIntegrations();

        if (opts.category) {
          integrations = integrations.filter((p) => p.category === opts.category);
        }

        if (opts.type && opts.type !== 'all') {
          integrations = integrations.filter((p) => p.integration_type === opts.type);
        }

        if (json) {
          process.stdout.write(JSON.stringify(integrations, null, 2) + '\n');
          return;
        }

        if (integrations.length === 0) {
          process.stdout.write('No integrations found.\n');
          return;
        }

        const maxName = integrations.reduce((max, p) => Math.max(max, p.name.length), 0);
        const maxCat = integrations.reduce((max, p) => Math.max(max, p.category.length), 0);
        const maxType = integrations.reduce(
          (max, p) => Math.max(max, p.integration_type.length),
          0
        );

        for (const p of integrations) {
          process.stdout.write(
            `  ${p.name.padEnd(maxName + 2)} ${p.integration_type.padEnd(maxType + 2)} ${p.category.padEnd(maxCat + 2)} ${p.resource_count} resources\n`
          );
        }
      }
    );

  group
    .command('show <integration> [resource]')
    .description('Show integration details or a specific resource spec')
    .option('--json', 'Output as JSON')
    .option('--yaml', 'Output as YAML')
    .action(
      async (
        integrationName: string,
        resourceName: string | undefined,
        opts: { json?: boolean; yaml?: boolean },
        command: Command
      ) => {
        const json = opts.json === true || explicitRootJson(command);
        const { getIntegration, getResource, getResources, listActions } =
          await import('@bobsled-inc/integrations');

        if (resourceName) {
          const res = getResource(integrationName, resourceName);
          if (opts.yaml) {
            process.stdout.write(YAML.stringify(res.resource, { lineWidth: 120 }).trimEnd() + '\n');
            return;
          }
          if (json) {
            process.stdout.write(JSON.stringify(res.resource, null, 2) + '\n');
          } else {
            process.stdout.write(`Resource: ${res.resource.name}\n`);
            process.stdout.write(`Integration: ${res.integration_name}\n`);
            process.stdout.write(`Description: ${res.resource.description ?? ''}\n`);
            if ('api' in res.resource && res.resource.api) {
              process.stdout.write(
                `Endpoint: ${res.resource.api.method} ${res.resource.api.endpoint}\n`
              );
            }
            if ('tool' in res.resource && res.resource.tool) {
              process.stdout.write(`Tool: ${res.resource.tool.tool_name}\n`);
            }
            process.stdout.write(`Output fields: ${Object.keys(res.resource.output).join(', ')}\n`);
          }
          return;
        }

        const integration = getIntegration(integrationName);
        const resources = getResources(integrationName);
        const actions = listActions(integrationName).map((action) => ({
          name: action.qualifiedName,
          description: action.description,
          transport: action.transport,
          tags: action.tags,
          required_inputs: Object.entries(action.inputs)
            .filter(([, value]) => value.required)
            .map(([key]) => key),
        }));
        const payload = {
          spec: integration.spec,
          meta: integration.meta,
          resources: resources.map((r) => r.resource),
          action_count: actions.length,
          actions,
        };

        if (opts.yaml) {
          process.stdout.write(YAML.stringify(payload, { lineWidth: 120 }).trimEnd() + '\n');
          return;
        }
        if (json) {
          process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
          return;
        }

        process.stdout.write(`\n${integration.meta.display_name}\n`);
        process.stdout.write(`${'─'.repeat(integration.meta.display_name.length)}\n`);
        process.stdout.write(`Category: ${integration.meta.category}\n`);
        process.stdout.write(`Tags: ${integration.meta.tags.join(', ')}\n`);
        process.stdout.write(`Docs: ${integration.meta.docs_url}\n`);
        process.stdout.write(`\nResources:\n`);
        for (const res of resources) {
          process.stdout.write(
            `  ${res.resource.name.padEnd(20)} ${res.resource.description ?? ''}\n`
          );
        }
        process.stdout.write(`\nAuth setup:\n`);
        for (const auth of integration.meta.auth_setup ?? []) {
          process.stdout.write(`  ${auth.env} — ${auth.description}\n`);
        }
        process.stdout.write('\n');
      }
    );

  group
    .command('init <integration>')
    .description('Scaffold project from a library integration')
    .option('--resources <names>', 'Comma-separated resource names to include')
    .option('--directory <dir>', 'Target directory', '.')
    .action(async (integrationName: string, opts: { resources?: string; directory: string }) => {
      const { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } =
        await import('node:fs');
      const { join } = await import('node:path');
      const { getIntegration, getResource, getIntegrationsDir } =
        await import('@bobsled-inc/integrations');

      const integration = getIntegration(integrationName);
      const targetDir = opts.directory;

      // Determine which resources to copy (getResource validates names for path traversal)
      let resourceNames = integration.resource_names;
      if (opts.resources) {
        resourceNames = opts.resources.split(',').map((r) => r.trim());
        // Validate each resource name exists (also checks for path traversal)
        for (const name of resourceNames) {
          getResource(integrationName, name);
        }
      }

      // Create target directories
      const integrationsDir = join(targetDir, 'integrations');
      const resourcesDir = join(targetDir, 'resources', integrationName);
      mkdirSync(integrationsDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });

      // Copy integration spec (skip if already exists)
      const srcIntegrationPath = join(getIntegrationsDir(), integrationName, 'source.yml');
      const destIntegrationPath = join(integrationsDir, `${integrationName}.yml`);
      if (existsSync(destIntegrationPath)) {
        process.stderr.write(`  Skipped ${destIntegrationPath} (already exists)\n`);
      } else {
        const document = YAML.parseDocument(readFileSync(srcIntegrationPath, 'utf8'));
        document.set('auth_env_vars', integration.spec.auth_env_vars ?? []);
        writeFileSync(destIntegrationPath, document.toString());
        process.stdout.write(`  Created ${destIntegrationPath}\n`);
      }

      // Copy resource files
      for (const resourceName of resourceNames) {
        const srcPath = join(
          getIntegrationsDir(),
          integrationName,
          'resources',
          `${resourceName}.yml`
        );
        if (!existsSync(srcPath)) {
          process.stderr.write(`  Warning: resource ${resourceName} not found, skipping\n`);
          continue;
        }
        const destPath = join(resourcesDir, `${resourceName}.yml`);
        if (existsSync(destPath)) {
          process.stderr.write(`  Skipped ${destPath} (already exists)\n`);
          continue;
        }
        copyFileSync(srcPath, destPath);
        process.stdout.write(`  Created ${destPath}\n`);
      }

      // Print auth setup instructions
      process.stdout.write(`\nRequired environment variables:\n`);
      for (const auth of integration.meta.auth_setup ?? []) {
        process.stdout.write(`  ${auth.env} — ${auth.description}\n`);
        if (auth.docs_url) {
          process.stdout.write(`    See: ${auth.docs_url}\n`);
        }
      }
      process.stdout.write('\n');
    });

  return group;
}
