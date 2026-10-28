'use client';

import { useEffect, useState } from 'react';
import { JOURNEYS, getJourneyById, type Journey } from '@/lib/journeys';

interface JourneyProgressState {
  currentStep: number;
  completedSteps: number[];
}

interface JourneyState {
  activeJourneyId: string | null;
  journeys: Record<string, JourneyProgressState>;
}

interface StartJourneyOptions {
  reset?: boolean;
  step?: number;
}

export const JOURNEY_STORAGE_KEY = 'dogsled-explorer-journey-state';

const JOURNEY_EVENT = 'dogsled-explorer:journey-change';
const EMPTY_STATE: JourneyState = { activeJourneyId: null, journeys: {} };

function isValidStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function clampStep(step: number, journey: Journey): number {
  if (journey.steps.length === 0) return 0;
  if (!Number.isInteger(step)) return 0;
  return Math.max(0, Math.min(step, journey.steps.length - 1));
}

function sanitizeProgress(value: unknown, journey: Journey): JourneyProgressState {
  if (typeof value !== 'object' || value === null) {
    return { currentStep: 0, completedSteps: [] };
  }

  const record = value as Record<string, unknown>;
  const completedSteps = Array.isArray(record['completedSteps'])
    ? [...new Set(record['completedSteps'].filter(isValidStep))]
        .map((step) => clampStep(step, journey))
        .sort((left, right) => left - right)
    : [];

  return {
    currentStep: isValidStep(record['currentStep']) ? clampStep(record['currentStep'], journey) : 0,
    completedSteps,
  };
}

function readJourneyState(): JourneyState {
  if (typeof window === 'undefined') return EMPTY_STATE;

  try {
    const raw = window.localStorage.getItem(JOURNEY_STORAGE_KEY);
    if (!raw) return EMPTY_STATE;

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATE;

    const record = parsed as Record<string, unknown>;
    const activeJourneyId =
      typeof record['activeJourneyId'] === 'string' && getJourneyById(record['activeJourneyId'])
        ? record['activeJourneyId']
        : null;

    const journeysRecord = record['journeys'];
    const journeys: Record<string, JourneyProgressState> = {};

    if (typeof journeysRecord === 'object' && journeysRecord !== null) {
      for (const journey of JOURNEYS) {
        journeys[journey.id] = sanitizeProgress(
          (journeysRecord as Record<string, unknown>)[journey.id],
          journey
        );
      }
    }

    return { activeJourneyId, journeys };
  } catch {
    return EMPTY_STATE;
  }
}

function writeJourneyState(nextState: JourneyState) {
  try {
    window.localStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // localStorage can throw on quota exhaustion or private-mode.
    // Persistence is best-effort for a demo tool; swallow and continue.
  }
  window.dispatchEvent(new Event(JOURNEY_EVENT));
}

function getProgressForJourney(state: JourneyState, journeyId: string): JourneyProgressState {
  const journey = getJourneyById(journeyId);
  if (!journey) return { currentStep: 0, completedSteps: [] };
  return state.journeys[journeyId] ?? { currentStep: 0, completedSteps: [] };
}

