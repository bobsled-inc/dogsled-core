import { streamClaudeResponse } from '@/lib/claude-cli';
import { listIntegrations } from '@/lib/integrations';
import { listModelPackages } from '@/lib/models';
import { isPlainObject } from '@/lib/guards';
import { logServerError } from '@/lib/server-logging';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type AgentSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; code?: number }
  | { type: 'error'; message: string };

function buildSystemPrompt(): string {
  const integrations = listIntegrations();
  const models = listModelPackages();

  const categories = [...new Set(integrations.map((i) => i.category))].sort();
  const categoryList = categories
    .map((cat) => {
      const items = integrations.filter((i) => i.category === cat);
      return `  ${cat}: ${items.map((i) => i.name).join(', ')}`;
    })
    .join('\n');

  const modelList = models
    .map((m) => `  ${m.name}: ${m.displayName} — ${m.description} (${m.martCount} marts)`)
    .join('\n');

  return `You are the Bobsled Core Explorer assistant, a helpful guide for the Bobsled Core data engineering toolkit. You help users understand Bobsled Core's capabilities, explore integrations, configure pipelines, and learn about data modeling.

## What is Bobsled Core?
Bobsled Core is a YAML-driven data engineering toolkit with:
- **Extract**: Pull data from 81+ API integrations using YAML specs with automatic pagination, incremental sync, rate limiting, and SSRF protection
- **Load**: Push data to 9 destinations (DuckDB, BigQuery, Snowflake, PostgreSQL, ClickHouse, Turbopuffer, local files, S3, GCS) with schema evolution, merge strategies, and batched writes
- **Model**: SQL-based data transformation with multi-dialect compilation (DuckDB, BigQuery, Snowflake, PostgreSQL) using source → staging → mart DAG patterns
- **Pipeline**: Composed extract + load in a single command with schedule configuration via bobsled.yml
- **Entity Graph**: Entity resolution with standardization, blocking, scoring, threshold-based matching, human review routing, and survivorship rules

## Available Integrations (${integrations.length} total)
By category:
${categoryList}

## Pre-built Model Bundles (${models.length} total)
${modelList}

## Load Destinations
- DuckDB: Local zero-infra analytics database (great for demos and local dev)
- BigQuery: Google Cloud managed analytics warehouse
- Snowflake: Enterprise cloud data warehouse
- PostgreSQL: Relational database for operational analytics
- ClickHouse: Column-oriented OLAP database for high-volume analytics
- Turbopuffer: Serverless vector and full-text search store
- Local Files: JSONL, CSV, or Parquet files
- S3: AWS object storage
- GCS: Google Cloud Storage

## Key CLI Commands
- bobsled integrations list — List all available integrations
- bobsled integrations show <name> — Show integration details and resources
- bobsled extract run <integration> — Extract data from an integration
- bobsled load run — Load data into a destination
- bobsled pipeline --integration <name> — Extract + load in one command
- bobsled model compile — Compile SQL models for a target dialect
- bobsled model run — Run compiled models against a warehouse
- bobsled setup describe — Show setup catalog (presets, destinations, integrations)
- bobsled setup recommend --goal "<goal>" — Get pipeline recommendations

## Load Strategies
- append: Insert new rows (default)
- merge: Upsert based on primary key
- full_refresh: Drop and recreate table

## Bobsled Core Protocol
Bobsled Core uses Bobsled Core protocol messages for CLI streaming output: SCHEMA (table definitions), RECORD (data rows), STATE (sync bookmarks), BATCH, LOG, METRIC, PROGRESS.

## Your Behavior
- Be concise and helpful. Answer questions about Bobsled Core directly.
- When users ask about a specific integration, list its resources and explain what data it provides.
- When users ask how to build a pipeline, walk them through the steps: choose integration → select resources → pick destination → configure schedule → export bobsled.yml.
- When users ask about models, explain the source → staging → mart pattern.
- Suggest relevant Bobsled Core commands when appropriate.
- You can reference the Explorer UI pages: /integrations, /models, /pipelines, /pipelines/new, /pipelines/new/export, /data, /terminal, /entity-graph, /setup, /settings.
- Keep responses focused and practical. This is a demo/exploration tool.`;
}

const MAX_HISTORY_CHARS = 600;

function buildPrompt(messages: ChatMessage[]): string {
  const history = messages.slice(0, -1); // all but the last (current) message
  const current = messages[messages.length - 1];

  if (!current) return '';

  if (history.length === 0) {
    return current.content;
  }

  // Keep last 4 messages (2 turns) and truncate long entries to avoid oversized -p arguments
  const recentHistory = history.slice(-4);
  const transcript = recentHistory
    .map((m) => {
      const label = m.role === 'user' ? 'User' : 'Assistant';
      const content =
        m.content.length > MAX_HISTORY_CHARS
          ? m.content.slice(0, MAX_HISTORY_CHARS) + '…'
          : m.content;
      return `${label}: ${content}`;
    })
    .join('\n\n');

  return `Previous conversation:\n${transcript}\n\nUser: ${current.content}`;
}

const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 50_000;

let cachedSystemPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = buildSystemPrompt();
  }
  return cachedSystemPrompt;
}

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  if (!isPlainObject(raw)) {
    return new Response(JSON.stringify({ error: 'JSON object required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = raw as { messages?: ChatMessage[] };
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter(
          (m): m is ChatMessage =>
            isPlainObject(m) &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string'
        )
        .slice(-MAX_MESSAGES)
    : [];

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (messages[messages.length - 1]?.role !== 'user') {
    return new Response(JSON.stringify({ error: 'last message must be from the user' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const totalLength = messages.reduce((s, m) => s + m.content.length, 0);
  if (totalLength > MAX_CONTENT_LENGTH) {
    return new Response(JSON.stringify({ error: 'Message content too long' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const systemPrompt = getSystemPrompt();
  const prompt = buildPrompt(messages);
  const clientErrorMessage = 'Assistant request failed';

  try {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (eventData: AgentSseEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventData)}\n\n`));
          } catch {
            closed = true;
          }
        };

        void streamClaudeResponse({
          systemPrompt,
          userPrompt: prompt,
          signal: abort.signal,
          onEvent: (event) => {
            if (event.type === 'delta') {
              send({ type: 'delta', text: event.text });
            } else if (event.type === 'error') {
              logServerError('apps/explorer/api/agent:sse', event.message);
              send({ type: 'error', message: clientErrorMessage });
            } else if (event.type === 'done') {
              send(
                event.code === undefined ? { type: 'done' } : { type: 'done', code: event.code }
              );
            }
          },
        })
          .catch((error) => {
            logServerError('apps/explorer/api/agent:stream', error);
            send({ type: 'error', message: clientErrorMessage });
          })
          .finally(() => {
            if (closed) return;
            closed = true;
            controller.close();
          });
      },
      cancel() {
        // Prevent pending Claude callbacks from touching a cancelled stream.
        closed = true;
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    logServerError('apps/explorer/api/agent:request', error);
    return new Response(JSON.stringify({ detail: clientErrorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
