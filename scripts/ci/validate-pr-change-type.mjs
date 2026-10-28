import { readFileSync } from 'node:fs';

import { parseChangeType } from '../release/change-type.mjs';

const eventPath = process.env.GITHUB_EVENT_PATH;
const event = JSON.parse(readFileSync(eventPath, 'utf8'));
const body = event.pull_request?.body ?? '';

try {
  const changeType =
    event.pull_request?.user?.login === 'dependabot[bot]' ? 'dependencies' : parseChangeType(body);
  process.stdout.write(`Validated PR change type: ${changeType}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
