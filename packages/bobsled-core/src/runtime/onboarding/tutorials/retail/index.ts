import type { TutorialDefinition } from '../../tutorial.js';
import { steps, lessons, descriptions, prompts, teaching, planned } from './content.js';
import { prepareCheck, validate } from './checks.js';
import { page, renderAnswer } from './display.js';
export const retail: TutorialDefinition = {
  id: 'retail',
  skill: 'bobsled-retail',
  example: 'retail',
  dataDirectory: 'data/retail',
  databasePath: 'data.duckdb',
  steps,
  optionalSteps: [],
  lessons,
  descriptions,
  prompts,
  teaching,
  planned,
  prepareCheck,
  validate,
  page,
  renderAnswer,
  teachingHtml: {},
  historyRows: (record) =>
    ['query', 'transform'].includes(record.step) ? record.tables[0]?.rows.slice(0, 5) : undefined,
  sourceRows(source, state) {
    if (source.name === 'Warehouse exports') {
      return (
        state.steps
          .find((step) => step.id === 'load' && step.status === 'complete')
          ?.evidence?.tables[0]?.rows.reduce((sum, row) => sum + Number(row.row_count), 0) ?? 0
      );
    }
    if (source.name === 'Retail API') {
      return (
        state.steps.find((step) => step.id === 'connect' && step.status === 'complete')?.evidence
          ?.tables[0]?.totalRows ?? 0
      );
    }
    return source.rows;
  },
};
