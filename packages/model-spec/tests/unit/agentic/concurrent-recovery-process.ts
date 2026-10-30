import { appendFileSync } from 'node:fs';
import { executeAgenticRun } from '../../../src/agentic/index.js';
import { runFixture } from './state-fixture.js';

const [directory, mode, marker] = process.argv.slice(2);
const fixture = runFixture(6);
fixture.host.concurrency = 3;
const execute = fixture.host.executeAgent;
fixture.host.executeAgent = async (request) => {
  appendFileSync(marker!, `${request.assignment.shard_id}\n`);
  if (mode === 'start') {
    // The coordinator saves shard 0 while shards 1 and 2 remain active.
    // Killing on shard 3 leaves three durable reservations without outcomes.
    if (request.assignment.shard_id === '3') process.kill(process.pid, 'SIGKILL');
    if (request.assignment.shard_id !== '0') await new Promise(() => {});
  }
  return execute(request);
};
await executeAgenticRun(fixture.host, fixture.context(), {
  projectDirectory: directory!,
  run: { id: 'recovery', mode: mode as 'start' | 'resume' },
  accounting: 'reservation' as const,
});
