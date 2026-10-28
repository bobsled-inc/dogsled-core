# @bobsled-inc/models

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Installable semantic bundles for Dogsled integrations. Each bundle turns integration
resources into generated source definitions, staging models, curated marts,
named metrics, and declared relationships that can be reviewed and committed
with the rest of a Dogsled project.

## Install

Install `@bobsled-inc/dogsled`; this code ships inside it.

## Usage

Install a complete bundle through the Dogsled CLI:

```bash
dogsled model models list
dogsled model models info stripe
dogsled model models install stripe
```

Use `--metrics-dir` or `--relationships-dir` with `models install` when the
project config places semantic metadata outside the default directories.

You can also install bundles programmatically:

```typescript
import { getModelPackage, installModelPackage, listModelPackages } from '@bobsled-inc/models';

const available = listModelPackages();
const github = getModelPackage('github');

installModelPackage(github.name, {
  cwd: process.cwd(),
  overwrite: false,
});
```

The package includes bundled model definitions under `marts/`. A bundle can
also include `metrics/` and `relationships/` subdirectories. Installation writes
those definitions to the project's corresponding Model Spec directories.

## Development

```bash
pnpm --filter @bobsled-inc/models build
pnpm --filter @bobsled-inc/models typecheck
pnpm --filter @bobsled-inc/models test:unit
```
