import type { StepId } from './schema.js';
import type { TutorialDefinition } from './tutorial.js';
import { escapeHtml as e } from './html.js';
export function teachingPanel(
  step: StepId,
  complete = false,
  tutorial: TutorialDefinition
): string {
  const lesson = tutorial.teaching[step]!;
  const review = tutorial.teachingHtml[step] ?? '';
  return `${review}<div class="code-inspection"><h3>Code to inspect and understand</h3><ul>${lesson.code.map(([file, why]) => `<li><button type="button" data-file="${e(file)}">${e(file)}</button><p>${e(why)}</p></li>`).join('')}</ul></div><h3>${complete ? 'At the end of this chapter' : 'What you will build'}</h3><p>${e(complete ? lesson.now : tutorial.planned[step])}</p><h3>Questions to try</h3><p>Ask in your agent conversation. Start with the question in plain English; inspect the SQL underneath its answer. Adapt these examples to the fields you have built.</p><ul>${lesson.questions.map((q) => `<li><button type="button" data-copy="${e(q)}">${e(q)}</button></li>`).join('')}</ul><p><strong>Why the next step follows:</strong> ${e(!complete && lesson.beforeNext ? lesson.beforeNext : lesson.next)}</p>`;
}
