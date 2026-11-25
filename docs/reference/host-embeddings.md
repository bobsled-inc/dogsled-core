# Host-supplied embeddings

A host application is a program that runs Dogsled as a library or starts its CLI. With
`provider: host`, the embedding model comes from that application. The project names no
provider, model or key, and Dogsled sends text to one endpoint that the application sets
for the run. This page is the contract for authors of host applications. To embed with a
provider and key of your own, see [Embeddings and AI providers](../guides/embeddings-and-ai.md).

## Configuration

```yaml
pipelines:
  handbook:
    schedule: manual
    source: files
    destination: local
    resources: [handbook]
    embed:
      provider: host
      dimension: 1024
      streams:
        handbook: [{ field: text }]
```

| Field           | Meaning                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `provider`      | `host`.                                                                                                                |
| `streams`       | The fields to embed, as for every provider. For a document Resource, the key is its name and the only field is `text`. |
| `dimension`     | Optional. The run fails before it writes anything when the host's model has another length. It is never sent.          |
| `auth_env_vars` | Accepted and unused, because the names a host declares are added to every embed block.                                 |

`model`, `api_key`, `region`, `base_url` and `cost_budget_usd` are refused. `platform.models`
has no host provider.

## Environment

The host application sets two variables in the run's environment:

| Variable                       | Value                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `DOGSLED_HOST_EMBEDDING_URL`   | The endpoint. An `https` URL without credentials, a fragment, spaces or control characters. |
| `DOGSLED_HOST_EMBEDDING_TOKEN` | A bearer token for it. Printable ASCII without spaces.                                      |

`@bobsled-inc/dogsled/pipeline` exports the names as `HOST_EMBEDDING_URL_ENV` and
`HOST_EMBEDDING_TOKEN_ENV`. A run that needs them and has only one, or neither, stops with
a validation error before it starts anything.

The endpoint must use `https`, also on the same machine, and its certificate is checked:
with `NODE_TLS_REJECT_UNAUTHORIZED=0` Dogsled refuses to connect. A redirect fails the run.

The environment of the embed stage is fixed when the stage starts, and the stage runs for
as long as extraction does. The token must stay valid until the stage ends.

Dogsled refuses the two names wherever a project or a host names a credential: in
`auth_env_vars`, `declaredEnvNames` and `declaredSecretNames`, and in every placeholder or
`*_env` field of a source, destination, connection, action, model or reviewer. Pass them in
the run's environment only. Do not put them in a `secrets` map or in a list of declared
names.

## Requests

Every request is a `POST` to the endpoint with these headers:

| Header            | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `Authorization`   | `Bearer <token>`                                                 |
| `Content-Type`    | `application/json`                                               |
| `Accept`          | `application/json`                                               |
| `Idempotency-Key` | A UUID for the batch. Every attempt at the batch sends the same. |

```json
{
  "inputs": [{ "id": "0", "text": "Escalate refunds over 500." }],
  "purpose": "document"
}
```

Treat `id` as opaque and return it unchanged. Ignore keys you do not know.

The first request has `"inputs": []`. Dogsled sends it before any text and before it writes
a table's schema, to learn the model and the limits. Later requests hold at most
`limits.maxInputs` inputs, and fewer where a body would pass 4 MiB of UTF-8. At most four
requests run at once.

## Responses

Answer with a 2xx status. The example model has two dimensions, to keep its vectors short.
The answer to the first request, which has no inputs:

```json
{
  "model": { "provider": "acme", "id": "acme-embed-1", "dimensions": 2 },
  "limits": { "maxInputs": 32, "maxInputCharacters": 32000 },
  "results": []
}
```

The answer to the request above:

```json
{
  "model": { "provider": "acme", "id": "acme-embed-1", "dimensions": 2 },
  "results": [{ "id": "0", "embedding": [0.12, -0.03] }],
  "usage": { "tokens": 7 }
}
```

| Field                       | Rule                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `model.provider`, `.id`     | 1 to 200 printable ASCII characters. Recorded unchanged with each vector column.                            |
| `model.dimensions`          | An integer from 1 to 16,384. The length of every vector.                                                    |
| `limits`                    | Optional. Read from the first response only.                                                                |
| `limits.maxInputs`          | 1 to 100. Default 32.                                                                                       |
| `limits.maxInputCharacters` | 1 to 200,000 JavaScript string units (UTF-16). Default 32,000.                                              |
| `results`                   | One entry for each input, in any order. Empty for the first request.                                        |
| `results[].id`              | The id of an input. Each appears once.                                                                      |
| `results[].embedding`       | `model.dimensions` finite numbers. An entry has either `embedding` or `error`.                              |
| `results[].error`           | A code for an input you refuse: a lowercase letter, then up to 63 lowercase letters, digits or underscores. |
| `usage.tokens`              | Optional. A non-negative integer.                                                                           |

