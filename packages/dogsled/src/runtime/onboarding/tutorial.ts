import type {
  Checkpoint,
  Evidence,
  OnboardingSnapshot,
  OnboardingState,
  StepId,
} from './schema.js';

export type CheckOptions = Record<string, unknown>;
export interface CheckPlan {
  queries: { name: string; sql: string }[];
  remote: boolean;
  persist: boolean;
  receipts: string[];
}
export interface TableDisplay {
  passageColumns: string[];
  passageLabel: string;
  columnWidths: Record<string, number>;
  emptyDescription: string;
}
/** Built-in code only. Project manifests select an ID; they cannot load code. */
export interface TutorialDefinition {
  id: string;
  skill: string;
  example: string;
  dataDirectory: string;
  databasePath: string;
  steps: { id: StepId; label: string }[];
  optionalSteps: StepId[];
  lessons: Record<StepId, { learn: string; files: string[]; choice: string; inspect: string }>;
  teaching: Record<
    StepId,
    {
      code: [string, string][];
      now: string;
      next: string;
      questions: string[];
      beforeNext?: string;
    }
  >;
  planned: Record<StepId, string>;
  descriptions: Record<StepId, string>;
  prompts: Record<StepId, string>;
  probe?: { step: StepId; hash: (root: string) => Promise<string> };
  prepareCheck: (step: StepId, options: CheckOptions) => CheckPlan;
  normalizeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  validate: (step: StepId, tables: Evidence['tables'], options: CheckOptions) => void;
  historyRows: (record: Checkpoint) => Evidence['tables'][number]['rows'] | undefined;
  sourceRows: (source: OnboardingSnapshot['sources'][number], state: OnboardingState) => number;
  renderAnswer: (snapshot: OnboardingSnapshot) => string;
  /** Trusted static markup, never read from project files. */
  teachingHtml: Record<StepId, string>;
  page: {
    title: string;
    labels: Record<StepId, string>;
    titles: Record<StepId, string>;
    expandedTeaching: StepId[];
    fallbackSource: string;
    noQuestion: string;
    preferencesLabel: string;
    noSources: string;
    intro: string;
    table: TableDisplay;
  };
}
