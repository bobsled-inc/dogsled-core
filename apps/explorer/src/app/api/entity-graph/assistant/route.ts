import { NextResponse } from 'next/server';
import { streamClaudeResponse } from '@/lib/claude-cli';
import { buildEntityGraphSystemPrompt } from '@/lib/entity-graph-assistant-prompt';
import { assertValidSpecName } from '@/lib/entity-graph-workspace';
import {
  isValidEntityGraphCtx,
  type EntityGraphCtx,
  type EntityGraphSelectedPairContext,
  type EntityGraphSelectedPairFeatureContribution,
  type EntityGraphSelectedPairField,
} from '@/lib/entity-graph-assistant-ctx';
import {
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { isPlainObject } from '@/lib/guards';
import { logServerError } from '@/lib/server-logging';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type AssistantSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; code?: number }
  | { type: 'error'; message: string; code?: string; hint?: string };

const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_HISTORY_CHARS = 600;

/**
 * Neutralize user-controlled message content before embedding it in the
 * prompt. Triple-backticks are stripped so callers cannot inject new fenced
 * blocks that impersonate the `## Current resolution spec` section.
 */
function sanitizeMessageContent(content: string, max: number): string {
  const stripped = content.replace(/```/g, '[BACKTICKS]');
  return stripped.length > max ? stripped.slice(0, max) + '…' : stripped;
}

/**
 * A value passed at this position must be `string | null | undefined` (for
 * optional fields that may be missing). Anything else — number, object, array,
 * boolean — is a contract violation, so the whole `selectedPair` is rejected.
 */
function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

/**
 * Parse the `selectedPair` payload from the request body. The structure
 * mirrors `EntityGraphSelectedPairContext` but is user-controlled so we type-guard
 * each field rather than trusting the JSON shape.
 *
 * Validation contract:
 *   - Required top-level fields (`pairId`, `compositeScore`, `thresholdBand`)
 *     must be present with the correct type. If any is missing or wrong-type
 *     we return `null` so the caller can omit `selectedPair` from the prompt
 *     context entirely (rather than build a misleading partial pair).
 *   - Optional top-level scalar fields must be `string | null | undefined`
 *     when present. A wrong-type optional field also rejects the whole pair.
 *   - `fields` and `featureContributions` may be missing (treated as `[]`)
 *     or arrays whose items are filtered per item — bad items are dropped,
 *     good items are kept. This keeps the rail resilient when one bad row
 *     would otherwise drop the entire pair context.
 */
function parseSelectedPair(raw: unknown): EntityGraphSelectedPairContext | null {
  if (!isPlainObject(raw)) return null;
  const pairId = raw.pairId;
  if (typeof pairId !== 'string' || pairId.length === 0) return null;
  const compositeScore = raw.compositeScore;
  if (typeof compositeScore !== 'number' || !Number.isFinite(compositeScore)) return null;
  const thresholdBand = raw.thresholdBand;
  if (typeof thresholdBand !== 'string') return null;

  if (
    !isOptionalString(raw.sourceA) ||
    !isOptionalString(raw.sourceB) ||
    !isOptionalString(raw.recordALabel) ||
    !isOptionalString(raw.recordBLabel) ||
    !isOptionalString(raw.blockingRules)
  ) {
    return null;
  }

  if (raw.fields !== undefined && !Array.isArray(raw.fields)) return null;
  if (raw.featureContributions !== undefined && !Array.isArray(raw.featureContributions)) {
    return null;
  }

  // Per-field caps. The system prompt is small, but a malicious or buggy
  // client could send 1MB strings here that would inflate the LLM call,
  // increasing latency/cost and risking stream failures.
  const MAX_FIELD_TEXT = 1_000;
  const MAX_FIELD_KEY_OR_LABEL = 128;
  const clampText = (value: string, max = MAX_FIELD_TEXT): string =>
    value.length > max ? `${value.slice(0, max)}…` : value;
  const optionalString = (value: string | null | undefined): string | null =>
    typeof value === 'string' ? clampText(value) : null;

  // Cap raw arrays before filter/map so a 10k-element payload doesn't walk
  // and allocate every entry only to throw the tail away. The 32-item limit
  // is intentionally tight — the prompt only references a handful of
  // identity-bearing fields per pair.
  const MAX_PAIR_ARRAY = 32;
  const rawFields = Array.isArray(raw.fields) ? raw.fields.slice(0, MAX_PAIR_ARRAY) : [];
  const fields: EntityGraphSelectedPairField[] = rawFields
    .filter(
      (f): f is EntityGraphSelectedPairField =>
        isPlainObject(f) &&
        typeof f.key === 'string' &&
        typeof f.label === 'string' &&
        (typeof f.a === 'string' || f.a === null) &&
        (typeof f.b === 'string' || f.b === null)
    )
    .map((f) => ({
      key: clampText(f.key, MAX_FIELD_KEY_OR_LABEL),
      label: clampText(f.label, MAX_FIELD_KEY_OR_LABEL),
      a: f.a === null ? null : clampText(f.a),
      b: f.b === null ? null : clampText(f.b),
    }));
  const rawFeatureContributions = Array.isArray(raw.featureContributions)
    ? raw.featureContributions.slice(0, MAX_PAIR_ARRAY)
    : [];
  const featureContributions: EntityGraphSelectedPairFeatureContribution[] = rawFeatureContributions
    .filter(
      (f): f is EntityGraphSelectedPairFeatureContribution =>
        isPlainObject(f) &&
        typeof f.key === 'string' &&
        typeof f.label === 'string' &&
        (typeof f.score === 'number' || f.score === null) &&
        (typeof f.a === 'string' || f.a === null) &&
        (typeof f.b === 'string' || f.b === null)
    )
    .map((f) => ({
      key: clampText(f.key, MAX_FIELD_KEY_OR_LABEL),
      label: clampText(f.label, MAX_FIELD_KEY_OR_LABEL),
      score: f.score,
      a: f.a === null ? null : clampText(f.a),
      b: f.b === null ? null : clampText(f.b),
    }));

  return {
    pairId,
    compositeScore,
    thresholdBand,
    sourceA: optionalString(raw.sourceA),
    sourceB: optionalString(raw.sourceB),
    recordALabel: optionalString(raw.recordALabel),
    recordBLabel: optionalString(raw.recordBLabel),
    blockingRules: optionalString(raw.blockingRules),
    fields,
    featureContributions,
  };
}

function buildPrompt(messages: ChatMessage[]): string {
  const history = messages.slice(0, -1);
  const current = messages[messages.length - 1];
  if (!current) return '';
  const currentContent = sanitizeMessageContent(current.content, MAX_CONTENT_LENGTH);
  if (history.length === 0) return currentContent;

  const recent = history.slice(-4);
  const transcript = recent
    .map((m) => {
      const label = m.role === 'user' ? 'User' : 'Assistant';
      const content = sanitizeMessageContent(m.content, MAX_HISTORY_CHARS);
      return `${label}: ${content}`;
    })
    .join('\n\n');
  return `Previous conversation:\n${transcript}\n\nUser: ${currentContent}`;
}

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  if (!isPlainObject(raw)) {
    return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
  }

  const body = raw as {
    messages?: ChatMessage[];
    ctx?: EntityGraphCtx;
    scenario?: string;
    entity?: string;
    specName?: string;
    specYaml?: string;
    selectedPair?: unknown;
  };

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
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }

  const totalLength = messages.reduce((s, m) => s + m.content.length, 0);
  if (totalLength > MAX_CONTENT_LENGTH) {
    return NextResponse.json({ error: 'Message content too long' }, { status: 400 });
  }

  const ctx: EntityGraphCtx = isValidEntityGraphCtx(body.ctx) ? body.ctx : 'hub';
  let scenarioId: EntityGraphScenarioId = 'default';
  let entityId: EntityGraphEntityId;
  try {
    const resolved = resolveEntityGraphScenarioEntity(body.scenario, body.entity);
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
  let specName: string | undefined;
  if (typeof body.specName === 'string') {
    try {
      specName = assertValidSpecName(body.specName);
    } catch {
      specName = undefined;
    }
  }

  const specYaml = typeof body.specYaml === 'string' ? body.specYaml : undefined;
  // For non-queue surfaces, ignore selectedPair entirely. For the queue
  // surface, parse the payload — `parseSelectedPair` returns null on contract
  // violation (missing or wrong-type top-level field). When the client
  // actually sent a payload (i.e. the property is present and non-null) but
  // it failed validation, reject the request with 400 so the rail can
  // surface a real error rather than silently answering with a fabricated
  // shape. A missing/null `selectedPair` continues to mean "no pair selected"
  // and is allowed. Per-array-item filtering inside parseSelectedPair still
  // drops bad rows but keeps good ones.
  let selectedPair: EntityGraphSelectedPairContext | undefined;
  if (ctx === 'resolve.queue' && body.selectedPair !== undefined && body.selectedPair !== null) {
    const parsed = parseSelectedPair(body.selectedPair);
    if (parsed === null) {
      return NextResponse.json({ error: 'selectedPair is invalid' }, { status: 400 });
    }
    selectedPair = parsed;
  }
  const systemPrompt = await buildEntityGraphSystemPrompt(
    ctx,
    scenarioId,
    entityId,
    specName,
    specYaml,
    selectedPair
  );
  const prompt = buildPrompt(messages);
  const fallbackAssistantError = {
    message: 'Assistant request failed',
    code: 'runtime',
    hint: 'Retry once. If it keeps failing, inspect the local Claude CLI output.',
  } as const;

  try {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (eventData: AssistantSseEvent) => {
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
              logServerError('apps/explorer/api/entity-graph-assistant:sse', event.message, {
                code: event.code,
                scenario: scenarioId,
                entity: entityId,
                ctx,
              });
              send({ type: 'error', message: event.message, code: event.code, hint: event.hint });
            } else if (event.type === 'done') {
              send(
                event.code === undefined ? { type: 'done' } : { type: 'done', code: event.code }
              );
            }
          },
        })
          .catch((error) => {
            logServerError('apps/explorer/api/entity-graph-assistant:stream', error);
            send({ type: 'error', ...fallbackAssistantError });
          })
          .finally(() => {
            if (closed) return;
            closed = true;
            controller.close();
          });
      },
      cancel() {
        // Prevent pending callbacks from enqueuing after the browser closes the stream.
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
    logServerError('apps/explorer/api/entity-graph-assistant:request', error);
    return NextResponse.json(
      {
        error: fallbackAssistantError.message,
        code: fallbackAssistantError.code,
        detail: fallbackAssistantError.hint,
      },
      { status: 500 }
    );
  }
}
