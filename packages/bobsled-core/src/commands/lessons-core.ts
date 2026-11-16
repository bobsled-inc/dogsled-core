import type { Lesson } from './lessons.js';
import { PHASE_0_LESSONS } from './lessons-core-phase-0.js';
import { PHASE_1_LESSONS } from './lessons-core-phase-1.js';
import { INGEST_LESSONS } from './lessons-core-ingest.js';
import { PHASE_2_LESSONS } from './lessons-core-phase-2.js';
import { PHASE_3_LESSONS } from './lessons-core-phase-3.js';
import { PHASE_4_LESSONS } from './lessons-core-phase-4.js';
import { PHASE_5_LESSONS } from './lessons-core-phase-5.js';
import { PHASE_6_LESSONS } from './lessons-core-phase-6.js';

export const CORE_LESSONS: Lesson[] = [
  ...PHASE_0_LESSONS,
  ...PHASE_1_LESSONS,
  ...INGEST_LESSONS,
  ...PHASE_2_LESSONS,
  ...PHASE_3_LESSONS,
  ...PHASE_4_LESSONS,
  ...PHASE_5_LESSONS,
  ...PHASE_6_LESSONS,
];
