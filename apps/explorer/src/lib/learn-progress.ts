'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  LEARN_CURRICULUM_VERSION,
  LEARN_MODULES,
  getLearnModuleById,
  type LearnModule,
} from './learn-curriculum';

export const LEARN_PROGRESS_STORAGE_KEY = 'bobsled-explorer-learn-progress';
const LEARN_PROGRESS_EVENT = 'bobsled-explorer:learn-progress-change';

export interface LearnModuleProgress {
  completedStepIds: string[];
  lastStepId: string | null;
}

export interface LearnProgressState {
  version: string;
  modules: Record<string, LearnModuleProgress>;
}

const EMPTY_STATE: LearnProgressState = {
  version: LEARN_CURRICULUM_VERSION,
  modules: {},
};

function emptyModuleProgress(): LearnModuleProgress {
  return { completedStepIds: [], lastStepId: null };
}

function getValidStepIds(module: LearnModule): Set<string> {
  return new Set(module.steps.map((step) => step.id));
}

export function sanitizeLearnProgress(value: unknown): LearnProgressState {
  if (typeof value !== 'object' || value === null) {
    return EMPTY_STATE;
  }

  const record = value as Record<string, unknown>;
  if (record['version'] !== LEARN_CURRICULUM_VERSION) {
    return EMPTY_STATE;
  }

  const rawModules = record['modules'];
  const modules: Record<string, LearnModuleProgress> = {};

  if (typeof rawModules === 'object' && rawModules !== null) {
    for (const module of LEARN_MODULES) {
      const rawModule = (rawModules as Record<string, unknown>)[module.id];
      if (typeof rawModule !== 'object' || rawModule === null) {
        continue;
      }

      const validStepIds = getValidStepIds(module);
      const moduleRecord = rawModule as Record<string, unknown>;
      const completedStepIds = Array.isArray(moduleRecord['completedStepIds'])
        ? Array.from(
            new Set(
              moduleRecord['completedStepIds'].filter(
                (stepId): stepId is string => typeof stepId === 'string' && validStepIds.has(stepId)
              )
            )
          )
        : [];
      const lastStepId =
        typeof moduleRecord['lastStepId'] === 'string' &&
        validStepIds.has(moduleRecord['lastStepId'])
          ? moduleRecord['lastStepId']
          : null;

      modules[module.id] = { completedStepIds, lastStepId };
    }
  }

  return { version: LEARN_CURRICULUM_VERSION, modules };
}

export function readLearnProgress(): LearnProgressState {
  if (typeof window === 'undefined') {
    return EMPTY_STATE;
  }

  try {
    const raw = window.localStorage.getItem(LEARN_PROGRESS_STORAGE_KEY);
    if (!raw) {
      return EMPTY_STATE;
    }
    return sanitizeLearnProgress(JSON.parse(raw) as unknown);
  } catch {
    return EMPTY_STATE;
  }
}

function writeLearnProgress(nextState: LearnProgressState): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LEARN_PROGRESS_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // localStorage can throw in private mode or when quota is exhausted.
  }
  window.dispatchEvent(new Event(LEARN_PROGRESS_EVENT));
}

export function getLearnModuleProgress(
  state: LearnProgressState,
  moduleId: string
): LearnModuleProgress {
  return state.modules[moduleId] ?? emptyModuleProgress();
}

export function getLearnProgressSummary(state: LearnProgressState, moduleId: string) {
  const module = getLearnModuleById(moduleId);
  const progress = getLearnModuleProgress(state, moduleId);
  const totalSteps = module?.steps.length ?? 0;
  const completedCount = progress.completedStepIds.length;
  return {
    completedCount,
    totalSteps,
    percent: totalSteps === 0 ? 0 : Math.round((completedCount / totalSteps) * 100),
    isComplete: totalSteps > 0 && completedCount >= totalSteps,
    lastStepId: progress.lastStepId,
  };
}

export function useLearnProgress() {
  const [state, setState] = useState<LearnProgressState>(EMPTY_STATE);

  useEffect(() => {
    const syncState = () => {
      setState(readLearnProgress());
    };

    syncState();
    window.addEventListener('storage', syncState);
    window.addEventListener(LEARN_PROGRESS_EVENT, syncState);
    return () => {
      window.removeEventListener('storage', syncState);
      window.removeEventListener(LEARN_PROGRESS_EVENT, syncState);
    };
  }, []);

  const summaries = useMemo(
    () =>
      Object.fromEntries(
        LEARN_MODULES.map((module) => [module.id, getLearnProgressSummary(state, module.id)])
      ),
    [state]
  );

  const markStepComplete = (moduleId: string, stepId: string) => {
    const module = getLearnModuleById(moduleId);
    if (!module || !module.steps.some((step) => step.id === stepId)) {
      return;
    }

    const currentState = readLearnProgress();
    const previous = getLearnModuleProgress(currentState, moduleId);
    writeLearnProgress({
      version: LEARN_CURRICULUM_VERSION,
      modules: {
        ...currentState.modules,
        [moduleId]: {
          completedStepIds: Array.from(new Set([...previous.completedStepIds, stepId])),
          lastStepId: stepId,
        },
      },
    });
  };

  const setLastStep = (moduleId: string, stepId: string) => {
    const module = getLearnModuleById(moduleId);
    if (!module || !module.steps.some((step) => step.id === stepId)) {
      return;
    }

    const currentState = readLearnProgress();
    const previous = getLearnModuleProgress(currentState, moduleId);
    writeLearnProgress({
      version: LEARN_CURRICULUM_VERSION,
      modules: {
        ...currentState.modules,
        [moduleId]: {
          ...previous,
          lastStepId: stepId,
        },
      },
    });
  };

  const resetModule = (moduleId: string) => {
    const currentState = readLearnProgress();
    const { [moduleId]: _, ...remaining } = currentState.modules;
    writeLearnProgress({ version: LEARN_CURRICULUM_VERSION, modules: remaining });
  };

  return {
    state,
    summaries,
    markStepComplete,
    setLastStep,
    resetModule,
    getModuleProgress: (moduleId: string) => getLearnModuleProgress(state, moduleId),
    getSummary: (moduleId: string) => getLearnProgressSummary(state, moduleId),
  };
}
