import { Command } from 'commander';

import {
  runSkillConfigure,
  runSkillList,
  runSkillShow,
  runSkillSync,
  runSkillValidate,
  type SkillConfigureOptions,
  type SkillOutputOptions,
  type SkillValidateOptions,
} from '../commands/skill.js';

import type { GlobalOptions } from '../types/index.js';

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function addOutputOptions(command: Command): Command {
  return command.option('--yaml', 'Emit YAML output');
}

export function createSkillGroup(): Command {
  const group = new Command('skill')
    .description('Inspect and configure Project Skills')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)');

  addOutputOptions(group.command('list').description('List validated Project Skills')).action(
    async (options: SkillOutputOptions, command: Command) => {
      const globals = globalOptions(command);
      await runSkillList(options, globals);
    }
  );

  addOutputOptions(
    group.command('show <name>').description('Show one validated Project Skill')
  ).action(async (name: string, options: SkillOutputOptions, command: Command) => {
    const globals = globalOptions(command);
    await runSkillShow(name, options, globals);
  });

  addOutputOptions(
    group
      .command('validate [name]')
      .description('Validate Project Skills and their references')
      .option('--no-guide', 'Skip Project guide validation')
  ).action(async (name: string | undefined, options: SkillValidateOptions, command: Command) => {
    const globals = globalOptions(command);
    await runSkillValidate(name, options, globals);
  });

  addOutputOptions(
    group
      .command('configure')
      .description('Configure Codex and Claude Project Skill discovery')
      .option('--copy', 'Create managed copies instead of relative links')
  ).action(async (options: SkillConfigureOptions, command: Command) => {
    const globals = globalOptions(command);
    await runSkillConfigure(options, globals);
  });

  addOutputOptions(
    group.command('sync').description('Refresh and check Project Skill discovery adapters')
  ).action(async (options: SkillOutputOptions, command: Command) => {
    const globals = globalOptions(command);
    await runSkillSync(options, globals);
  });

  return group;
}
