import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { renderOnboardingHtml } from '../src/runtime/onboarding/render.js';
import { previewScenarios } from './onboarding-preview-fixtures.js';
import { reviewPage } from './onboarding-preview-page.js';

// Output is a dedicated review folder, never the learner's onboarding artifact.
const output = resolve(process.argv[2] ?? '.dogsled/ui-review');
await mkdir(output, { recursive: true });
const scenarios = previewScenarios();
for (const scenario of scenarios) {
  const html = renderOnboardingHtml(scenario.snapshot);
  for (const theme of ['light', 'dark', 'system']) {
    const themed =
      theme === 'system'
        ? html
        : html
            .replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
            .replace(`<option value="${theme}">`, `<option value="${theme}" selected>`);
    await writeFile(join(output, `${scenario.id}-${theme}.html`), themed);
  }
}
await writeFile(join(output, 'index.html'), reviewPage(scenarios));
process.stdout.write(
  `Visual review: ${join(output, 'index.html')}\n${scenarios.length} scenarios · light/dark/system · fit/1280/750/390/320 px\n`
);
