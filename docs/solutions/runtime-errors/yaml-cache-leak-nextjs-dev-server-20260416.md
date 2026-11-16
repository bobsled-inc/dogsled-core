---
module: explorer
date: 2026-04-16
problem_type: runtime_error
component: lib/integrations.ts, lib/models.ts
symptoms:
  - 'Stale integration/model data returned after YAML files are edited'
  - 'Memory usage grows steadily in Next.js dev server over time'
  - 'API routes return outdated resource counts or missing integrations'
root_cause: Workspace packages cache parsed YAML in module-level Maps that persist across requests in long-running Next.js dev server
severity: high
tags: [nextjs, caching, memory-leak, yaml, dev-server, workspace-packages]
---

# YAML Cache Leak in Long-Running Next.js Dev Server

## Symptom

After editing integration or model YAML files, the Explorer API routes continue returning stale data. Restarting the dev server fixes it. Over long dev sessions, memory usage climbs steadily.

The root packages (`@bobsled-inc/integrations` and `@bobsled-inc/models`) use module-level `Map` caches for parsed YAML. In a short-lived CLI process, these caches are harmless. In a long-running Next.js dev server, they accumulate indefinitely.

## Investigation

1. **Direct imports worked in CLI** — `listIntegrations()` always returns fresh data when called from a `bobsled` CLI command because the process exits after each invocation.
2. **Hot reload didn't help** — Next.js hot module replacement reloads page components but not deep `node_modules` or workspace package singletons.
3. **Checked if Next.js had its own caching** — `fetch()` caching and `unstable_cache` are irrelevant here since the data comes from filesystem reads via workspace packages, not HTTP.

## Root Cause

Both `@bobsled-inc/integrations` (`packages/integrations/src/index.ts`) and `@bobsled-inc/models` (`packages/models/src/loader.ts`) maintain module-level `Map` objects that cache parsed YAML on first read. In the Next.js dev server (a single long-lived Node.js process), these maps persist across all HTTP requests. The caches:

1. **Never invalidate** — No file watcher or TTL mechanism
2. **Grow monotonically** — Each new integration/resource read adds to the cache
3. **Return stale data** — Edits to YAML files are invisible until server restart

## Solution

Created wrapper modules that guarantee cache clearing after every call using try-finally:

```typescript
// apps/explorer/src/lib/integrations.ts
import { listIntegrations as _listIntegrations, clearCache } from '@bobsled-inc/integrations';

export async function listIntegrations() {
  try {
    return await _listIntegrations();
  } finally {
    clearCache();
  }
}
```

Same pattern for all 6 integration functions and 2 model functions. The `finally` block ensures cleanup even if the underlying function throws.

**Critical rule:** Never import directly from `@bobsled-inc/integrations` or `@bobsled-inc/models` in Explorer code. Always use the `lib/integrations.ts` and `lib/models.ts` wrappers.

## Prevention

1. **Linting rule** — Could add an ESLint `no-restricted-imports` rule blocking direct imports from `@bobsled-inc/integrations` and `@bobsled-inc/models` in the Explorer package
2. **Code review checkpoint** — Any new API route importing integration/model data must use the wrappers
3. **Pattern awareness** — Any module-level cache in a library imported by a long-running server needs explicit clearing
4. **Documentation** — Added to `apps/explorer/CLAUDE.md` as a "Key Patterns" section

## Related Issues

- This is a general concern for any Next.js app consuming workspace packages with internal caches
- The `clearCache()` and `clearModelPackageCache()` exports already existed in the packages — the gap was that no caller was using them in a server context
