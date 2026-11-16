'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { loadStoredJson, removeStoredValue, saveStoredJson } from '@/lib/storage';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

const AGENT_HISTORY_STORAGE_KEY = 'bobsled-explorer-agent-history';
const AGENT_SESSIONS_KEY = 'bobsled-explorer-agent-sessions';
const MAX_SESSIONS = 10;

interface AgentSession {
  id: string;
  startedAt: string;
  title: string;
  messages: ChatMessage[];
}

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as ChatMessage).id === 'number' &&
        ((entry as ChatMessage).role === 'user' || (entry as ChatMessage).role === 'assistant') &&
        typeof (entry as ChatMessage).content === 'string'
    )
  );
}

function isAgentSessionArray(value: unknown): value is AgentSession[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as AgentSession).id === 'string' &&
        typeof (s as AgentSession).startedAt === 'string' &&
        typeof (s as AgentSession).title === 'string' &&
        isChatMessageArray((s as AgentSession).messages)
    )
  );
}

function archiveSession(messages: ChatMessage[]) {
  const completed = messages.filter((m) => !m.streaming);
  const firstUser = completed.find((m) => m.role === 'user');
  if (!firstUser) return;
  const session: AgentSession = {
    id: `session_${Date.now()}`,
    startedAt: new Date().toISOString(),
    title: firstUser.content.slice(0, 80),
    messages: completed,
  };
  const existing = loadStoredJson<AgentSession[]>(AGENT_SESSIONS_KEY, [], isAgentSessionArray);
  saveStoredJson(AGENT_SESSIONS_KEY, [session, ...existing].slice(0, MAX_SESSIONS));
}

function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const SUGGESTED_QUESTIONS = [
  'What integrations are available for CRM data?',
  'How do I build a Stripe analytics pipeline?',
  'Explain the source → staging → mart pattern',
  'What destinations can I load data into?',
  'How does incremental sync work?',
  'What is entity resolution and when should I use it?',
  'Walk me through setting up a SaaS analytics stack',
  'What Bobsled Core CLI commands should I know?',
];

