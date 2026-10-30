import { getTutorial, resolveTutorial, requireStep } from '../runtime/onboarding/tutorials.js';
import { getExamplesDir } from './examples.js';
import { reviewChapter } from '../runtime/onboarding/journal.js';
import { getSkill } from '@bobsled-inc/skills';
import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { CommandError } from '@bobsled-inc/protocol';
import type { GlobalOptions } from '../types/index.js';
import * as fmt from '../lib/output/formatter.js';
import { StepId } from '../runtime/onboarding/schema.js';
import { inspectOnboarding, writeArtifact } from '../runtime/onboarding/state.js';
import { buildOnboardingSnapshot } from '../runtime/onboarding/snapshot.js';
import { renderOnboardingHtml } from '../runtime/onboarding/render.js';
import { verifyOnboarding } from '../runtime/onboarding/verify.js';

export function registerOnboardingCommand(program: Command): void {
  const group = program
    .command('onboarding')
    .description('Inspect tutorial progress and render its local data explorer');
  for (const action of ['guide', 'status', 'render', 'verify <step>', 'review <step>']) {
    const subcommand = group
      .command(action)
      .description(
        action.startsWith('review')
          ? 'Record that the learner inspected current chapter evidence'
          : action.startsWith('verify')
            ? 'Run bounded data checks and save evidence for a step'
            : action === 'guide'
              ? 'Read the bundled agent walkthrough'
              : action === 'render'
                ? 'Write the local HTML explorer'
                : 'Show saved chapter progress and check results'
      )
      .option('--yaml', 'Emit YAML output')
      .option('--tutorial <id>', 'Choose a bundled tutorial');
    if (action.startsWith('review')) {
      subcommand.option('--checkpoint <sha256>', 'Only review the evidence shown in a saved page');
    }
    if (action.startsWith('verify')) {
      subcommand.option(
        '--show-id <id>',
        'Check one transformation result without completing the chapter'
      );
    }
    subcommand.action(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const options = command.optsWithGlobals<
        GlobalOptions & { yaml?: boolean; tutorial?: string; showId?: string; checkpoint?: string }
      >();
      const output = fmt.toOutputOptions(options);
      try {
        const root = resolve(options.projectRoot ?? process.cwd());
        const tutorial =
          action === 'guide' ? getTutorial(options.tutorial) : await resolveTutorial(root);
        if (options.tutorial && options.tutorial !== tutorial.id) {
          throw new CommandError('The requested tutorial does not match this project.', 2);
        }
        let result: unknown;
        if (action === 'guide') {
          result = {
            ...getSkill(tutorial.skill),
            templatesPath: join(getExamplesDir(), tutorial.example, 'reference'),
          };
        } else if (action.startsWith('review')) {
          result = await reviewChapter(root, StepId.parse(args[0]), options.checkpoint, tutorial);
        } else if (action.startsWith('verify')) {
          const step = StepId.safeParse(args[0]);
          if (!step.success) {
            throw new CommandError(
              `Choose ${tutorial.steps.map((step) => step.id).join(', ')}.`,
              2
            );
          }
          requireStep(tutorial, step.data);
          result = await verifyOnboarding(
            root,
            step.data,
            undefined,
            options.showId === undefined
              ? {}
              : { showId: /^\d+$/.test(options.showId) ? Number(options.showId) : NaN },
            tutorial
          );
        } else if (action === 'status') result = await inspectOnboarding(root, tutorial);
        else {
          const snapshot = await buildOnboardingSnapshot(root, tutorial);
          result = {
            path: await writeArtifact(root, renderOnboardingHtml(snapshot, tutorial)),
            renderedAt: snapshot.renderedAt,
          };
        }
        if (options.yaml) {
          fmt.output(YAML.stringify(result).trimEnd(), { ...output, json: false });
        } else fmt.output(output.json ? result : JSON.stringify(result, null, 2), output);
      } catch (error) {
        const exitCode = error instanceof CommandError ? error.exitCode : 2;
        // Parser and filesystem errors can include input text. Keep serialized failures bounded and safe.
        const message =
          error instanceof CommandError
            ? error.message
            : 'Could not read the tutorial project. Check its manifest and saved progress.';
        if (options.yaml) {
          fmt.output(YAML.stringify({ ok: false, error: message, exit_code: exitCode }).trimEnd(), {
            ...output,
            json: false,
          });
        } else fmt.error(message, output);
        process.exitCode = exitCode;
      }
    });
  }
}
