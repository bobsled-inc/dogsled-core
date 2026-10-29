import { probeInputHash } from './probe-inputs.js';
import { z } from 'zod';
import { recordHistory } from './journal.js';
import { createHash } from 'node:crypto';
import { Checkpoint, Evidence, steps, type OnboardingState, type StepId } from './schema.js';
import { inputFiles, readBounded, writeLocal, databaseFingerprint } from './files.js';

export async function inputHash(root: string, step?: StepId): Promise<string> {
  if (step === 'connect') return probeInputHash(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of await inputFiles(root)) {
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
  status: z.enum(['running', 'failed', 'complete']),
  scope: z.literal('probe-v1').optional(),
  inputHash: z.string(),
  at: z.string().datetime(),
});
export async function saveAttempt(
  root: string,
  step: StepId,
  status: 'running' | 'failed' | 'complete',
  hash: string
): Promise<void> {
  await writeLocal(
    root,
    `.dogsled/onboarding/${step}.attempt.json`,
    JSON.stringify({
      status,
      inputHash: hash,
      ...(step === 'connect' ? { scope: 'probe-v1' } : {}),
      at: new Date().toISOString(),
    })
  );
}
export async function inspectOnboarding(root: string): Promise<OnboardingState> {
  const hash = await inputHash(root);
  const manifest = JSON.parse(
    await readBounded(root, 'data/tv-night/manifest.json').catch(() => {
      throw new Error('Create a TV Night project with its data/tv-night/manifest.json file.');
    })
  ) as {
    version?: string;
  };
  const result: OnboardingState = {
    version: 2,
    inputHash: hash,
    datasetVersion: String(manifest.version ?? 'unknown'),
    steps: [],
  };
  for (const step of steps) {
    let evidence: Checkpoint | undefined;
    try {
      evidence = Checkpoint.parse(
        JSON.parse(await readBounded(root, `.dogsled/onboarding/${step.id}.json`))
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    let attempt: z.infer<typeof Attempt> | undefined;
    try {
      attempt = Attempt.parse(
        JSON.parse(await readBounded(root, `.dogsled/onboarding/${step.id}.attempt.json`))
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
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
  evidence: Evidence
): Promise<void> {
  const record = Checkpoint.parse({
    ...Evidence.parse(evidence),
    version: 2,
    databaseFingerprint: await databaseFingerprint(root),
    step,
    ...(step === 'connect' ? { probeInputHash: await probeInputHash(root) } : {}),
    inputHash: await inputHash(root),
    at: new Date().toISOString(),
  });
  await writeLocal(
    root,
    `.dogsled/onboarding/${step}.json`,
    `${JSON.stringify(record, null, 2)}\n`
  );
  await recordHistory(root, record);
}
export async function writeArtifact(root: string, html: string): Promise<string> {
  return writeLocal(root, '.dogsled/onboarding/index.html', html);
}