export default function AgentPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const lastPromptRef = useRef<string | null>(null);
  const lastPersistedRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    setSessions(loadStoredJson<AgentSession[]>(AGENT_SESSIONS_KEY, [], isAgentSessionArray));
    const restoredMessages = loadStoredJson<ChatMessage[]>(
      AGENT_HISTORY_STORAGE_KEY,
      [],
      isChatMessageArray
    )
      .filter((message) => !message.streaming)
      .slice(-20);

    if (restoredMessages.length > 0) {
      setMessages(restoredMessages);
      setRestoredCount(restoredMessages.length);
      idRef.current = restoredMessages.reduce((max, message) => Math.max(max, message.id), 0);
      const lastUser = [...restoredMessages].reverse().find((message) => message.role === 'user');
      lastPromptRef.current = lastUser?.content ?? null;
      lastPersistedRef.current = JSON.stringify(restoredMessages);
    }
  }, []);

  useEffect(() => {
    if (messages.some((message) => message.streaming)) {
      return;
    }

    const persisted = messages.filter((message) => !message.streaming).slice(-20);
    if (persisted.length === 0) {
      lastPersistedRef.current = null;
      removeStoredValue(AGENT_HISTORY_STORAGE_KEY);
      return;
    }

    const serialized = JSON.stringify(persisted);
    if (serialized === lastPersistedRef.current) {
      return;
    }

    lastPersistedRef.current = serialized;
    saveStoredJson(AGENT_HISTORY_STORAGE_KEY, persisted);
  }, [messages]);

  const sendMessage = async (text: string, options?: { retry?: boolean }) => {
    const retry = options?.retry ?? false;
    if (!text.trim() || streaming) return;

    const trimmed = text.trim();
    lastPromptRef.current = trimmed;

    const userMsg: ChatMessage = { id: ++idRef.current, role: 'user', content: trimmed };
    const assistantMsg: ChatMessage = {
      id: ++idRef.current,
      role: 'assistant',
      content: '',
      streaming: true,
    };

    const updatedMessages = retry ? [...messages] : [...messages, userMsg];
    setMessages([...updatedMessages, assistantMsg].slice(-21));
    if (!retry) {
      setInput('');
    }
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await explorerFetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({ error: 'Request failed' }))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(errBody.detail ?? errBody.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              message?: string;
            };
            if (event.type === 'delta' && event.text) {
              fullText += event.text;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: fullText };
                }
                return updated;
              });
            } else if (event.type === 'error') {
              setError(event.message ?? 'Unknown error');
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      // Mark streaming complete
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant') {
          updated[updated.length - 1] = { ...last, streaming: false };
        }
        return updated;
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              streaming: false,
              content: last.content || '(stopped)',
            };
          }
          return updated;
        });
      } else {
        setError(String(err));
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleSubmit = () => {
    sendMessage(input);
  };

  const handleClearConversation = () => {
    abortRef.current?.abort();
    archiveSession(messages);
    setSessions(loadStoredJson<AgentSession[]>(AGENT_SESSIONS_KEY, [], isAgentSessionArray));
    lastPersistedRef.current = null;
    setMessages([]);
    setInput('');
    setError(null);
    setStreaming(false);
    setRestoredCount(0);
    lastPromptRef.current = null;
    removeStoredValue(AGENT_HISTORY_STORAGE_KEY);
    setShowHistory(false);
  };

  const handleRestoreSession = (session: AgentSession) => {
    abortRef.current?.abort();
    archiveSession(messages);
    setSessions(loadStoredJson<AgentSession[]>(AGENT_SESSIONS_KEY, [], isAgentSessionArray));
    lastPersistedRef.current = null;
    removeStoredValue(AGENT_HISTORY_STORAGE_KEY);
    const restored = session.messages.map((m, i) => ({ ...m, id: i + 1 }));
    idRef.current = restored.length;
    lastPromptRef.current = [...restored].reverse().find((m) => m.role === 'user')?.content ?? null;
    setMessages(restored);
    setRestoredCount(restored.length);
    setInput('');
    setError(null);
    setStreaming(false);
    setShowHistory(false);
  };

  const showInstallHelp = error ? /enoent|spawn claude|not found/i.test(error) : false;

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <PageHeader
        title="Bobsled Core Agent"
        description="Ask anything about Bobsled Core's integrations, models, pipelines, and capabilities."
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                showHistory
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              History {sessions.length > 0 && `(${sessions.length})`}
            </button>
            <button
              type="button"
              onClick={handleClearConversation}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              New conversation
            </button>
          </>
        }
      />

      {showHistory && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            Past conversations
          </div>
          {sessions.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No saved conversations yet.
            </div>
          ) : (
            <ul>
              {sessions.map((session) => (
                <li key={session.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => handleRestoreSession(session)}
                    className="w-full text-left px-4 py-3 hover:bg-secondary transition-colors"
                  >
                    <div className="text-xs text-foreground truncate">{session.title}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatSessionDate(session.startedAt)} · {session.messages.length} messages
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4 mt-4">
        {restoredCount > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-3">
            <p className="text-xs text-primary">Conversation restored — {restoredCount} messages</p>
          </div>
        )}

        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground">
                I can help you explore Bobsled Core&apos;s full capability surface. Ask me about
                integrations, data models, pipeline configuration, destinations, entity resolution,
                or CLI commands.
              </p>
            </div>

            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                Try asking
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="text-left text-xs bg-card border border-border rounded-lg px-3 py-2 hover:border-primary/50 hover:text-primary transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 text-[10px] text-muted-foreground">
              <span>Or explore directly:</span>
              <Link href="/integrations" className="text-primary hover:underline">
                Integrations
              </Link>
              <Link href="/models" className="text-primary hover:underline">
                Models
              </Link>
              <Link href="/pipelines/new" className="text-primary hover:underline">
                Pipeline Builder
              </Link>
              <Link href="/terminal" className="text-primary hover:underline">
                Terminal
              </Link>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-primary/10 text-foreground'
                  : 'bg-card border border-border'
              }`}
            >
              <div className="text-xs whitespace-pre-wrap leading-relaxed">
                {msg.content}
                {msg.streaming && !msg.content && (
                  <span className="text-muted-foreground animate-pulse">Thinking...</span>
                )}
                {msg.streaming && msg.content && (
                  <span className="text-primary animate-pulse">|</span>
                )}
              </div>
            </div>
          </div>
        ))}

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3">
            <p className="text-xs text-destructive">{error}</p>
            {showInstallHelp ? (
              <div className="mt-3 space-y-3">
                <p className="text-[10px] text-muted-foreground">
                  Claude CLI is not available in this environment. Install it and retry.
                </p>
                <pre className="rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] text-foreground">
                  brew install claude
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    const retryPrompt = lastPromptRef.current ?? 'What can you help me with?';
                    void sendMessage(retryPrompt, { retry: true });
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground mt-1">
                Make sure Claude Code CLI is installed and available in your PATH.
              </p>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={streaming ? 'Waiting for response...' : 'Ask about Bobsled Core...'}
          disabled={streaming}
          className="flex-1 bg-input border border-border rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        {streaming ? (
          <button
            onClick={handleStop}
            className="px-4 py-2 text-xs bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/80"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="px-4 py-2 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80 disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
