import { readFileSync } from 'node:fs';

import { changeTypeForPullRequest } from '../release/change-type.mjs';

const eventPath = process.env.GITHUB_EVENT_PATH;
const event = JSON.parse(readFileSync(eventPath, 'utf8'));

try {
  const changeType = changeTypeForPullRequest(event.pull_request);
  process.stdout.write(`Validated PR change type: ${changeType}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
