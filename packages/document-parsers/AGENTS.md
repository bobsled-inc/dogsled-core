# @bobsled-inc/document-parsers — Agent Guide

<!-- last-reviewed: 2026-09-08 -->

Format parsers, recursive chunking, and deterministic document identity helpers
used by extractor document resources.

## Contracts

- Parsers return `ParsedDocument | ParseError`; they never throw across the public
  parser boundary.
- Document, version, and chunk IDs are SHA-256 hashes over canonical inputs.
- `chunkerConfigHash()` is stable and intentionally invalidates downstream chunks
  when chunk configuration changes.
- The built-in parser surface extracts text from PDF, DOCX, PPTX, HTML, Markdown,
  text, and email without requiring hosted services.
- PDF stream `/Filter` chains are applied in declared order across
  `ASCII85Decode`, `ASCIIHexDecode`, `FlateDecode`, `LZWDecode`, and
  `RunLengthDecode`. A chain naming an image or unknown codec skips that stream;
  only a stage that rejects its input fails the document.

## Adding Or Changing A Parser

1. Implement `DocumentParser` under `src/parsers/`.
2. Register it in `src/registry.ts`.
3. Add fixture-driven coverage in `tests/parsers.test.ts`.
4. Bump `parserVersion` when observable parsing behavior changes.

Preserve non-throwing behavior and deterministic identities. Add dependencies to
the root catalog only when a standard-library implementation is insufficient.

## Verify

```bash
pnpm --filter @bobsled-inc/document-parsers build
pnpm --filter @bobsled-inc/document-parsers typecheck
pnpm --filter @bobsled-inc/document-parsers lint
pnpm --filter @bobsled-inc/document-parsers test:unit
```
