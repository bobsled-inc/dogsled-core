#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { out } from '@bobsled-inc/model-spec/shared';

import { registerActivateCommand } from './commands/activate.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerAuditCommand } from './commands/audit.js';
import { registerBuildCommand } from './commands/build.js';
import { registerDiffCommand } from './commands/diff.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerFixturesCommand } from './commands/fixtures.js';
import { registerForgetCommand } from './commands/forget.js';
import { registerLineageCommand } from './commands/lineage.js';
import { registerGetCommand, registerMatchCommand } from './commands/match.js';
import { registerMentionsCommand } from './commands/mentions.js';
import { registerObjectCommand } from './commands/object.js';
import { registerPiiCommand } from './commands/pii.js';
import { registerPolicyCommand } from './commands/policy.js';
import { registerQuickstartCommand } from './commands/quickstart.js';
import { registerRelateCommand } from './commands/relate.js';
import { registerRelationshipsCommand } from './commands/relationships.js';
import { registerResolveCommand } from './commands/resolve.js';
import { registerReviewCommand } from './commands/review.js';
import { registerScaffoldCommand } from './commands/scaffold.js';
import { registerServeCommand } from './commands/serve.js';
import { registerSuggestCommand } from './commands/suggest.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSurvivorshipCommand } from './commands/survivorship.js';
import { registerTruthsetCommand } from './commands/truthset.js';

declare const __CLI_VERSION__: string | undefined;

export function buildProgram(): Command {
  const program = new Command();
  const cliVersion =
    typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__.trim().length > 0
      ? __CLI_VERSION__
      : '0.0.1';

  program
    .name('bobsled entity-graph')
    .version(cliVersion)
    .description('Bobsled Core Entity Graph — identity, review, survivorship, and trust workflows')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output');

  registerActivateCommand(program);
  registerAgentCommand(program);
  registerAuditCommand(program);
  registerBuildCommand(program);
  registerDiffCommand(program);
  registerExplainCommand(program);
  registerFixturesCommand(program);
  registerForgetCommand(program);
  registerGetCommand(program);
  registerLineageCommand(program);
  registerMatchCommand(program);
  registerMentionsCommand(program);
  registerRelationshipsCommand(program);
  registerRelateCommand(program);
  registerObjectCommand(program);
  registerPiiCommand(program);
  registerPolicyCommand(program);
  registerQuickstartCommand(program);
  registerResolveCommand(program);
  registerReviewCommand(program);
  registerScaffoldCommand(program);
  registerServeCommand(program);
  registerSuggestCommand(program);
  registerStatusCommand(program);
  registerSurvivorshipCommand(program);
  registerTruthsetCommand(program);

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await buildProgram().parseAsync();
  } catch (err) {
    if (err instanceof CommandError) {
      out.error(err.message);
      process.exitCode = err.exitCode;
    } else if (err instanceof Error) {
      out.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
