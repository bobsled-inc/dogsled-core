import type { TutorialDefinition } from './tutorial.js';
import type { OnboardingSnapshot, StepId } from './schema.js';
import { checkpointId } from './journal.js';

export type Chapter = OnboardingSnapshot['state']['steps'][number];
export function chapterTitle(chapter: Chapter, tutorial: TutorialDefinition): string {
  return tutorial.page.titles[chapter.id] ?? chapter.label;
}
export function chapterStatus(chapter: Chapter, reviewed: readonly StepId[]): string {
  if (chapter.status === 'complete') {
    return reviewed.includes(chapter.id) ? 'Reviewed' : 'Ready to review';
  }
  return {
    not_started: 'Not started',
    running: 'Running',
    needs_input: 'Needs your input',
    failed: 'Check failed',
    stale: 'Check again',
  }[chapter.status];
}
/** Check completion and learner review are separate states. */
export function chapterTone(
  chapter: Chapter,
  reviewed: readonly StepId[]
): 'neutral' | 'info' | 'positive' | 'warning' | 'danger' {
  if (chapter.status === 'complete') {
    return reviewed.includes(chapter.id) ? 'positive' : 'info';
  }
  return (
    {
      not_started: 'neutral',
      running: 'info',
      needs_input: 'warning',
      failed: 'danger',
      stale: 'warning',
    } as const
  )[chapter.status];
}
export function agentRequest(
  chapter: Chapter,
  tutorial: TutorialDefinition,
  review = false
): string {
  if (review && chapter.status === 'complete' && chapter.evidence) {
    return `I have reviewed the saved result for “${chapterTitle(chapter, tutorial)}”. Run bobsled onboarding review ${chapter.id} --checkpoint ${checkpointId(chapter.evidence)}, then bobsled onboarding render. If the saved results have changed, refresh the page and let me review them first. Do not rerun checks or paid work. Pause before starting the next chapter.`;
  }
  return `${tutorial.prompts[chapter.id]} Teach only this step: explain the Bobsled Core capability, show the actual files and query, let me make one small choice, then run and inspect the result with me. Stop and wait for my reply before the next step.`;
}
