import { teachingPanel } from './teaching.js';
import { Snapshot, type OnboardingSnapshot } from './schema.js';
import { style } from './style.js';
import { fontFaces, dogsledMark } from './assets.generated.js';
import { lessons } from './lessons.js';
import { drawerBrowser } from './drawer-browser.js';
import { browserScript } from './browser.js';
import { resultsBrowser } from './results-browser.js';
import { escapeHtml as e } from './html.js';
import { brandPaint, codeBlock, icon, iconButton } from './controls.js';
import { chapterTitle, chapterStatus, chapterTone, descriptions, agentRequest } from './content.js';
import { renderResults, resultTables } from './results.js';
import { renderWorkspace } from './workspace-panel.js';
import { contextPanel } from './context-panel.js';

export function renderOnboardingHtml(input: OnboardingSnapshot): string {
  const s = Snapshot.parse(input);
  const current =
    s.state.steps.find((x) => x.id === s.progress?.current) ??
    s.state.steps.find((x) => x.status !== 'complete') ??
    s.state.steps[0];
  const reviewed = s.progress?.reviewed ?? [];
  const labels = {
    connect: 'Connect an API',
    load: 'ETL pipeline',
    model: 'Semantic models',
    query: 'Query the data',
    federate: 'Federated queries',
    transform: 'Agentic transformation',
    resolve: 'Entity resolution (optional)',
  };
  const nav = s.state.steps
    .map(
      (chapter, index) =>
        `<a href="#${chapter.id}" data-chapter-link="${chapter.id}" data-tone="${chapterTone(chapter, reviewed)}" data-reviewed="${reviewed.includes(chapter.id)}"${chapter.id === current?.id ? ' aria-current="step"' : ''}><span class="chapter-icon">${icon('RadioSelected', 'current-icon')}${icon(reviewed.includes(chapter.id) ? 'SuccessKnockout' : chapter.status === 'failed' ? 'FailKnockout' : 'LoadingSpinnerHold', 'status-icon')}</span><span class="chapter-label">${labels[chapter.id]}</span>${chapter.id === 'resolve' ? '' : `<span class="chapter-number">${String(index + 1).padStart(2, '0')}</span>`}<span class="sr-only">${e(chapterStatus(chapter, reviewed))}</span></a>`
    )
    .join('');
  const sections = s.state.steps
    .map((chapter, index) => {
      const lesson = lessons[chapter.id];
      const tables = resultTables(chapter);
      const status = chapterStatus(chapter, reviewed);
      const heading = (number: string, title: string) =>
        `<div class="flow-section-heading"><span class="flow-number" aria-hidden="true">${number}</span><h2>${title}</h2></div>`;
      return `<article class="chapter" id="${chapter.id}" data-step="${chapter.id}" data-status="${chapter.status}" data-reviewed="${reviewed.includes(chapter.id)}" data-review-request="${e(agentRequest(chapter, true))}"><section class="chapter-introduction"><div class="chapter-eyebrow"><span>${chapter.id === 'resolve' ? 'Optional' : `${index + 1}/${s.state.steps.filter((x) => x.id !== 'resolve').length}`}</span><span class="badge" data-tone="${chapterTone(chapter, reviewed)}">${e(status)}</span></div><h1 tabindex="-1">${e(chapterTitle(chapter))}</h1><p class="chapter-summary">${e(descriptions[chapter.id])}</p><div class="chapter-meta"><span>${e(s.sources.map((x) => x.name).join(', ') || 'TVmaze API')}</span><span>${tables.length ? tables.map((table) => `${table.totalRows} ${e(table.name.toLowerCase())}`).join(' · ') : 'No saved result yet'}</span><span>${chapter.evidence ? `${e(chapter.evidence.mode)} check` : 'Awaiting check'}</span></div></section><div class="checkout-flow"><section class="flow-section">${heading('01', chapter.status === 'complete' ? 'Understand what you built' : 'Understand the step')}<p><strong class="sr-only">What you will learn: </strong>${e(lesson.learn)}</p><div class="small-choice"><strong>Your small choice</strong><p>${e(lesson.choice)}</p></div><details class="definition-disclosure"><summary>More about this step</summary>${teachingPanel(chapter.id, chapter.status === 'complete')}</details></section><section class="flow-section" id="results-${chapter.id}">${heading('02', 'Inspect the saved result')}<p><strong class="sr-only">Pause and inspect: </strong>${e(lesson.inspect)}</p>${chapter.evidence ? `<p class="caption">Saved check snapshot · ${e(chapter.evidence.at)} · ${e(chapter.evidence.mode)}${chapter.status === 'stale' ? ' · rerun the check before using these results' : ''}</p>` : ''}${renderResults(chapter)}</section><section class="flow-section">${heading('03', 'Connect the files to the result')}<p>Inspect the working definitions and follow their inputs. Keep the details open when they help.</p><div class="definitions-stack"><details class="definition-disclosure"><summary>Files to inspect</summary><ul>${lesson.files.map((path) => `<li><button type="button" data-file="${e(path)}">${e(path)}</button></li>`).join('')}</ul></details><div data-workspace-host>${chapter.id === current?.id ? renderWorkspace(s) : ''}</div>${chapter.evidence ? `<details class="definition-disclosure"><summary>Saved execution evidence</summary><pre>${e(chapter.evidence.receipts.join('\n') || 'Local table checks completed.')}</pre></details>` : ''}</div></section><section class="flow-section" id="ready-${chapter.id}">${heading('04', 'Ready to move on?')}<p>${chapter.status === 'complete' ? 'Check that you understand the files and can trace one record to the result, then mark this step as reviewed.' : 'Work through this step with your agent to create its result.'}</p><div class="agent-handoff"><h3>Share this with your agent</h3>${codeBlock(agentRequest(chapter), `request-${chapter.id}`)}<p class="caption review-hint" hidden>Send this request to your agent. Reviewed appears after the journal is saved and this page is regenerated.</p></div></section></div></article>`;
    })
    .join('');
  const rawJson = JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const savedAt = new Date(s.renderedAt)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d{3}Z$/, ' UTC');
  const shell = `<div class="artifact-app"><aside class="journey-rail" id="chapter-menu" aria-labelledby="journey-heading"><div class="brand"><img src="${dogsledMark}" alt="" width="32" height="40"><strong>Dogsled</strong>${iconButton('Clear', 'Close chapters', 'data-chapters-close')}</div><nav aria-label="Tutorial chapters"><p class="journey-label" id="journey-heading">TV Night · Your journey</p>${nav}</nav></aside><div class="chapters-backdrop" data-chapters-backdrop hidden aria-hidden="true"></div><main><header class="workspace-header">${iconButton('Menu', 'Open chapters', 'id="chapters-toggle" aria-controls="chapter-menu" aria-expanded="false"')}<strong>${icon('Pipeline')}TV Night</strong><time datetime="${e(s.renderedAt)}" aria-label="Saved ${e(savedAt)}" title="${e(savedAt)}"><span class="saved-wide">Saved ${e(savedAt)}</span><span class="saved-narrow" aria-hidden="true">Saved ${e(new Date(s.renderedAt).toISOString().slice(11, 16))} UTC</span></time><details class="more-menu"><summary aria-label="More options" title="More options">${icon('MoreVert')}</summary><div class="menu-content"><label class="theme-setting" for="theme"><span>Theme</span><select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><div class="menu-actions"><button type="button" data-context>Question &amp; project context</button><button type="button" data-copy="Refresh my TV Night page with dogsled onboarding render. Show saved check snapshots; do not rerun checks or paid AI calls.">Copy refresh request</button></div></div></details></header><div class="workspace-content">${sections || '<section class="flow-section"><h1>Learn Dogsled with TV Night</h1><p>No chapters available.</p></section>'}${contextPanel(s)}<footer>Saved locally · No tracking or remote assets · Refresh after your agent saves a checkpoint.</footer></div><nav class="checkout-actions" aria-label="Chapter actions"><button type="button" id="previous-chapter" hidden>${icon('ArrowLeft')}Previous</button><div class="action-buttons"><button type="button" id="review-chapter" disabled>Mark as reviewed</button><button type="button" class="primary" id="next-chapter" hidden>Next step${icon('ArrowRight')}</button></div></nav><div id="copy-status" class="sr-only" role="status" aria-live="polite"></div><noscript><p class="flow-section">JavaScript is disabled. Chapters and the first 20 saved rows remain readable. Enable it for navigation, search and copy controls.</p></noscript></main></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>TV Night · Dogsled</title><style>${fontFaces}${style}</style></head><body class="tv-night">${brandPaint}${shell}<script id="snapshot" type="application/json">${rawJson}</script><script>${drawerBrowser}${browserScript}${resultsBrowser}</script></body></html>`;
}
