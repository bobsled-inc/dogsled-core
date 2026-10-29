import { renderToString } from 'react-dom/server';
import { TutorialArtifact } from './app';
import type { Snapshot } from './contract';
export { layoutLineage } from './lineage';
export { chapterContent } from './chapters';

export function renderArtifact(snapshot: Snapshot): string {
  return renderToString(<TutorialArtifact snapshot={snapshot} />);
}
