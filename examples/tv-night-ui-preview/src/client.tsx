import { hydrateRoot } from 'react-dom/client';
import { TutorialArtifact } from './app';
import type { Snapshot } from './contract';

const state = document.getElementById('tutorial-snapshot');
const root = document.getElementById('tutorial-root');
if (!state || !root) throw new Error('The tutorial snapshot or mount point is missing.');
const snapshot: Snapshot = JSON.parse(state.textContent ?? '{}');
hydrateRoot(root, <TutorialArtifact snapshot={snapshot} />);
