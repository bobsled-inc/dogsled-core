# @bobsled-inc/ai

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Provider-neutral AI primitives for Dogsled. The package resolves configured model
roles, enforces call and daily budgets, and exposes structured generation,
streaming, and embedding helpers.

## Install

```bash
npm install @bobsled-inc/dogsled
```

## Usage

```typescript
import { generateStructured, resolveModelConnection } from '@bobsled-inc/dogsled/ai';

const connection = resolveModelConnection('default', config);

const result = await generateStructured(connection, {
  schema,
  prompt: 'Return the requested structured result.',
});
```

Provider credentials are resolved through Dogsled connection configuration. Do not
put raw credentials in project files.

## Bounded structured calls

`generateStructured` accepts `abortSignal`, `maxOutputTokens`, and `maxRetries`.
Set `maxRetries: 0` when a host records each attempt itself. The optional `usage`
field contains measured input, output, and total tokens. It can also be present
on failures. When it is absent, usage is unknown. Do not treat the legacy
`tokenUsage` fallback as a measured count.

Cost budgets remain enforced by default. A host that owns a token budget can
explicitly pass `{ costBudgetMode: 'observe' }` as the third argument. This skips
cost limits and only reports estimated cost. Provider model objects resolve on
first use, so a text call does not require an embedding model.

## Embedding dimension

`embedMany` asks for `connection.dimension` when the model is known to take one: OpenAI
`text-embedding-3-*`, Google `gemini-embedding-*`, Bedrock Titan Text v2 and Cohere Embed v4,
and Ollama. It sends no dimension otherwise.

## Host-supplied embeddings

`connectHostEmbedding({ url, token })` connects to an embedding model that a host
application serves. It asks for the model and limits before any text is sent, then
`embed(texts)` sends batches and returns a vector, or `null`, for each text.
[Host-supplied embeddings](../../docs/reference/host-embeddings.md) is the contract.

## Development

```bash
pnpm --filter @bobsled-inc/ai build
pnpm --filter @bobsled-inc/ai typecheck
pnpm --filter @bobsled-inc/ai test:unit
```
