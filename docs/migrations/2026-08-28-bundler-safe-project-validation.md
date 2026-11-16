# Migration — Bundler-safe project validation

**Date:** 2026-08-28 · **Affected package:** `@bobsled-inc/bobsled-core`

Dogsled's project compiler now carries its built-in source-validation metadata as generated
JavaScript. `resolveProjectPipelines()` and `generateProjectManifest()` no longer discover the
catalog through runtime reads of the integrations package's `sources/**/*.yml` files.

## Consumer contract

Server applications should continue to import the project compiler from Dogsled's public manifest
surface:

```typescript
import { generateProjectManifest } from '@bobsled-inc/bobsled-core/manifest';

const manifest = await generateProjectManifest({ projectRoot });
```

This path validates built-in sources, resources, transports, entity variants, resource inputs,
incremental metadata, and `for_each` relationships without loading Dogsled's extractor, connections,
loader, embedder runtime, DuckDB, or integration YAML assets.

The built-in metadata is the default. Hosts with a separate catalog can inject the documented
lightweight interface:

```typescript
import { generateProjectManifest } from '@bobsled-inc/bobsled-core/manifest';
import type { ValidationCatalog } from '@bobsled-inc/bobsled-core/validation';

const validationCatalog: ValidationCatalog = createHostCatalog();
const manifest = await generateProjectManifest({ projectRoot, validationCatalog });
```

Injection is optional and is not required to make a server bundle work.
