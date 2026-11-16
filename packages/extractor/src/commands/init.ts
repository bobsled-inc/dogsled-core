/**
 * `dogsled extract init` command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import type { Command } from 'commander';

import { DEFAULT_CONFIG } from '../config.js';
import { ControlLogger } from '../runtime/control.js';

import { CommandError, SAFE_NAME_RE, parseGlobalFlags } from './common.js';

async function writeIfAbsent(
  filePath: string,
  content: string,
  label: string,
  logger: ControlLogger
): Promise<void> {
  if (fs.existsSync(filePath)) {
    await logger.warn(`${label} already exists, skipping`);
    return;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new extractor project')
    .argument('[directory]', 'Directory to create', '.')
    .option('--integration <name>', 'Name for the example integration', 'example_api')
    .action(async (directory: string, opts: { integration: string }) => {
      const logger = new ControlLogger(parseGlobalFlags(program.opts()));

      try {
        if (!SAFE_NAME_RE.test(opts.integration)) {
          throw new CommandError(
            `Invalid integration name "${opts.integration}". Must be lowercase snake_case (e.g. my_api).`
          );
        }

        const cwd = process.env['INIT_CWD'] ?? process.cwd();
        const targetDir = path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
        if (!targetDir.startsWith(`${cwd}${path.sep}`) && targetDir !== cwd) {
          await logger.warn(
            `Target directory "${targetDir}" is outside the current working directory.`
          );
        }

        const integrationsDir = path.join(targetDir, 'integrations');
        const resourceDir = path.join(targetDir, 'resources', opts.integration);
        fs.mkdirSync(integrationsDir, { recursive: true });
        fs.mkdirSync(resourceDir, { recursive: true });

        await writeIfAbsent(
          path.join(targetDir, 'extractor.yml'),
          YAML.stringify(DEFAULT_CONFIG),
          'extractor.yml',
          logger
        );

        const integrationSpec = {
          spec_version: '1',
          type: 'integration',
          name: opts.integration,
          description: 'Example HTTPS integration',
          auth_env_vars: ['EXAMPLE_API_TOKEN'],
          transport: {
            base_url: 'https://api.example.com',
            auth: {
              type: 'bearer',
              token: '${{ env.EXAMPLE_API_TOKEN }}',
            },
            timeout_ms: 30_000,
            retry: {
              retry_on: [429, 503],
              max_retries: 3,
              backoff: 'exponential',
              retry_after_header: true,
            },
            rate_limit: {
              requests_per_second: 10,
              burst: 20,
            },
            headers: {
              Accept: 'application/json',
              'User-Agent': 'bobsled-core-extractor/0.1',
            },
          },
        };
        await writeIfAbsent(
          path.join(integrationsDir, `${opts.integration}.yml`),
          YAML.stringify(integrationSpec),
          `integrations/${opts.integration}.yml`,
          logger
        );

        const resourceSpec = {
          spec_version: '1',
          type: 'resource',
          name: 'items',
          integration: opts.integration,
          description: 'Extract items from the example API',
          api: {
            endpoint: '/items',
            method: 'GET',
            query_params: {
              per_page: '${{ input.per_page }}',
            },
          },
          input: {
            per_page: {
              type: 'integer',
              default: 100,
            },
          },
          output: {
            id: {
              type: 'integer',
              path: '$.id',
            },
            name: {
              type: 'string',
              path: '$.name',
            },
            created_at: {
              type: 'timestamp',
              path: '$.created_at',
            },
            updated_at: {
              type: 'timestamp',
              path: '$.updated_at',
            },
          },
          extract: {
            record_path: '$',
            pagination: {
              type: 'link_header',
            },
            incremental: {
              cursor_field: 'updated_at',
              cursor_param: 'since',
            },
            table: {
              primary_key: ['id'],
            },
          },
          lookup: {
            description: 'Fetch a single item by id',
            api: {
              endpoint: '/items/${{ input.id }}',
              method: 'GET',
            },
            input: {
              id: {
                type: 'string',
                required: true,
              },
            },
          },
        };
        await writeIfAbsent(
          path.join(resourceDir, 'items.yml'),
          YAML.stringify(resourceSpec),
          `resources/${opts.integration}/items.yml`,
          logger
        );

        const gitignorePath = path.join(targetDir, '.gitignore');
        const gitignoreEntries = ['.extractor/', 'output/'];
        const existing = fs.existsSync(gitignorePath)
          ? fs.readFileSync(gitignorePath, 'utf-8')
          : '';
        const newEntries = gitignoreEntries.filter((entry) => !existing.includes(entry));
        if (newEntries.length > 0) {
          const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
          fs.appendFileSync(gitignorePath, `${suffix}${newEntries.join('\n')}\n`, 'utf-8');
        }

        await logger.info(`Initialized extractor project in ${targetDir}`);
        await logger.info(`Integration: integrations/${opts.integration}.yml`);
        await logger.info(`Resource: resources/${opts.integration}/items.yml`);
        await logger.info('Config: extractor.yml');
        await logger.info(
          'Next steps: edit the integration/resource specs, set EXAMPLE_API_TOKEN, validate, then run extraction.'
        );
      } finally {
        await logger.close();
      }
    });
}
