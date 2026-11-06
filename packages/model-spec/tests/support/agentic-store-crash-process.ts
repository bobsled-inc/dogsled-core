/** Owns a run in a real process, reports each durable state, and dies by SIGKILL. */
import { writeFileSync, readFileSync } from 'node:fs';
import { createDefaultAgenticStateStore } from '../../src/agentic/default-state.js';
import { createLocalAgenticStateStore } from '../../src/agentic/local-state.js';
import { currentCommand, type AgenticStoreScenario } from './agentic-store-scenario.js';

const [kind, directory, scenarioFile, ackFile, count] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile!, 'utf8')) as AgenticStoreScenario;
const store =
  kind === 'file'
    ? createLocalAgenticStateStore(directory!)
    : createDefaultAgenticStateStore(directory!);
const session = await store.acquire(scenario.key);
let snapshot = await session.create(scenario.initial);
for (const command of scenario.commands.slice(0, Number(count))) {
  snapshot = await session.checkpoint(currentCommand(snapshot, command));
}
writeFileSync(ackFile!, JSON.stringify(snapshot));
process.kill(process.pid, 'SIGKILL');
