---
module: explorer
date: 2026-04-19
problem_type: ui_bug
component: lib/use-command.ts, terminal/page.tsx, integrations/[name]/page.tsx
symptoms:
  - 'Starting a new Explorer command can make the newer run look stopped immediately'
  - 'Health-check and terminal views can receive completion timestamps from an older aborted request'
  - 'Run history can capture timing from the wrong command session when one run interrupts another'
root_cause: The shared command hook allowed stale async callbacks from aborted requests to keep mutating the latest command state
severity: medium
tags: [react, async-state, abortcontroller, sse, command-runner, nextjs]
---

# Stale Command State After Abort in Explorer

## Symptom

Explorer pages share `useCommand()` for streamed CLI execution. That worked for a single run, but once the hook started tracking `startedAt` and `completedAt`, a previously aborted run could still land late state updates after a newer run had already started.

Observable behavior:

- Start one command, then quickly start another.
- The first request is aborted, but its `catch` or stream-finalization callback still fires later.
- The newer run flips to `running: false`, inherits the wrong completion timestamp, or looks finished before its SSE stream is done.

This showed up most clearly in the terminal and the integration health-check UI because both pages can trigger back-to-back commands.

## Investigation

1. The original hook only ignored `AbortError`, so aborting an older run did not overwrite state.
2. Adding completion timestamps introduced new `setState()` calls in the abort and finalization paths.
3. Those updates were still keyed to shared hook state rather than to a specific invocation.
4. That meant an older request could mutate the current run if its async cleanup resolved after a newer invocation had already replaced the controller.

## Root Cause

`AbortController` cancels the request, but it does not cancel already scheduled JavaScript callbacks. The hook needed an invocation identity check, not just controller replacement. Without that guard, any late callback from an older run could update the shared React state for the latest run.

## Solution

Track each invocation with a monotonically increasing `runIdRef` and only apply async updates when they still belong to the active run.

Key changes:

```ts
const runIdRef = useRef(0);

const run = useCallback(async (command: string, args: string[]) => {
  const runId = runIdRef.current + 1;
  runIdRef.current = runId;
  abortRef.current?.abort();

  const setStateIfCurrent = (updater: (current: CommandState) => CommandState) => {
    setState((current) => (runId === runIdRef.current ? updater(current) : current));
  };

  // use setStateIfCurrent(...) in exit, error, stream-end, and catch paths
}, []);
```

Also invalidate in-flight callbacks when the user explicitly stops or clears:

```ts
const stop = useCallback(() => {
  abortRef.current?.abort();
  abortRef.current = null;
  runIdRef.current += 1;
  setState((s) => ({ ...s, running: false, completedAt: Date.now() }));
}, []);
```

This keeps timing, status, and output ownership tied to the correct run even when requests overlap.

## Prevention

1. Any shared async hook that can be re-entered needs request identity, not just an `AbortController`.
2. When adding timestamps or terminal lifecycle fields, re-check whether aborted work can still call `setState()`.
3. Invalidate outstanding callbacks on both `stop()` and `clear()`, not only when a new run starts.
4. When a hook powers multiple pages, test the “start run B before run A settles” path explicitly.

## Related Issues

- [Delegated CLI Test Close Race](../2026-04-06-delegated-cli-test-close-race.md)
