import type { OnboardingSnapshot } from './schema.js';
import { lessons } from './lessons.js';
import { escapeHtml as e } from './html.js';
import { renderFileTree } from './file-tree.js';
import { renderGraph } from './graph.js';
export { escapeHtml } from './html.js';
export function learningPanels(s: OnboardingSnapshot): string {
  const current =
    s.state.steps.find((x) => x.id === s.progress?.current) ??
    s.state.steps.find((x) => x.status !== 'complete') ??
    s.state.steps[0];
  const main = s.state.steps.filter((x) => x.id !== 'resolve');
  const reviewed = s.progress?.reviewed ?? [];
  const files = s.files ?? [];
  const graph = s.lineage;
  return `<section class="stage" id="orientation"><h2>Where you are</h2><p><strong>${main.every((step) => reviewed.includes(step.id)) ? 'Core guide complete' : current ? e(current.label) : 'Start your project'}</strong> · ${reviewed.filter((id) => id !== 'resolve').length} of ${main.length} core chapters inspected</p><p>${current ? e(lessons[current.id].learn) : ''}</p><p>Execution checks and your inspection are separate. Later file or database changes do not reset completed chapters. Run an explicit chapter check when you want to update its saved results. <strong>Waiting for your inspection</strong> means you can explore, ask a question, or say “ready”.</p><p>After a side question, we return here. The watchlist exercise is optional.</p><div class="toolbar"><button type="button" data-copy="Continue the TV Night guide from my saved chapter. Recap what is built, show the current result, and wait for my inspection before the next chapter.">Copy continue request</button><button type="button" data-copy="Refresh my TV Night page with dogsled onboarding render. Show saved check snapshots; do not rerun checks or paid AI calls.">Copy refresh request</button><span id="copy-status" role="status"></span></div></section>
 <section class="stage" id="history"><h2>How your answer changed</h2>${s.progress?.history.length ? `<ol>${s.progress.history.map((h) => `<li><strong>${e(h.step)}</strong> · ${e(h.at)}<pre>${e(JSON.stringify(h.rows, null, 2))}</pre></li>`).join('')}</ol>` : '<p>No answer history yet. Actual shortlist and assessment results will appear after checks run.</p>'}<p>These are saved results from earlier checks, not live database results. More evidence can improve an explanation without changing the shortlist. Unknown means missing evidence, not a poor match.</p></section>
 <section class="stage" id="files"><h2>Working files</h2><p>Read-only snapshots of selected YAML and SQL files, refreshed when this page is generated. Sensitive settings are redacted. Data files, runtime files and secrets are excluded. Preview limits: 100 files, 64 KiB per source file, 512 KiB in total.</p><div class="file-layout"><nav class="file-tree" aria-label="Project files">${renderFileTree(files)}</nav><div class="file-pane"><h3 id="file-name">Select a file</h3><button type="button" id="copy-file">Copy file</button><pre><code id="file-content">Select a working file to inspect its definition.</code></pre></div></div></section>
 <section class="stage" id="lineage"><h2>Model lineage</h2><p>Arrows show declared data dependencies, not semantic relationships or proof of execution. Select a node to inspect its file. Missing definitions stay marked as missing; SQL-only dependencies may need the CLI lineage command.</p>${renderGraph(graph)}</section>`;
}
export const workspaceBrowser = String.raw`
let selectedFile;
function highlight(text) {
 const fragment=document.createDocumentFragment();
 // Small offline highlighter. All source text becomes text nodes, never HTML.
 const parts=text.split(/("[^"\n]*"|'[^'\n]*'|#[^\n]*|\b(?:SELECT|FROM|WHERE|JOIN|LEFT|ON|AS|AND|ORDER|BY|LIMIT|true|false|null)\b|\b[a-z_]+(?=:))/gi);
 parts.forEach((part,i)=>{const span=document.createElement('span');if(i%2)span.className='code-token';span.textContent=part;fragment.append(span);});return fragment;
}
function showFile(path){
 selectedFile=(snapshot.files||[]).find(f=>f.path===path);
 if(!selectedFile){document.getElementById('copy-status').textContent='This file has not been created or is outside the safe preview.';return;}
 document.getElementById('file-name').textContent=selectedFile.path;
 document.getElementById('file-content').replaceChildren(highlight(selectedFile.content));
 document.querySelectorAll('[data-tree-file]').forEach(el=>{const active=el.dataset.file===path;if(active)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current');if(active){let parent=el.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}}});
 location.hash='files';
}
async function copyText(text){try{await navigator.clipboard.writeText(text);document.getElementById('copy-status').textContent='Copied.';}catch{document.getElementById('copy-status').textContent='Clipboard unavailable. Select and copy the text below.';const pre=document.createElement('pre');pre.textContent=text;document.getElementById('copy-status').append(pre);}}
document.querySelectorAll('[data-file]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();showFile(el.dataset.file);}));
document.querySelectorAll('[data-copy]').forEach(el=>el.addEventListener('click',()=>copyText(el.dataset.copy)));
document.getElementById('copy-file').addEventListener('click',()=>{if(selectedFile)copyText(selectedFile.content);});
document.querySelectorAll('[data-table]').forEach(el=>el.addEventListener('click',()=>{const index=snapshot.tables.findIndex(t=>t.name===el.dataset.table);if(index>=0){source.value=String(index);page=0;search.value='';draw(true);location.hash='data';}else document.getElementById('copy-status').textContent='No current evidence for that table. Verify the chapter and regenerate this page.';}));
`;
