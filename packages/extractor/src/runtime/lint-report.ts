import { DEFAULT_RECORD_PATH } from '../constants.js';
import type { ApiResourceSpec } from '../types/index.js';
import type { ControlLogger } from './control.js';
import { validateRecords } from './response-validator.js';
import { detectDrift, inferColumns } from './schema-inference.js';

interface LintReportInput {
  resource: ApiResourceSpec;
  rawRecords: unknown[];
  pageData: unknown;
  logger: ControlLogger;
}

/**
 * Emit lint + schema-drift warnings against the first page of a resource. Pulled
 * out of extract.ts so the orchestrator stays under the file-size budget; the
 * warning shapes are unchanged.
 */
export async function emitLintAndDriftWarnings({
  resource,
  rawRecords,
  pageData,
  logger,
}: LintReportInput): Promise<void> {
  if (rawRecords.length === 0) return;

  // Contextual fields are authoritative mapped values, not API payload
  // fields. Keep them declared for extra-field detection, while the validator
  // skips raw-value/null checks for those origins.
  const report = validateRecords(rawRecords, resource.output);
  if (report.issues.length > 0) {
    await logger.warn(
      `Lint (${resource.name}): ${report.issues.length} issue(s) in ${report.recordsChecked} records`
    );
    for (const issue of report.issues) {
      const sample = issue.sample !== undefined ? ` (sample: ${JSON.stringify(issue.sample)})` : '';
      await logger.warn(`  ${issue.field}: ${issue.issue} x${issue.count}${sample}`);
    }
  }

  const recordPath = resource.extract.record_path ?? DEFAULT_RECORD_PATH;
  const contextualNames = new Set(
    Object.entries(resource.output)
      .filter(([, field]) => field.from !== undefined)
      .map(([name]) => name)
  );
  const inferred = inferColumns(pageData, recordPath).filter(
    (field) => !contextualNames.has(field.name)
  );
  if (inferred.length === 0) return;

  const declaredFields = Object.entries(resource.output)
    .filter(([name]) => !contextualNames.has(name))
    .map(([name, field]) => ({
      name,
      type: field.type,
    }));
  const drift = detectDrift(inferred, declaredFields);
  const lines = [
    drift.newFields.length > 0 ? `  New fields: ${drift.newFields.join(', ')}` : undefined,
    drift.removedFields.length > 0
      ? `  Removed fields: ${drift.removedFields.join(', ')}`
      : undefined,
    ...drift.typeChanges.map(
      (c) => `  Type change: ${c.field} (declared: ${c.declared}, observed: ${c.observed})`
    ),
  ].filter((line): line is string => line !== undefined);
  if (lines.length === 0) return;

  await logger.warn(`Schema drift (${resource.name}):`);
  for (const line of lines) {
    await logger.warn(line);
  }
}
