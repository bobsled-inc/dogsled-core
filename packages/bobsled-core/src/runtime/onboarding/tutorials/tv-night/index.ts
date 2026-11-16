import type { TutorialDefinition } from '../../tutorial.js';
import { steps } from './steps.js';
import { lessons } from './lessons.js';
import { teaching, planned, teachingHtml } from './teaching.js';
import { descriptions, prompts } from './content.js';
import { renderAnswer, page } from './display.js';
import { prepareCheck, validate, normalizeRow } from './checks.js';
import { probeInputHash } from './probe-inputs.js';

export const tvNight: TutorialDefinition = {
  id: 'tv-night',
  skill: 'bobsled-tutorials',
  example: 'tv-night',
  dataDirectory: 'data/tv-night',
  databasePath: '.bobsled/bobsled.duckdb',
  steps,
  optionalSteps: ['resolve'],
  lessons,
  teaching,
  planned,
  descriptions,
  prompts,
  prepareCheck,
  normalizeRow,
  validate,
  probe: { step: 'connect', hash: probeInputHash },
  teachingHtml,
  renderAnswer,
  page,
  historyRows(record) {
    if (!['query', 'transform', 'resolve'].includes(record.step)) return undefined;
    return (
      (record.tables.find((table) => table.name === 'Recommendations') ?? record.tables[0])?.rows ??
      []
    )
      .slice(0, 5)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) =>
            ['id', 'show_id', 'name', 'theme', 'ending', 'reason', 'review_status', 'fit'].includes(
              key
            )
          )
        )
      );
  },
  sourceRows(source, state) {
    return source.name === 'TVmaze'
      ? (state.steps
          .find((s) => s.id === 'load' && s.status === 'complete')
          ?.evidence?.tables.reduce((sum, table) => sum + table.totalRows, 0) ?? 0)
      : source.name === 'Wikipedia'
        ? (state.steps.find((s) => s.id === 'federate' && s.status === 'complete')?.evidence
            ?.tables[0]?.totalRows ?? 0)
        : source.rows;
  },
};
