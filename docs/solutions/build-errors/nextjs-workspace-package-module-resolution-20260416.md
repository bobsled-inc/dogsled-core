---
module: explorer
date: 2026-04-16
problem_type: build_error
component: next.config.mjs, tsconfig.json, eslint.config.mjs
symptoms:
  - 'Cannot find module @bobsled-inc/integrations during Next.js build'
  - 'ERR_REQUIRE_ESM or ERR_MODULE_NOT_FOUND when importing workspace packages'
  - 'TypeScript errors about .js extension imports in Next.js context'
root_cause: Next.js bundler uses different module resolution than the monorepo NodeNext config
severity: high
tags: [nextjs, monorepo, pnpm, module-resolution, esm, workspace, transpile]
---

# Next.js Workspace Package Module Resolution in Monorepo

## Symptom

Adding a Next.js app to a pnpm monorepo that uses `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` in the root tsconfig causes multiple build failures:

1. `Cannot find module '@bobsled-inc/integrations'` — Next.js doesn't know how to resolve workspace packages
2. `ERR_REQUIRE_ESM` — Module format mismatch between Next.js bundler and workspace packages
3. TypeScript errors about missing `.js` extensions — The monorepo enforces `.js` extensions for ESM, but Next.js bundler doesn't need them
4. `yaml` and `tsx` packages bundled into client JS — Server-only packages bloating the client bundle

## Investigation

1. **Tried default Next.js config** — Workspace packages not resolved. Next.js doesn't traverse `node_modules` symlinks from pnpm by default.
2. **Tried `resolve.alias` in webpack config** — Partially worked but fragile. Breaks on package version changes.
3. **Tried setting `"type": "module"` in explorer's package.json** — Caused different ESM issues with Next.js internal imports.
4. **Tried `esmExternals: true`** — Didn't solve the workspace package resolution.

## Root Cause

Three conflicting module systems:

1. **Monorepo**: Uses `NodeNext` module resolution (requires `.js` extensions, strict ESM)
2. **Next.js**: Uses its own webpack/turbopack bundler with `bundler`-style resolution (no extensions needed)
3. **Workspace packages**: Compiled as ESM with `NodeNext`, symlinked via pnpm

Next.js needs explicit configuration to bridge these differences.

## Solution

Three config overrides in the Explorer app:

**1. `next.config.mjs`** — Tell Next.js to transpile workspace packages and exclude server-only packages:

```javascript
const nextConfig = {
  transpilePackages: ['@bobsled-inc/integrations', '@bobsled-inc/models', '@bobsled-inc/protocol'],
  serverExternalPackages: ['yaml', 'tsx'],
};
```

- `transpilePackages` tells Next.js to include these packages in its own compilation pipeline instead of treating them as pre-built externals
- `serverExternalPackages` keeps `yaml` (used by integration YAML parsing) and `tsx` (used for CLI spawning fallback) out of the client bundle

**2. `tsconfig.json`** — Override module resolution for Next.js compatibility:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve"
  }
}
```

- `"moduleResolution": "bundler"` aligns TypeScript's resolution with Next.js bundler behavior
- Overrides the monorepo's `"NodeNext"` which requires `.js` file extensions

**3. `eslint.config.mjs`** — Disable the monorepo's import extension rule:

```javascript
// Disable bobsled/import-extension rule — Next.js bundler handles resolution
{ rules: { 'bobsled/import-extension': 'off' } }
```

The monorepo enforces `.js` extensions on all imports for Node.js ESM compatibility. Next.js bundler resolves imports without extensions, so this rule produces false errors.

## Prevention

1. **Document the pattern** — Any new Next.js app in the monorepo needs the same three overrides
2. **Check `transpilePackages`** — When adding a new workspace dependency to the Explorer, add it to this array
3. **Test with `pnpm build`** — The production build catches module resolution issues that dev mode silently handles
4. **Keep `serverExternalPackages` updated** — Any new server-only dependency (native bindings, large parsers) should be listed here to prevent client bundle bloat

## Related Issues

- pnpm symlink resolution: pnpm uses symlinks for workspace packages, which some bundlers don't follow
- The `@bobsled-inc/protocol` package is types-only but still needs transpilation for its type exports
- `pnpm-workspace.yaml` was updated to add `apps/*` glob for the Explorer
