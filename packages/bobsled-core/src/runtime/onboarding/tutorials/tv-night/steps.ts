import type { StepId } from '../../schema.js';
export const steps: { id: StepId; label: string }[] = [
  { id: 'connect', label: 'Connect to an API' },
  { id: 'load', label: 'Build an ETL pipeline' },
  { id: 'model', label: 'Build semantic models' },
  { id: 'query', label: 'Query your data' },
  { id: 'federate', label: 'Query across sources' },
  { id: 'transform', label: 'Build an agentic transformation' },
  { id: 'resolve', label: 'Optional: entity resolution' },
];
