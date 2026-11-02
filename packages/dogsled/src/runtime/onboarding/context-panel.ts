import type { TutorialDefinition } from './tutorial.js';
import { escapeHtml as e } from './html.js';
import { renderTableSet } from './results.js';
import { renderValue } from './controls.js';
import type { OnboardingSnapshot } from './schema.js';

export function contextPanel(s: OnboardingSnapshot, tutorial: TutorialDefinition): string {
  return `<details class="project-context" id="question"><summary>Your question &amp; project context</summary><div class="context-body"><h2>Your original question</h2>${s.question ? `<blockquote>${e(s.question)}</blockquote>` : `<p>${e(tutorial.page.noQuestion)}</p>`}${s.preferences ? `<h3>${e(tutorial.page.preferencesLabel)}</h3><p>${e(s.preferences)}</p>` : ''}<h3>Your answer so far</h3>${tutorial.renderAnswer(s)}<h3>Where the data comes from</h3>${s.sources.map((source) => `<p><strong>${e(source.name)}</strong> · ${source.rows} checked local rows · ${e(source.license)} <a href="${/^https:\/\//.test(source.url) ? e(source.url) : '#'}" rel="noreferrer">Source website</a></p>`).join('') || `<p>${e(tutorial.page.noSources)}</p>`}<h3 id="history">How your answer changed</h3>${
    s.progress?.history.length
      ? `<ol>${s.progress.history
          .map(
            (h) =>
              `<li>${e(h.step)} · ${e(h.at)}<dl>${h.rows
                .map((row) =>
                  Object.entries(row)
                    .map(
                      ([key, value]) =>
                        `<dt>${e(key)}</dt><dd>${renderValue(key, value, tutorial.page.table)}</dd>`
                    )
                    .join('')
                )
                .join('')}</dl></li>`
          )
          .join('')}</ol>`
      : '<p>No answer history yet.</p>'
  }<details id="data"><summary>Explore all saved tables</summary>${renderTableSet(s.tables, 'all', tutorial.page.table)}</details><h3 id="orientation">Where you are</h3><p>Execution checks and your review are separate. Later file or database changes do not reset completed chapters. These are not live database results. Refreshing this page does not rerun checks.</p><p>For optional SQL exploration, start <a href="https://duckdb.org/docs/stable/core_extensions/ui.html" rel="noreferrer">DuckDB UI</a> yourself against <code>${e(tutorial.databasePath)}</code>. The tutorial does not launch or manage it.</p><h3>Learn Dogsled with ${e(tutorial.page.title)}</h3><p>${e(tutorial.page.intro)}</p></div></details>`;
}
