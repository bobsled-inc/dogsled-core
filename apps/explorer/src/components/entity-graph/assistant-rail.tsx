'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSelectedPairPrompts,
  getEntityGraphCtxTips,
  type EntityGraphCtx,
  type EntityGraphSelectedPairContext,
} from '@/lib/entity-graph-assistant-ctx';
import type { AgentReviewTaskResult } from '@/lib/entity-graph-agent-review';
import { requestAgentReviewSample } from '@/lib/entity-graph-agent-review-client';
import { AGENT_SAMPLE_LIMIT } from '@/lib/entity-graph-agent-sample';
import type { EntityGraphEntityId, EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { dispatchEntityGraphResolveRefresh } from '@/lib/entity-graph-ui-events';
import { isEntityGraphRouteErrorResponse, parseJsonText } from '@/lib/entity-graph-route-errors';
import { isPlainObject } from '@/lib/guards';
import { isClaudeFailureCode, type ClaudeFailureCode } from '@/lib/claude-failure';
import { useEntityGraphAssistantContext } from './entity-graph-assistant-context';

/**
 * Pull the auto_merge threshold out of the resolution spec YAML so the
 * "What if I lower the threshold?" click-to-fill prompt can suggest a
 * concrete number. We do a regex sniff rather than a full YAML parse because
 * the rail already passes the full spec to the assistant — we only need a
 * hint for the prompt label.
 */
function extractAutoMergeThreshold(yaml: string | null | undefined): number | null {
  if (!yaml) return null;
  const match = yaml.match(/^\s*auto_merge\s*:\s*([0-9]*\.?[0-9]+)\s*(?:#.*)?$/m);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

type Message = { id: string; role: 'user' | 'assistant'; content: string };
type AssistantErrorState = { message: string; code?: ClaudeFailureCode; hint?: string };
const COLLAPSE_KEY = 'entity_graph-rail-collapsed';

class AssistantRequestError extends Error {
  readonly code?: ClaudeFailureCode;
  readonly hint?: string;

  constructor(message: string, options?: { code?: ClaudeFailureCode; hint?: string }) {
    super(message);
    this.code = options?.code;
    this.hint = options?.hint;
  }
}

function summarizeAgentReview(result: AgentReviewTaskResult): { title: string; body: string } {
  const summary = result.summary;
  const candidateCount = summary.candidate_count;
  const decisionCount = summary.decision_count;
  const mergeCount = summary.merge_count;
  const notMatchCount = summary.not_match_count;
  const deferredCount = summary.deferred_count;

  if (result.operation === 'claude_code_demo_sample' || result.status === 'proposals_saved') {
    if ((candidateCount ?? 0) === 0) {
      return {
        title: 'No review candidates found',
        body: 'The queue is already clear, so there was nothing for the agent sample to propose.',
      };
    }
    const total = decisionCount ?? candidateCount ?? 0;
    const proposedParts: string[] = [];
    if ((mergeCount ?? 0) > 0) {
      proposedParts.push(`${mergeCount} merge${mergeCount === 1 ? '' : 's'}`);
    }
    if ((notMatchCount ?? 0) > 0) {
      proposedParts.push(`${notMatchCount} not_match${notMatchCount === 1 ? '' : 'es'}`);
    }
    const proposed = proposedParts.length > 0 ? ` Proposed ${proposedParts.join(' and ')}` : '';
    const deferred = (deferredCount ?? 0) > 0 ? `; deferred ${deferredCount}` : '';
    return {
      title: 'Agent proposals queued for review',
      body: `Claude reviewed ${total} pair${total === 1 ? '' : 's'}.${proposed}${deferred} — review queued in the Open tab.`,
    };
  }

  if (result.status === 'blocked') {
    return {
      title: 'Agent review was blocked',
      body: 'The run hit a policy or safety gate before writing any decisions.',
    };
  }

  if ((candidateCount ?? 0) === 0 && (decisionCount ?? 0) === 0) {
    return {
      title: 'No review candidates found',
      body: 'The queue is already clear, so there was nothing for the agent sample to propose.',
    };
  }

  if (decisionCount != null) {
    return {
      title: 'Agent review proposals prepared',
      body: `Prepared ${decisionCount} proposal(s) from ${candidateCount ?? decisionCount} candidate(s). Confirm or override each from the pair inspector.`,
    };
  }

  return {
    title: 'Agent review completed',
    body: 'The sidebar run completed and returned an unexpected summary payload.',
  };
}

function replaceLastMessage(messages: Message[], content: string): Message[] {
  const copy = messages.slice();
  const lastIdx = copy.length - 1;
  if (lastIdx >= 0) {
    copy[lastIdx] = { ...copy[lastIdx]!, role: 'assistant', content };
  } else {
    copy.push({ id: 'assistant-fallback', role: 'assistant', content });
  }
  return copy;
}

function dropPendingAssistantMessage(messages: Message[]): Message[] {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant' && lastMessage.content === '') {
    return messages.slice(0, -1);
  }
  return messages;
}

function getAssistantErrorTitle(code?: ClaudeFailureCode): string {
  switch (code) {
    case 'unavailable':
      return 'Assistant unavailable';
    case 'timeout':
      return 'Assistant timed out';
    case 'auth':
      return 'Assistant needs login';
    case 'runtime':
      return 'Assistant stopped unexpectedly';
    default:
      return 'Assistant hit an error';
  }
}

function formatPairPromptLabel(pairId: string): string {
  return pairId.length > 10 ? `${pairId.slice(0, 10)}…` : pairId;
}

interface AssistantRailProps {
  ctx: EntityGraphCtx;
  scenario: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
  specName?: string | null;
  specYaml?: string | null;
  selectedPairId?: string | null;
  selectedPair?: EntityGraphSelectedPairContext | null;
}

export function AssistantRail({
  ctx,
  scenario,
  entity,
  specName,
  specYaml,
  selectedPairId,
  selectedPair,
}: AssistantRailProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantError, setAssistantError] = useState<AssistantErrorState | null>(null);
  // Sourced from EntityGraphAssistantContext so the rail's "Run … agent sample" button
  // shares state with the resolve page header button — both trigger the same
  // endpoint, so they must show one consistent loading/disabled state.
  const { agentReviewRunning, setAgentReviewRunning } = useEntityGraphAssistantContext();
  const [agentReviewError, setAgentReviewError] = useState<string | null>(null);
  const [lastAgentReview, setLastAgentReview] = useState<AgentReviewTaskResult | null>(null);
  // Set of click-to-fill prompts the user has dismissed via the per-button
  // close affordance. Persists across pair selections within a session so a
  // dismissed prompt does not reappear when the user clicks a new pair, but
  // does reset when ctx/entity/scenario flips (the existing reset effect
  // below).
  const [dismissedPairPrompts, setDismissedPairPrompts] = useState<Set<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  const agentReviewAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef(true);
  const sendingRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  const nextMessageIdRef = useRef(0);

  const createMessage = useCallback((role: Message['role'], content: string): Message => {
    const id = `msg-${nextMessageIdRef.current}`;
    nextMessageIdRef.current += 1;
    return { id, role, content };
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    // `auto` avoids stacking a smooth-scroll animation per SSE delta; the
    // rail already updates dozens of times a second while streaming.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, [messages]);

  useEffect(() => {
    isMountedRef.current = true;
    const saved = window.localStorage.getItem(COLLAPSE_KEY);
    setCollapsed(saved === '1');
    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      agentReviewAbortRef.current?.abort();
      agentReviewAbortRef.current = null;
    };
  }, []);

  // Abort any in-flight stream and reset transcript when the surface context changes,
  // so stale messages/input from a previous surface don't leak into the next request.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    agentReviewAbortRef.current?.abort();
    agentReviewAbortRef.current = null;
    setMessages([]);
    setInput('');
    setAssistantError(null);
    setAgentReviewRunning(false);
    setAgentReviewError(null);
    setLastAgentReview(null);
    setDismissedPairPrompts(new Set());
  }, [ctx, entity, scenario, setAgentReviewRunning]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Guard against re-entry from the same render (e.g. Enter + Send click)
      // using a ref rather than the `streaming` state, which is stale inside
      // this closure until React commits the setState below.
      if (sendingRef.current) return;
      sendingRef.current = true;

      const next: Message[] = [...messagesRef.current, createMessage('user', trimmed)];
      setMessages([...next, createMessage('assistant', '')]);
      setInput('');
      setStreaming(true);
      setAssistantError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let assistantText = '';
      try {
        const res = await explorerFetch('/api/entity-graph/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: next,
            ctx,
            scenario,
            entity,
            specName,
            specYaml: specYaml?.trim() ? specYaml : undefined,
            selectedPair: ctx === 'resolve.queue' && selectedPair ? selectedPair : undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const rawText = await res.text();
          const parsed = parseJsonText(rawText);
          const errorBody = isEntityGraphRouteErrorResponse(parsed) ? parsed : null;
          const hint =
            isPlainObject(parsed) && typeof parsed.hint === 'string' ? parsed.hint : undefined;
          const rawCode = errorBody?.code;
          const code = isClaudeFailureCode(rawCode) ? rawCode : undefined;
          throw new AssistantRequestError(
            errorBody?.error ??
              (isPlainObject(parsed) && typeof parsed.detail === 'string'
                ? parsed.detail
                : undefined) ??
              `Request failed with status ${res.status}`,
            {
              code,
              hint: hint ?? errorBody?.detail,
            }
          );
        }
        if (!res.body) {
          throw new AssistantRequestError('No response body');
        }
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!isMountedRef.current) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';
            for (const evt of events) {
              if (!evt.startsWith('data:')) continue;
              const payload = evt.slice(5).trim();
              if (!payload) continue;
              try {
                const parsed = JSON.parse(payload) as {
                  type?: string;
                  text?: string;
                  message?: string;
                  code?: string;
                  hint?: string;
                };
                if (parsed.type === 'delta' && parsed.text) {
                  assistantText += parsed.text;
                  if (isMountedRef.current) {
                    setMessages((prev) => replaceLastMessage(prev, assistantText));
                  }
                } else if (parsed.type === 'error' && parsed.message) {
                  if (isMountedRef.current) {
                    if (!assistantText) {
                      setMessages((prev) => dropPendingAssistantMessage(prev));
                    }
                    const sseCode = isClaudeFailureCode(parsed.code) ? parsed.code : undefined;
                    setAssistantError({
                      message: parsed.message,
                      code: sseCode,
                      hint: parsed.hint,
                    });
                  }
                }
              } catch {
                // skip malformed event
              }
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // reader may already be released if the stream errored
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError') && isMountedRef.current) {
          if (!assistantText) {
            setMessages((prev) => dropPendingAssistantMessage(prev));
          }
          setAssistantError({
            message: err instanceof Error ? err.message : String(err),
            code: err instanceof AssistantRequestError ? err.code : undefined,
            hint: err instanceof AssistantRequestError ? err.hint : undefined,
          });
        }
      } finally {
        if (isMountedRef.current) setStreaming(false);
        if (abortRef.current === controller) abortRef.current = null;
        sendingRef.current = false;
      }
    },
    [createMessage, ctx, entity, scenario, selectedPair, specName, specYaml]
  );

  const runAgentReview = useCallback(async () => {
    if (streaming || agentReviewRunning || ctx !== 'resolve.queue') return;

    const controller = new AbortController();
    agentReviewAbortRef.current?.abort();
    agentReviewAbortRef.current = controller;
    setAgentReviewRunning(true);
    setAgentReviewError(null);
    setLastAgentReview(null);

    try {
      const response = await requestAgentReviewSample({
        scenario,
        entity,
        limit: AGENT_SAMPLE_LIMIT,
        signal: controller.signal,
        invalidMessage: 'Agent review returned an invalid response.',
      });

      if (!isMountedRef.current) return;

      setLastAgentReview(response.result);
      if (response.result.executed !== false) {
        dispatchEntityGraphResolveRefresh();
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError') && isMountedRef.current) {
        setAgentReviewError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (agentReviewAbortRef.current === controller) {
        agentReviewAbortRef.current = null;
      }
      if (isMountedRef.current) {
        setAgentReviewRunning(false);
      }
    }
  }, [agentReviewRunning, ctx, entity, scenario, setAgentReviewRunning, streaming]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const tips = getEntityGraphCtxTips(ctx, scenario, entity);
  const selectedPairLabel = selectedPairId ? formatPairPromptLabel(selectedPairId) : null;
  const suggestedPrompts =
    ctx === 'resolve.queue' && selectedPairLabel
      ? [
          `Assess selected pair ${selectedPairLabel}.`,
          `What evidence matters most for selected pair ${selectedPairLabel}?`,
          ...tips.suggestedPrompts,
        ]
      : tips.suggestedPrompts;
  const autoMergeThreshold = useMemo(() => extractAutoMergeThreshold(specYaml), [specYaml]);
  // Click-to-fill prompts shown above the chat input when the user has a
  // pair selected on the resolve queue. The list is dismissible per-button so
  // a power user who already knows the prompts can trim the rail.
  const pairPrompts = useMemo(() => {
    if (ctx !== 'resolve.queue' || !selectedPair) return [];
    return buildSelectedPairPrompts({
      selectedPair,
      thresholdHint: autoMergeThreshold,
    }).filter((p) => !dismissedPairPrompts.has(p));
  }, [autoMergeThreshold, ctx, dismissedPairPrompts, selectedPair]);
  const agentReviewSummary = lastAgentReview ? summarizeAgentReview(lastAgentReview) : null;
  const lastUserPrompt = [...messages]
    .reverse()
    .find((message) => message.role === 'user')?.content;
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };

  return (
    <aside
      className={`flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-card transition-[width] duration-200 ${
        collapsed ? 'w-12' : 'w-[300px]'
      }`}
    >
      <div
        className={`flex border-b border-border px-2 py-2 ${collapsed ? 'justify-center' : 'justify-end'}`}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={collapsed ? 'Expand assistant' : 'Collapse assistant'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex h-full flex-col gap-4 p-4">
          <div className="shrink-0 space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-primary" />
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Assistant · {tips.title}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-foreground/80">{tips.lead}</p>
            <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
              {tips.bullets.map((b) => (
                <li key={b} className="flex gap-1.5">
                  <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-border" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>

          {ctx === 'resolve.queue' && (
            <div className="shrink-0 rounded-md border border-border bg-background/40 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Queue action
              </div>
              <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                Run a {AGENT_SAMPLE_LIMIT}-pair Claude sample. Proposals are saved as review
                evidence; human decisions stay in the pair inspector.
              </p>
              <button
                type="button"
                onClick={() => void runAgentReview()}
                disabled={agentReviewRunning || streaming}
                className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {agentReviewRunning
                  ? 'Sampling queue…'
                  : `Run ${AGENT_SAMPLE_LIMIT}-pair agent sample`}
              </button>

              {agentReviewSummary && (
                <div className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs">
                  <div className="font-medium text-foreground">{agentReviewSummary.title}</div>
                  <p className="mt-1 leading-relaxed text-muted-foreground">
                    {agentReviewSummary.body}
                  </p>
                  {(lastAgentReview?.warnings?.length ?? 0) > 0 && (
                    <p className="mt-2 leading-relaxed text-amber-700 dark:text-amber-300">
                      {lastAgentReview?.warnings?.join(' ')}
                    </p>
                  )}
                </div>
              )}

              {agentReviewError && (
                <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                  {agentReviewError}
                </div>
              )}
            </div>
          )}

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto rounded-md border border-border bg-background/30 p-3"
          >
            {messages.length === 0 ? (
              <div className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Suggested prompts
                </div>
                <div className="flex flex-col gap-1.5">
                  {suggestedPrompts.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => void send(p)}
                      className="rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs hover:bg-secondary"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={m.id}
                  className={`rounded-md px-2.5 py-2 text-xs leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-primary/10 text-foreground'
                      : 'bg-secondary/60 whitespace-pre-wrap text-foreground/90'
                  }`}
                >
                  {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
                </div>
              ))
            )}
          </div>

          {assistantError && (
            <div className="shrink-0 space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
              <div>
                <div className="font-medium">{getAssistantErrorTitle(assistantError.code)}</div>
                <p className="mt-1 leading-relaxed">{assistantError.message}</p>
                <p className="mt-1 leading-relaxed text-amber-800/90 dark:text-amber-100/80">
                  {assistantError.hint ??
                    'Retry once, then use the suggested prompts below to keep exploring this surface.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {lastUserPrompt && (
                  <button
                    type="button"
                    onClick={() => void send(lastUserPrompt)}
                    disabled={streaming}
                    className="rounded-md border border-amber-500/30 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-background"
                  >
                    Retry last prompt
                  </button>
                )}
                {suggestedPrompts.slice(0, 3).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void send(prompt)}
                    disabled={streaming}
                    className="rounded-md border border-amber-500/30 bg-background/70 px-2.5 py-1 text-left text-[11px] text-foreground hover:bg-background"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pairPrompts.length > 0 && (
            <div className="shrink-0 space-y-1.5 rounded-md border border-border bg-background/40 p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Try asking
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {pairPrompts.map((prompt) => (
                  <div key={prompt} className="flex items-stretch gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        void send(prompt);
                      }}
                      disabled={streaming}
                      className="flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                    >
                      {prompt}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDismissedPairPrompts((prev) => {
                          const next = new Set(prev);
                          next.add(prompt);
                          return next;
                        })
                      }
                      aria-label={`Dismiss prompt: ${prompt}`}
                      className="inline-flex w-6 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form
            className="shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about the current surface…"
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-background p-2 text-xs outline-none focus:border-primary"
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>⏎ to send · ⇧⏎ for newline</span>
              <button
                type="submit"
                disabled={streaming || !input.trim()}
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {streaming ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      )}

      {collapsed && (
        <div className="flex flex-1 items-start justify-center py-4">
          <div className="[writing-mode:vertical-rl] text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Entity Graph assistant
          </div>
        </div>
      )}
    </aside>
  );
}
