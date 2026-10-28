# @bobsled-inc/document-parsers

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Deterministic document parsing, chunking, and identity helpers used by Dogsled
ingestion. The default registry supports text, Markdown, HTML, PDF, DOCX, PPTX,
and email documents.

## Install

Install `@bobsled-inc/dogsled`; this code ships inside it.

## Usage

```typescript
import { createDefaultRegistry, sha256Hex } from '@bobsled-inc/document-parsers';

const bytes = new TextEncoder().encode('# Quarterly update');
const parser = createDefaultRegistry();
const result = await parser.parse('update.md', bytes, {
  sourceUri: 'file:./update.md',
  contentHash: sha256Hex(bytes),
});
```

Parsers return a structured success or error result instead of throwing for
invalid document content.

## Development

```bash
pnpm --filter @bobsled-inc/document-parsers build
pnpm --filter @bobsled-inc/document-parsers typecheck
pnpm --filter @bobsled-inc/document-parsers test:unit
```
