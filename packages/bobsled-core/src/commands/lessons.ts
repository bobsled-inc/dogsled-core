import { CORE_LESSONS } from './lessons-core.js';
import { ENTITY_ADVANCED_LESSONS } from './lessons-entity-advanced.js';

export type LessonCwd = 'repo' | 'lab' | 'shop' | 'entity' | 'learn-sandbox' | 'first-ingest';

export interface Lesson {
  id: string;
  title: string;
  type?: 'note';
  body?: string[];
  section: string;
  cwd?: LessonCwd;
  command?: string;
  envMode?: 'all' | 'any';
  env?: string[];
  requiredEnv?: {
    all?: string[];
    any?: string[];
  };
  why: string;
  think: string;
}

export const LESSONS: Lesson[] = [...CORE_LESSONS, ...ENTITY_ADVANCED_LESSONS];
