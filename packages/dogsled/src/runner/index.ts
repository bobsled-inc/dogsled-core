import { Command } from 'commander';

import { registerRunCommand } from './commands/run.js';
import { registerRunnerValidateCommand } from './commands/validate.js';

export function createRunnerGroup(): Command {
  const runner = new Command('runner');
  runner.description('Validate and run Dogsled pipelines');
  registerRunnerValidateCommand(runner);
  registerRunCommand(runner);
  return runner;
}
