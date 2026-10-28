import { pathToFileURL } from 'node:url';

import {
  auditQueryEnumAlignment,
  renderQueryEnumAlignmentReport,
} from '../src/query-resources/enum-alignment.js';

async function main(): Promise<void> {
  const report = auditQueryEnumAlignment();
  const output = renderQueryEnumAlignmentReport(report);

  if (report.summary.errors > 0) {
    process.stderr.write(output);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
