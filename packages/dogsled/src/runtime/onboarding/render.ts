import { teachingPanel, tutorialOverview } from './teaching.js';
import { learningPanels, workspaceBrowser } from './panels.js';
import { Snapshot, type OnboardingSnapshot } from './schema.js';
import { style } from './style.js';
import { lessons } from './lessons.js';
import { browserScript } from './browser.js';
const escape = (value: unknown): string =>
  String(value ?? 'Unknown').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
const renderCell = (key: string, value: unknown): string =>
  ['article_text', 'support_excerpt', 'input_passages', 'passages'].includes(key)
    ? `<details><summary>Show passage (may contain spoilers)</summary><p>${escape(value)}</p></details>`
    : escape(value);
const status = (value: string): string =>
  ({
    not_started: '○ Not started',
    complete: '✓ Complete',
    stale: '! Inputs changed',
    needs_input: '? Needs you',
    failed: '! Failed',
    running: '↻ Running',
  })[value] ?? value;
const descriptions = {
  connect:
    'Make your first request to TVmaze. It needs no API key. Inspect one response before deciding what to fetch.',
  load: 'Build an ETL pipeline with your agent: fetch around 250 shows (or more if you choose), flatten their episodes into rows, and load two local tables (cast is optional). No records are bundled.',
  model:
    'Define your fields, descriptions, relationships and metrics. Keep missing values unknown and separate a show ending from its story reaching a conclusion.',
  query:
    'Dogsled lets you query the models and metrics you built. Ask your agent a question in plain English or use your own SQL tool. Choose your first question before running it; later, save useful selection rules as another model.',
  federate:
    'Join your local shortlist to selected Wikipedia articles through an API source. Dogsled fetches or reuses cached article rows and joins them locally; the request receipts explain which happened.',
  transform:
    'Assess every finalist against the same preference using article passages. Compare supporting evidence and unknowns, then query your recommendations.',
  resolve:
    'Match your own watchlist against TVmaze search candidates. Use shared IDs first; review real title, year and country ambiguities. Accepted matches can remove shows you have already watched.',
};
const prompts = {
  connect:
    'Follow the TV Night guide. Help me connect to TVmaze, inspect a response, verify connect, and refresh this page.',
  load: 'Help me fetch around 250 TV series with an adjustable page list and build the TVmaze ETL for shows and episodes (cast is optional). Run it, verify load, and refresh this page.',
  model:
    'Help me describe the fields and define meaningful relationships and metrics, then build shows and episodes models from the raw tables. Verify model and refresh this page.',
  query:
    'Introduce how Dogsled queries my models and metrics. Offer example questions and invite my own. Wait for my question before running a query; after exploration, help me decide whether to save useful rules as a model.',
  federate:
    'Link selected shows to Wikidata and Wikipedia. Configure a bounded Wikipedia API source and join its articles to the local shows. Verify federate and refresh this page.',
  transform:
    'Help me fetch full articles and prepare bounded passages for every finalist. Assess the same preference for each within the API usage approved at setup and any chosen dollar cap. Have AI select passage IDs and code attach the exact text. Run one pilot, verify transform --show-id for that ID, and pause for inspection before the remaining shows. Use only explicitly approved recovery attempts for failed or rejected IDs; keep automatic retries disabled. Review the explanations as well as passage IDs and mark weak reasoning as needs review. After the remaining runs or any recovery, explain the actual model chain, show the agentic YAML and executor, distinguish querying saved results from running AI, then give a brief comparison and a file-focused inspection pause. Build recommendations and run the full technical check only when every finalist has valid saved output; this does not close the quality review.',
  resolve:
    'Use my watchlist and TVmaze search candidates for a real entity-resolution pipeline. Review ambiguous pairs, preserve unresolved records, and exclude accepted watched shows from recommendations.',
};
export function renderOnboardingHtml(input: OnboardingSnapshot): string {
  const s = Snapshot.parse(input);
  const first = s.tables[0];
  const shortlist = s.state.steps.find((step) => step.id === 'query' && step.status === 'complete')
    ?.evidence?.tables[0];
  const recommendations = s.state.steps
    .find((step) => step.id === 'transform' && step.status === 'complete')
    ?.evidence?.tables.find((table) => table.name === 'Recommendations');
  const answer = recommendations
    ? `<p>All finalists were assessed against the same preference. Inspect the evidence before choosing.</p><ul>${recommendations.rows.map((row) => `<li><strong>${escape(row['name'] ?? row['id'])}</strong> · ${escape(row['fit'])} — ${escape(row['reason'])}</li>`).join('')}</ul>`
    : shortlist
      ? shortlist.rows.length
        ? `<p>Your current shortlist comes from your watch_next model. Inspect its rules and source evidence below.</p><ul>${shortlist.rows
            .slice(0, 5)
            .map(
              (row) =>
                `<li>${escape(row['name'] ?? row['title'] ?? row['id'])}${row['reason'] ? ` — ${escape(row['reason'])}` : ''}</li>`
            )
            .join('')}</ul>`
        : '<p>No shows match your current rules. Discuss which constraint to relax with your agent.</p>'
      : '<p>No recommendation yet. Connect to TVmaze, run your ETL, and build a shortlist with your agent.</p>';

  const sources = s.sources
    .map(
      (x) =>
        `<article class="source"><strong>${escape(x.name)}</strong><p>${x.rows} checked local rows</p><a href="${/^https:\/\//.test(x.url) ? escape(x.url) : '#'}" rel="noreferrer">Source website</a><p>${escape(x.license)}</p></article>`
    )
    .join('');
  const nav = s.state.steps
    .map(
      (x) =>
        `<a href="#${x.id}"><span class="step-label">${escape(x.label)}</span><small>${status(x.status)}</small></a>`
    )
    .join('');
  const sections = s.state.steps
    .map(
      (x) =>
        `<section class="stage" id="${x.id}"><div class="toolbar"><h2 class="grow">${x.id === 'resolve' ? 'Extension' : `Chapter ${s.state.steps.findIndex((step) => step.id === x.id) + 1}`} · ${escape(x.label)}</h2><span class="badge">${status(x.status)}</span><span class="badge">${s.progress?.reviewed.includes(x.id) ? 'Inspected' : 'Waiting for your inspection'}</span></div><p><strong>What you will learn:</strong> ${escape(lessons[x.id].learn)}</p><p>${descriptions[x.id]}</p><details><summary>Files to inspect</summary><pre>${escape(lessons[x.id].files.join('\n'))}</pre>${lessons[x.id].files.map((file) => `<button type="button" data-file="${escape(file)}">${escape(file)}</button>`).join(' ')}<p>Ask your agent to open these files and show the actual changes before running them. Paths follow the walkthrough; use your project’s paths if you chose different names.</p></details>${teachingPanel(x.id, x.status === 'complete')}<p><strong>Your small choice:</strong> ${escape(lessons[x.id].choice)}</p><div class="callout"><strong>Pause and inspect</strong><p>${escape(lessons[x.id].inspect)}</p><p>A completed check means the command passed. Continue to the next lesson only when you are ready.</p></div>${x.status === 'complete' ? `<p><strong>Data check:</strong> ${x.evidence?.tables.map((t) => `${escape(t.name)}: ${t.totalRows} checked rows`).join(' · ')}. ${x.evidence?.tables.map((t) => `<button type="button" data-table="${escape(t.name)}">Inspect ${escape(t.name)}</button>`).join(' ')} A completed check does not guarantee a better recommendation.</p>` : ''}${x.evidence ? `<p class="muted">Saved check snapshot · ${escape(x.evidence.at)} · ${escape(x.evidence.mode)}${x.status === 'stale' ? ' · rerun before using these results' : ''}</p><details><summary>Execution evidence</summary><pre>${escape(x.evidence.receipts.join('\n') || 'Local table checks completed.')}</pre></details>` : ''}<details><summary>Continue in your agent</summary><p>Copy this request into Claude Code or Codex:</p><pre>${escape(prompts[x.id])} Teach only this step: explain the Dogsled capability, show the actual files and query, let me make one small choice, then run and inspect the result with me. Stop and wait for my reply before the next step.</pre></details></section>`
    )
    .join('');
  const rawJson = JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>TV Night · Dogsled</title><style>${style}</style></head><body class="tv-night"><header><span class="wordmark">dogsled</span><span class="muted">/</span><strong>TV Night</strong><span class="grow"></span><span class="badge">Local artifact</span><label>Theme <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header><div class="shell"><aside><div class="eyebrow">Your journey</div><nav aria-label="Getting started">${nav}<a href="#data">Explore the data</a><a href="#definitions">Your models</a><a href="#files">Working files</a><a href="#lineage">Model lineage</a><a href="#history">Answer history</a></nav><p>Work happens in your agent. This page helps you inspect the results.</p></aside><main><div class="intro"><div class="eyebrow">Learn Dogsled, one step at a time</div><h1>Learn Dogsled with TV Night</h1><p>Connect an API, build an ETL, create models, and query across sources. At each step, inspect the files, make a small choice, and see the result. TV recommendations are the example.</p><small>Dataset ${escape(s.state.datasetVersion)} · Page generated ${escape(s.renderedAt)}</small></div>${tutorialOverview}<section class="stage question-box" id="question"><h2>Your original question</h2>${s.question ? `<blockquote>${escape(s.question)}</blockquote>` : '<p>No question saved yet. Tell your agent what you want to watch next; it will save your wording here.</p>'}${s.preferences ? `<h3>Your viewing preferences</h3><p>${escape(s.preferences)}</p>` : ''}<p class="muted">This is the example we will work through while learning Dogsled.</p></section>${learningPanels(s)}<section class="stage"><h2>Your answer so far</h2>${answer}<p class="muted">Results cover only the shows you fetch. Your original question stays above as the models and evidence develop.</p></section><section class="stage"><h2>Where the data comes from</h2><div class="sources">${sources}</div><div class="flow" aria-label="Data flow"><span>TVmaze API</span> → <span>Local DuckDB</span> → <span>Your models</span> → <span>A better shortlist</span></div><p>TVmaze supplies shows, episodes and cast. Wikipedia adds article context. Wikidata helps link the right series. No API key is needed for these public reads.</p></section><section class="stage" id="data"><h2>Explore the data</h2><p>For optional SQL exploration, you can start <a href="https://duckdb.org/docs/stable/core_extensions/ui.html">DuckDB UI</a> yourself against <code>.dogsled/dogsled.duckdb</code>. The tutorial does not launch or manage it.</p><p>${s.tables.length ? 'Search and sort saved check snapshots. These are not live database results. Refreshing this page does not rerun checks. No database query runs in your browser.' : 'No data fetched yet. Start with Connect to TVmaze, then build your ETL. Your tables will appear here.'}</p><div class="toolbar"><label>Table <select id="table-choice">${s.tables.map((t, i) => `<option value="${i}">${escape(t.name)}</option>`).join('')}</select></label><input id="search" aria-label="Search rows" placeholder="Search shows, episodes, actors…"><label>Sort <select id="sort"></select></label></div><div class="table-scroll" tabindex="0" role="region" aria-label="Data preview"><table><thead id="data-head"><tr>${first?.columns.map((k) => `<th>${escape(k)}</th>`).join('') ?? ''}</tr></thead><tbody id="data-body">${
    first?.rows
      .slice(0, 20)
      .map(
        (r) => `<tr>${first.columns.map((k) => `<td>${renderCell(k, r[k])}</td>`).join('')}</tr>`
      )
      .join('') ?? ''
  }</tbody></table></div><div class="toolbar"><small id="row-count" class="grow" aria-live="polite">${first?.totalRows ?? 0} rows available</small><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button></div><section id="record-detail" class="callout" hidden tabindex="-1" aria-label="Selected record"></section><noscript><p>JavaScript is disabled. The first 20 records remain readable; enable it for search and pagination.</p></noscript></section><section class="stage" id="definitions"><h2>Your semantic definitions</h2>${(s.definitions ?? []).map((d) => `<details><summary>${escape(d.kind)} · ${escape(d.name)}</summary><p>${escape(d.description)}</p><pre>${escape(d.fields.join('\n'))}</pre></details>`).join('') || '<p>No models yet. Build them with your agent after your first ETL run.</p>'}<div class="split"><div><h3>Short enough for tonight</h3><p>Choose an episode limit. Decide whether every episode must fit or whether an average is enough. Missing runtimes stay unknown.</p></div><div><h3>Finished, or just ended?</h3><p>TVmaze status tells us whether a show has ended. Article evidence may explain whether the story reached a conclusion. Keep these separate.</p></div></div><div class="callout"><strong>The right show matters</strong><p>Match source IDs where possible. Check year, country and cast before linking shows with the same name.</p></div></section>${sections}<footer>Generated locally by Dogsled. No tracking or remote assets. Refresh after the agent saves a new checkpoint. Source records may be incomplete or outdated.</footer></main></div><script id="snapshot" type="application/json">${rawJson}</script><script>${browserScript}${workspaceBrowser}</script></body></html>`;
}
