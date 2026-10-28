interface ActiveEntityGraphRun {
  runId: string;
  cancel: () => void;
}

let activeRun: ActiveEntityGraphRun | null = null;

export function claimEntityGraphRun(runId: string, cancel: () => void): boolean {
  if (activeRun) {
    return false;
  }

  activeRun = { runId, cancel };
  return true;
}

export function getActiveEntityGraphRunId(): string | null {
  return activeRun?.runId ?? null;
}

export function cancelEntityGraphRun(runId: string): boolean {
  if (activeRun?.runId !== runId) {
    return false;
  }

  activeRun.cancel();
  return true;
}

export function releaseEntityGraphRun(runId: string): void {
  if (activeRun?.runId === runId) {
    activeRun = null;
  }
}

export function resetEntityGraphRunManagerForTests(): void {
  activeRun = null;
}
