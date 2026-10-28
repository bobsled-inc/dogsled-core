---
module: explorer
date: 2026-04-16
problem_type: ui_bug
component: pipelines/page.tsx, pipelines/export/page.tsx, terminal/page.tsx
symptoms:
  - 'Pipeline config lost when navigating from builder to export page'
  - 'Export page shows demo data instead of user-configured pipeline'
  - 'No way to deep-link to a specific pipeline configuration'
root_cause: Multi-page wizard needs cross-page state without backend persistence or global state management
severity: medium
tags: [state-management, url-params, base64, nextjs, wizard, deep-linking]
---

# Cross-Page State via Base64 URL Parameters

## Symptom

The pipeline builder is a 6-step wizard on `/pipelines`. When the user clicks "Export" in the review step, they navigate to `/pipelines/export`. The export page needs the full pipeline configuration (selected integrations, per-integration resources, destination config, schedule) to generate dogsled.yml and CLI commands. Without state transfer, the export page shows demo data.

Similarly, clicking "Run in Terminal" from the export page should navigate to `/terminal` and auto-execute the pipeline command. The terminal needs to know which command to run.

## Investigation

1. **Considered React Context / Zustand** — Would work within a single page tree, but the pipeline builder and export page are separate routes. Context doesn't persist across navigation.
2. **Considered localStorage** — Works but creates hidden coupling. State can become stale. No deep-linking support. Race conditions possible.
3. **Considered server-side session** — Overkill for a local dev tool. Adds server state management complexity.
4. **Considered query parameters** — Simple but pipeline config is a complex nested object that doesn't serialize cleanly to individual query params.

## Root Cause

Next.js App Router pages are independent route segments. State doesn't naturally flow between them. The pipeline config is a structured object (~200-500 bytes as JSON) that needs to survive a full page navigation.

## Solution

Encode the entire config as a single base64 URL search parameter:

**Sender** (pipeline builder → export):

```typescript
const configParam = btoa(JSON.stringify(config));
<Link href={`/pipelines/export?config=${configParam}`}>Export</Link>
```

**Receiver** (export page):

```typescript
const encoded = searchParams.get('config');
let config = DEMO_CONFIG;
if (encoded) {
  try {
    config = JSON.parse(atob(encoded)) as PipelineConfig;
  } catch {
    // Fall back to demo config on malformed input
  }
}
```

**Chained navigation** (export → terminal):

```typescript
function buildRunCommand(config: PipelineConfig): string {
  const parts = ['pipeline', config.selectedIntegrations[0]];
  // ... add --dest, --db-path, --only flags
  return parts.join(' ');
}

<Link href={`/terminal?cmd=${encodeURIComponent(buildRunCommand(config))}`}>
  Run in Terminal
</Link>
```

**Terminal auto-execution**:

```typescript
const autoRunRef = useRef(false);

useEffect(() => {
  if (autoRunRef.current) return;
  const cmd = searchParams.get('cmd');
  if (cmd) {
    autoRunRef.current = true;
    const [command, ...args] = cmd.trim().split(/\s+/);
    if (command) run(command, args);
  }
}, [searchParams, run]);
```

Key design decisions:

- **`btoa`/`atob`** — Native browser APIs, zero dependencies
- **Graceful fallback** — Malformed or missing params show demo config, not errors
- **`useRef` guard** — Prevents re-execution on React re-renders
- **`Suspense` wrapper** — Required by Next.js when using `useSearchParams()` in client components
- **`encodeURIComponent`** — The terminal `?cmd=` param contains spaces and special characters

## Prevention

1. **Always wrap `useSearchParams()` in Suspense** — Next.js 15 requires this for static optimization
2. **Always provide fallback data** — Never assume the URL param exists or is valid
3. **Use `useRef` for one-shot effects** — Prevents double-execution in React strict mode
4. **Keep payloads small** — Base64 adds ~33% overhead. For configs over ~2KB, consider compression or a different approach
5. **URL length limits** — Most browsers support ~8KB URLs. Pipeline configs are well under this limit.

## Related Issues

- This pattern is also used by the agent page for passing conversation context
- For larger state, consider `window.history.state` (not shareable) or IndexedDB (persistent)