The model must stay the same in every response. The first response may have up to 64 KiB and
any other up to 16 MiB, counted after decompression. Keys that are not listed are ignored.

## Refused inputs

An entry with `error` leaves that row's vector null, and the run goes on. A code that does
not match the rule counts as `unknown`. Once for each stream, Dogsled logs a warning with
the counts by code, never with a text or an id:

```json
{
  "_v": 1,
  "type": "LOG",
  "level": "warn",
  "message": "The embedding provider refused 3 inputs in stream \"handbook__chunks\", and their vectors are null (too_long: 2, unsupported_text: 1)",
  "time": "2026-01-01T00:00:00.000Z",
  "event": "embedding.inputs_rejected",
  "attributes": {
    "stream": "handbook__chunks",
    "counts": { "too_long": 2, "unsupported_text": 1 }
  }
}
```

`counts` holds at most 20 codes; any further ones count under `other`. A run with
`quiet` prints errors only, so it leaves this warning out.

## Failures

| What happens                                                  | What Dogsled does                                |
| ------------------------------------------------------------- | ------------------------------------------------ |
| Status 408, 429 or 5xx, a timeout, or a network error         | Tries up to four times, then fails the run.      |
| Status 401 or 403                                             | Fails the run at once. The token is not retried. |
| Any other status, a redirect, or a response that is not valid | Fails the run at once.                           |
| A different model in a later response                         | Fails the run at once.                           |

An attempt has 60 seconds, including the time to read the body. Dogsled waits between
attempts with exponential backoff and jitter, and for at least a `Retry-After` in whole
seconds, up to 30 seconds. When one request fails, the others are cancelled. There is no
fallback to another provider, and no price list: `cost_budget_usd` and
`platform.budget` do not apply.

A failed run does not save which files it read, so the next run
[embeds them again](../guides/embeddings-and-ai.md#embed-in-a-project-pipeline).

## Text

Each text is cut to `limits.maxInputCharacters` without splitting a surrogate pair. That is
the only limit: the 8,191 tokens of the other providers do not apply, and Dogsled does not
count tokens, because it does not know your model's tokenizer. Refuse an input that is too
long for your model with a code such as `too_long`. Dogsled warns once for each stream and
field about texts that it cuts.

A null or empty value gets a null vector and is not sent. So does a text that is empty
after JavaScript's `trim()`, before or after a cut, which is a rule of this provider only.

## Metrics

| Metric                       | Counts                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `embedding_api_calls`        | Batches sent to the endpoint. A retried batch counts once; the first request does not. |
| `embedding_inputs_rejected`  | Inputs the host refused.                                                               |
| `embedding_tokens_processed` | The sum of `usage.tokens`.                                                             |
| `embedding_tokens_truncated` | Texts cut to `limits.maxInputCharacters`.                                              |

## Security

- In a pipeline run, only the embed stage of a `provider: host` block gets the endpoint and
  token. They are removed from the environment of the extract, load and state processes, and
  of the embed stage of any other provider.
- The commands that `dogsled` delegates to another process, such as `extract`, `load`,
  `model`, `entity-graph` and `query`, do not get them. `dogsled embed` takes them out of its
  own environment once it has read its configuration, so no process it starts inherits them.
- This keeps the values from project files and from processes that have no use for them. It
  is not a boundary against code that runs as the same user, which can read the environment
  of another process. Any other program that is started with the variables set inherits them.
- The endpoint and token are never written to a file, a process argument, a message on
  standard output, or saved state. Output of a pipeline run and its result have both
  values redacted.
- Errors have fixed wording plus an HTTP status, a network error code, or the stream and
  line of input that is not valid JSON. They never hold the URL, the token, a request or
  response body, a text or an id.

## Test without a host

`DOGSLED_EMBED_STUB=1` sends nothing and needs neither variable. It needs `dimension`,
writes zero vectors, and records the provider `host` and the model `stub`.
