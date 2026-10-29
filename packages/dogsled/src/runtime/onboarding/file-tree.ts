import type { ProjectFile } from './workspace.js';
import { icon } from './controls.js';
import { escapeHtml as e } from './html.js';
interface Folder {
  folders: Map<string, Folder>;
  files: ProjectFile[];
}
export function renderFileTree(files: ProjectFile[]): string {
  const root: Folder = { folders: new Map(), files: [] };
  for (const file of files) {
    let folder = root;
    for (const name of file.path.split('/').slice(0, -1)) {
      if (!folder.folders.has(name)) folder.folders.set(name, { folders: new Map(), files: [] });
      folder = folder.folders.get(name)!;
    }
    folder.files.push(file);
  }
  function render(folder: Folder): string {
    return `<ul>${[...folder.folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, child]) =>
          `<li><details open><summary>${icon('Folder')} ${e(name)}</summary>${render(child)}</details></li>`
      )
      .join('')}${folder.files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(
        (file) =>
          `<li><button type="button" data-tree-file="true" data-file="${e(file.path)}" title="${e(file.path)}">${icon('CodeSnippet')} ${e(file.path.split('/').at(-1))}</button></li>`
      )
      .join('')}</ul>`;
  }
  return files.length ? render(root) : '<p>No working files yet.</p>';
}
