import { renderFileTree } from './file-tree.js';
import { renderGraph } from './graph.js';
import { escapeHtml as e } from './html.js';
import { iconButton } from './controls.js';
import type { OnboardingSnapshot } from './schema.js';

export function renderWorkspace(s: OnboardingSnapshot): string {
  return `<div id="workspace"><details class="definition-disclosure" id="files"><summary>Working files · ${(s.files ?? []).length} definitions</summary><p>Read-only snapshots of selected YAML and SQL files. Sensitive settings are redacted. Data files, runtime files and secrets are excluded.</p><div class="file-layout"><nav class="file-tree" aria-label="Project files">${renderFileTree(s.files ?? [])}</nav><div class="file-pane"><div class="file-heading"><span id="file-name">Select a file</span>${iconButton('Copy', 'Copy file', 'id="copy-file"')}</div><pre tabindex="0"><code id="file-content">Select a working file to inspect its definition.</code></pre></div></div></details><details class="definition-disclosure" id="lineage"><summary>Model lineage</summary><p>Arrows show declared data dependencies, not semantic relationships or proof of execution. Select a node to inspect its file. Missing definitions stay marked as missing.</p>${renderGraph(s.lineage)}</details><details class="definition-disclosure" id="definitions"><summary>Semantic definitions · ${(s.definitions ?? []).length}</summary>${(s.definitions ?? []).map((d) => `<details><summary>${e(d.kind)} · ${e(d.name)}</summary><p>${e(d.description)}</p><pre>${e(d.fields.join('\n'))}</pre></details>`).join('') || '<p>No models yet. Build them with your agent after your first ETL run.</p>'}</details></div>`;
}
