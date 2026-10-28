'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { EntityGraphSelectedPairContext } from '@/lib/entity-graph-assistant-ctx';

interface EntityGraphAssistantSpecInput {
  specName?: string | null;
  specYaml?: string | null;
}

interface EntityGraphAssistantContextValue {
  specName: string | null;
  specYaml: string | null;
  selectedPair: EntityGraphSelectedPairContext | null;
  /**
   * Shared "agent sample is in flight" flag. Both the resolve page header
   * button and the assistant rail button trigger the same agent-review
   * endpoint, so they must show one consistent loading state — otherwise the
   * rail button stays clickable while the header is already sampling.
   */
  agentReviewRunning: boolean;
  setAssistantSpec: (next: EntityGraphAssistantSpecInput) => void;
  clearAssistantSpec: () => void;
  setSelectedPair: (next: EntityGraphSelectedPairContext | null) => void;
  setAgentReviewRunning: (running: boolean) => void;
}

const EntityGraphAssistantContext = createContext<EntityGraphAssistantContextValue | null>(null);

export function EntityGraphAssistantProvider({ children }: { children: ReactNode }) {
  const [specName, setSpecName] = useState<string | null>(null);
  const [specYaml, setSpecYaml] = useState<string | null>(null);
  const [selectedPair, setSelectedPairState] = useState<EntityGraphSelectedPairContext | null>(
    null
  );
  const [agentReviewRunning, setAgentReviewRunningState] = useState(false);

  const setAssistantSpec = useCallback((next: EntityGraphAssistantSpecInput) => {
    setSpecName(next.specName ?? null);
    setSpecYaml(next.specYaml ?? null);
  }, []);

  const clearAssistantSpec = useCallback(() => {
    setSpecName(null);
    setSpecYaml(null);
  }, []);

  const setSelectedPair = useCallback((next: EntityGraphSelectedPairContext | null) => {
    setSelectedPairState(next);
  }, []);

  const setAgentReviewRunning = useCallback((running: boolean) => {
    setAgentReviewRunningState(running);
  }, []);

  return (
    <EntityGraphAssistantContext.Provider
      value={{
        specName,
        specYaml,
        selectedPair,
        agentReviewRunning,
        setAssistantSpec,
        clearAssistantSpec,
        setSelectedPair,
        setAgentReviewRunning,
      }}
    >
      {children}
    </EntityGraphAssistantContext.Provider>
  );
}

export function useEntityGraphAssistantContext(): EntityGraphAssistantContextValue {
  const value = useContext(EntityGraphAssistantContext);
  if (!value) {
    throw new Error(
      'useEntityGraphAssistantContext must be used inside EntityGraphAssistantProvider'
    );
  }
  return value;
}
