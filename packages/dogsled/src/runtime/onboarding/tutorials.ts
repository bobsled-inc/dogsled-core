import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';
import { StepId } from './schema.js';
import { readBounded } from './files.js';
import type { TutorialDefinition } from './tutorial.js';
import { retail } from './tutorials/retail/index.js';
import { tvNight } from './tutorials/tv-night/index.js';

export const tutorials: readonly TutorialDefinition[] = [tvNight, retail];
export function getTutorial(id = 'tv-night'): TutorialDefinition {
  const tutorial = tutorials.find((t) => t.id === id);
  if (!tutorial) throw new CommandError('Unknown tutorial. Choose a bundled tutorial.', 2);
  return tutorial;
}
const Identity = z.object({ tutorial: z.string().optional() });
export async function resolveTutorial(root: string): Promise<TutorialDefinition> {
  const found: TutorialDefinition[] = [];
  for (const tutorial of tutorials) {
    let text: string;
    try {
      text = await readBounded(root, `${tutorial.dataDirectory}/manifest.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const manifest = Identity.parse(JSON.parse(text));
    // Only the original TV Night manifest may omit identity.
    if ((manifest.tutorial ?? 'tv-night') !== tutorial.id) {
      throw new CommandError('The project manifest has an unknown or mismatched tutorial ID.', 2);
    }
    found.push(tutorial);
  }
  if (found.length !== 1) {
    throw new CommandError('Use a project containing exactly one bundled tutorial manifest.', 2);
  }
  return found[0]!;
}
export function requireStep(tutorial: TutorialDefinition, step: string): void {
  if (!StepId.safeParse(step).success || !tutorial.steps.some((s) => s.id === step)) {
    throw new CommandError(`Choose ${tutorial.steps.map((s) => s.id).join(', ')}.`, 2);
  }
}
export function requireIdentity(tutorial: TutorialDefinition, savedId?: string): void {
  if ((savedId ?? 'tv-night') !== tutorial.id) {
    throw new CommandError('Saved progress belongs to a different tutorial.', 2);
  }
}
