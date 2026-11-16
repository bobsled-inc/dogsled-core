import { CommandError } from '@bobsled-inc/protocol';
import type { TutorialDefinition } from './tutorial.js';
import { resolveTutorial, requireStep, requireIdentity } from './tutorials.js';
import { z } from 'zod';
import { recordHistory } from './journal.js';
import { createHash } from 'node:crypto';
import { Checkpoint, Evidence, type OnboardingState, type StepId } from './schema.js';
import { inputFiles, readBounded, writeLocal, databaseFingerprint } from './files.js';

export async function inputHash(
  root: string,
  step?: StepId,
  tutorial?: TutorialDefinition
): Promise<string> {
  tutorial ??= await resolveTutorial(root);
  if (tutorial.probe && step === tutorial.probe.step) return tutorial.probe.hash(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of await inputFiles(root, tutorial.dataDirectory)) {
    const content = await readBounded(root, file);
    bytes += Buffer.byteLength(content);
    if (bytes > 20 * 1024 * 1024) throw new Error('Sample exceeds 20 MiB');
    hash.update(file);
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}
const Attempt = z.object({
  tutorial: z.string().optional(),
  status: z.enum(['running', 'failed', 'complete']),
  scope: z.literal('probe-v1').optional(),
  inputHash: z.string(),
  at: z.string().datetime(),
});
export async function saveAttempt(
  root: string,
  step: StepId,
  status: 'running' | 'failed' | 'complete',
  hash: string,
  tutorial?: TutorialDefinition
): Promise<void> {
  tutorial ??= await resolveTutorial(root);
  requireStep(tutorial, step);
  await writeLocal(
    root,
    `.bobsled/onboarding/${step}.attempt.json`,
    JSON.stringify({
      status,
      tutorial: tutorial.id,
      inputHash: hash,
      ...(step === tutorial.probe?.step ? { scope: 'probe-v1' } : {}),
      at: new Date().toISOString(),
    })
  );
}
export async function inspectOnboarding(
  root: string,
  tutorial?: TutorialDefinition
): Promise<OnboardingState> {
  tutorial ??= await resolveTutorial(root);
  const hash = await inputHash(root, undefined, tutorial);
  const manifest = JSON.parse(
    await readBounded(root, `${tutorial.dataDirectory}/manifest.json`)
  ) as {
    version?: string;
  };
  const result: OnboardingState = {
    version: 2,
    tutorial: tutorial.id,
    inputHash: hash,
    datasetVersion: String(manifest.version ?? 'unknown'),
    steps: [],
  };
  for (const step of tutorial.steps) {
    let evidence: Checkpoint | undefined;
    try {
      evidence = Checkpoint.parse(
        JSON.parse(await readBounded(root, `.bobsled/onboarding/${step.id}.json`))
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    let attempt: z.infer<typeof Attempt> | undefined;
    try {
      attempt = Attempt.parse(
        JSON.parse(await readBounded(root, `.bobsled/onboarding/${step.id}.attempt.json`))
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (evidence) {
      requireIdentity(tutorial, evidence.tutorial);
      if (evidence.step !== step.id) {
        throw new CommandError('Saved checkpoint belongs to a different chapter.', 2);
      }
    }
    if (attempt) requireIdentity(tutorial, attempt.tutorial);
    // Progress records completed learning, not whether the workspace is unchanged.
    // An explicit failed/running check still takes priority over an earlier success.
    const attemptStatus = attempt && attempt.status !== 'complete' ? attempt.status : undefined;
    result.steps.push({
      ...step,
      status:
        attemptStatus ??
        (!evidence ? 'not_started' : evidence.mode === 'recorded' ? 'needs_input' : 'complete'),
      ...(evidence ? { evidence } : {}),
    });
  }
  return result;
}
export async function saveCheckpoint(
  root: string,
  step: StepId,
  evidence: Evidence,
  tutorial?: TutorialDefinition
): Promise<void> {
  tutorial ??= await resolveTutorial(root);
  requireStep(tutorial, step);
  const record = Checkpoint.parse({
    ...Evidence.parse(evidence),
    version: 2,
    tutorial: tutorial.id,
    databaseFingerprint: await databaseFingerprint(root, tutorial.databasePath),
    step,
    ...(step === tutorial.probe?.step ? { probeInputHash: await tutorial.probe.hash(root) } : {}),
    inputHash: await inputHash(root, undefined, tutorial),
    at: new Date().toISOString(),
  });
  await writeLocal(
    root,
    `.bobsled/onboarding/${step}.json`,
    `${JSON.stringify(record, null, 2)}\n`
  );
  await recordHistory(root, record, tutorial);
}
export async function writeArtifact(root: string, html: string): Promise<string> {
  return writeLocal(root, '.bobsled/onboarding/index.html', html);
}
