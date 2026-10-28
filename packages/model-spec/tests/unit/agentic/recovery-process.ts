import { appendFileSync } from 'node:fs';
import { executeAgenticRun } from '../../../src/agentic/index.js';
import { runFixture } from './state-fixture.js';

const [directory, mode, marker, crash] = process.argv.slice(2);
const fixture = runFixture();
const execute = fixture.host.executeAgent;
let calls = 0;
fixture.host.executeAgent = async (request) => {
  appendFileSync(marker!, `${request.assignment.shard_id}\n`);
  calls++;
  // Twelve results are accepted, then this billable thirteenth attempt is interrupted.
  if (crash && calls === 13) process.kill(process.pid, 'SIGKILL');
  return execute(request);
};
await executeAgenticRun(fixture.host, fixture.context(), {
  projectDirectory: directory!,
  run: { id: 'recovery', mode: mode as 'start' | 'resume' },
});
