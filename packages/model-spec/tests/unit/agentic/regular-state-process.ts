import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { loadState, saveState } from '../../../src/compiler/state.js';

const [directory, model] = process.argv.slice(2);
const state = loadState(directory!);
state.models[model!] = { lastRunAt: 'now', materialization: 'table', specChecksum: model! };
process.send!('ready');
await once(process, 'message');
for (let retry = 0; ; retry++) {
  try {
    saveState(directory!, state);
    break;
  } catch (error) {
    if (retry >= 100 || !(error instanceof Error) || !/writer|recovery/.test(error.message)) {
      throw error;
    }
    await setTimeout(10);
  }
}
process.disconnect!();
