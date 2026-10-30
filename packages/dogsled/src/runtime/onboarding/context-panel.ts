import { escapeHtml as e } from './html.js';
import { renderTableSet } from './results.js';
import { renderValue } from './controls.js';
import type { OnboardingSnapshot } from './schema.js';

export function contextPanel(s: OnboardingSnapshot): string {
  const shortlist = s.state.steps.find((step) => step.id === 'query' && step.status === 'complete')
    ?.evidence?.tables[0];
  const recommendations = s.state.steps
    .find((step) => step.id === 'transform' && step.status === 'complete')
    ?.evidence?.tables.find((table) => table.name === 'Recommendations');
  const answer = recommendations ?? shortlist;
  return `<details class="project-context" id="question"><summary>Your question &amp; project context</summary><div class="context-body"><h2>Your original question</h2>${s.question ? `<blockquote>${e(s.question)}</blockquote>` : '<p>No question saved yet. Tell your agent what you want to watch next.</p>'}${s.preferences ? `<h3>Your viewing preferences</h3><p>${e(s.preferences)}</p>` : ''}<h3>Your answer so far</h3>${
    answer
      ? answer.rows.length
        ? `<ul>${answer.rows
            .slice(0, 5)
            .map(
              (row) =>
                `<li><strong>${e(row.name ?? row.title ?? row.id)}</strong>${row.fit ? ` · ${e(row.fit)}` : ''}${row.reason ? ` — ${e(row.reason)}` : ''}</li>`
            )
            .join('')}</ul>`
        : '<p>No shows match your current rules. Discuss which constraint to relax with your agent.</p>'
      : '<p>No recommendation yet. Connect to TVmaze, run your ETL, and build a shortlist with your agent.</p>'
  }<h3>Where the data comes from</h3>${s.sources.map((source) => `<p><strong>${e(source.name)}</strong> · ${source.rows} checked local rows · ${e(source.license)} <a href="${/^https:\/\//.test(source.url) ? e(source.url) : '#'}" rel="noreferrer">Source website</a></p>`).join('') || '<p>No data fetched yet. Connect to TVmaze to begin.</p>'}<h3 id="history">How your answer changed</h3>${
    s.progress?.history.length
      ? `<ol>${s.progress.history
          .map(
            (h) =>
              `<li>${e(h.step)} · ${e(h.at)}<dl>${h.rows
                .map((row) =>
                  Object.entries(row)
                    .map(([key, value]) => `<dt>${e(key)}</dt><dd>${renderValue(key, value)}</dd>`)
                    .join('')
                )
                .join('')}</dl></li>`
          )
          .join('')}</ol>`
      : '<p>No answer history yet.</p>'
  }<details id="data"><summary>Explore all saved tables</summary>${renderTableSet(s.tables, 'all')}</details><h3 id="orientation">Where you are</h3><p>Execution checks and your review are separate. Later file or database changes do not reset completed chapters. These are not live database results. Refreshing this page does not rerun checks.</p><p>For optional SQL exploration, start <a href="https://duckdb.org/docs/stable/core_extensions/ui.html" rel="noreferrer">DuckDB UI</a> yourself against <code>.dogsled/dogsled.duckdb</code>. The tutorial does not launch or manage it.</p><h3>Learn Dogsled with TV Night</h3><p>Connect an API, build an ETL, describe your data, then query it. Work with your agent, make a small choice, and review each result.</p></div></details>`;
}