export function useJourney() {
  const [state, setState] = useState<JourneyState>(EMPTY_STATE);

  useEffect(() => {
    const syncState = () => {
      setState(readJourneyState());
    };

    syncState();
    window.addEventListener('storage', syncState);
    window.addEventListener(JOURNEY_EVENT, syncState);
    return () => {
      window.removeEventListener('storage', syncState);
      window.removeEventListener(JOURNEY_EVENT, syncState);
    };
  }, []);

  const activeJourney = state.activeJourneyId
    ? (getJourneyById(state.activeJourneyId) ?? null)
    : null;
  const activeProgress = activeJourney
    ? getProgressForJourney(state, activeJourney.id)
    : { currentStep: 0, completedSteps: [] };
  const activeStep = activeJourney?.steps[activeProgress.currentStep] ?? null;

  const startJourney = (journeyId: string, options?: StartJourneyOptions) => {
    const journey = getJourneyById(journeyId);
    if (!journey) return;

    const currentState = readJourneyState();
    const previous = getProgressForJourney(currentState, journeyId);
    const requestedStep =
      typeof options?.step === 'number'
        ? clampStep(options.step, journey)
        : options?.reset === true
          ? 0
          : previous.currentStep;

    const nextProgress =
      options?.reset === true
        ? { currentStep: requestedStep, completedSteps: [] }
        : {
            currentStep: requestedStep,
            completedSteps:
              typeof options?.step === 'number'
                ? previous.completedSteps.filter((step) => step <= requestedStep)
                : previous.completedSteps,
          };

    writeJourneyState({
      activeJourneyId: journeyId,
      journeys: {
        ...currentState.journeys,
        [journeyId]: nextProgress,
      },
    });
  };

  const setCurrentStep = (step: number, journeyId = state.activeJourneyId) => {
    if (!journeyId) return;
    const journey = getJourneyById(journeyId);
    if (!journey) return;

    const currentState = readJourneyState();
    const previous = getProgressForJourney(currentState, journeyId);
    writeJourneyState({
      activeJourneyId: journeyId,
      journeys: {
        ...currentState.journeys,
        [journeyId]: {
          ...previous,
          currentStep: clampStep(step, journey),
        },
      },
    });
  };

  const markStepComplete = (
    step = activeProgress.currentStep,
    journeyId = state.activeJourneyId
  ) => {
    if (!journeyId) return;
    const journey = getJourneyById(journeyId);
    if (!journey) return;

    const currentState = readJourneyState();
    const previous = getProgressForJourney(currentState, journeyId);
    const nextStep = clampStep(step, journey);
    const completedSteps = [...new Set([...previous.completedSteps, nextStep])].sort(
      (left, right) => left - right
    );

    writeJourneyState({
      activeJourneyId: journeyId,
      journeys: {
        ...currentState.journeys,
        [journeyId]: {
          ...previous,
          currentStep: previous.currentStep,
          completedSteps,
        },
      },
    });
  };

  const advanceStep = (journeyId = state.activeJourneyId) => {
    if (!journeyId) return;
    const journey = getJourneyById(journeyId);
    if (!journey) return;

    const currentState = readJourneyState();
    const previous = getProgressForJourney(currentState, journeyId);
    const nextStep = clampStep(previous.currentStep + 1, journey);

    writeJourneyState({
      activeJourneyId: journeyId,
      journeys: {
        ...currentState.journeys,
        [journeyId]: {
          ...previous,
          currentStep: nextStep,
        },
      },
    });
  };

  const resetJourney = (journeyId = state.activeJourneyId) => {
    if (!journeyId) {
      writeJourneyState(EMPTY_STATE);
      return;
    }

    const currentState = readJourneyState();
    const { [journeyId]: _, ...remaining } = currentState.journeys;
    writeJourneyState({
      activeJourneyId:
        currentState.activeJourneyId === journeyId ? null : currentState.activeJourneyId,
      journeys: remaining,
    });
  };

  const getProgress = (journeyId: string) => {
    const journey = getJourneyById(journeyId);
    if (!journey) {
      return {
        completedCount: 0,
        currentStep: 0,
        totalSteps: 0,
        percent: 0,
        isActive: false,
        isComplete: false,
      };
    }

    const progress = getProgressForJourney(state, journeyId);
    const completedCount = progress.completedSteps.length;
    const totalSteps = journey.steps.length;
    return {
      completedCount,
      currentStep: progress.currentStep,
      totalSteps,
      percent: totalSteps === 0 ? 0 : Math.round((completedCount / totalSteps) * 100),
      isActive: state.activeJourneyId === journeyId,
      isComplete: completedCount >= totalSteps && totalSteps > 0,
    };
  };

  return {
    activeJourney,
    activeStep,
    activeStepIndex: activeProgress.currentStep,
    completedSteps: activeProgress.completedSteps,
    state,
    startJourney,
    setCurrentStep,
    markStepComplete,
    advanceStep,
    getProgress,
    resetJourney,
  };
}
