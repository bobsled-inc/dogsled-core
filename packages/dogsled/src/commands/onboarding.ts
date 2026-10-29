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
    .description('Inspect TV Night progress and render its local data explorer');
  for (const action of ['guide', 'status', 'render', 'verify <step>', 'review <step>']) {
    group
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
      .action(async (...args: unknown[]) => {
        const command = args[args.length - 1] as Command;
        const options = command.optsWithGlobals<GlobalOptions & { yaml?: boolean }>();
        const output = fmt.toOutputOptions(options);
        try {
          const root = resolve(options.projectRoot ?? process.cwd());
          let result: unknown;
          if (action === 'guide') {
            result = {
              ...getSkill('dogsled-get-started'),
              templatesPath: join(getExamplesDir(), 'tv-night', 'reference'),
            };
          } else if (action.startsWith('review')) {
            result = await reviewChapter(root, StepId.parse(args[0]));
          } else if (action.startsWith('verify')) {
            const step = StepId.safeParse(args[0]);
            if (!step.success) {
              throw new CommandError(
                'Choose connect, load, model, query, federate, transform, or resolve.',
                2
              );
            }
            result = await verifyOnboarding(root, step.data);
          } else if (action === 'status') result = await inspectOnboarding(root);
          else {
            const snapshot = await buildOnboardingSnapshot(root);
            result = {
              path: await writeArtifact(root, renderOnboardingHtml(snapshot)),
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
              : 'Could not read the TV Night project. Check that this folder contains a valid TV Night project.';
          if (options.yaml) {
            fmt.output(
              YAML.stringify({ ok: false, error: message, exit_code: exitCode }).trimEnd(),
              { ...output, json: false }
            );
          } else fmt.error(message, output);
          process.exitCode = exitCode;
        }
      });
  }
}
