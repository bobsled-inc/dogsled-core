/**
 * `model test` command — thin CLI wrapper over `testProject`.
 *
 * Test SQL generation lives in `../api/test-project.ts`. This file owns only
 * arg parsing and stdout formatting.
 */

import type { Command } from 'commander';

import { testProject } from '../api/test-project.js';
import * as out from '../output.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

interface TestOptions {
  integration?: string;
}

async function testHandler(
  modelNames: string[],
  localOptions: TestOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);

  const result = await testProject(process.cwd(), {
    integration: localOptions.integration,
    models: modelNames,
  });

  for (const w of result.warnings) out.warn(w);
  for (const s of result.skipped) out.warn(s.message);

  const multi = result.byIntegration.length > 1;
  let totalTests = 0;

  for (const group of result.byIntegration) {
    if (multi) {
      process.stdout.write(`-- integration: ${group.handle}\n`);
    }
    for (const t of group.tests) {
      process.stdout.write(`-- ${t.modelName}: ${t.testName}\n${t.sql}\n\n`);
      totalTests++;
    }
  }

  if (!flags.quiet) out.success(`Generated ${totalTests} test(s).`);
}

export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description('Generate test SQL from model test definitions')
    .argument('[model...]', 'Model names to test (default: all)')
    .addOption(createIntegrationOption())
    .action(async (modelNames: string[], opts: TestOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await testHandler(modelNames, opts, globalOptions);
    });
}
