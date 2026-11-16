'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useState, useEffect, useCallback } from 'react';

interface ChatMessage {
  id: number;
  role: 'assistant' | 'user';
  content: string;
  options?: Array<{ label: string; value: string; desc?: string }>;
  type?: 'text' | 'selection' | 'preset';
}

interface SetupPreset {
  id: string;
  displayName: string;
  description: string;
  recommendedIntegrations: string[];
  defaultDestination: string;
  defaultSchedule: string;
}

interface SetupDestination {
  type: string;
  displayName: string;
  plainLanguagePurpose: string;
  bestFor: string[];
  requiredFields: string[];
}

interface SetupIntegration {
  name: string;
  displayName: string;
  category: string;
  plainLanguagePurpose: string;
  bestFor: string[];
  authDifficulty: string;
  recommendedResources: string[];
}

interface SetupCatalog {
  presets: SetupPreset[];
  destinations: SetupDestination[];
  integrations: SetupIntegration[];
}

type SetupPhase =
  'loading' | 'welcome' | 'goal' | 'preset' | 'sources' | 'destination' | 'schedule' | 'summary';

export default function SetupPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<SetupPhase>('loading');
  const [input, setInput] = useState('');
  const [catalog, setCatalog] = useState<SetupCatalog | null>(null);
  const [answers, setAnswers] = useState({
    goal: '',
    preset: '',
    presetName: '',
    sources: [] as string[],
    destination: '',
    destinationName: '',
    schedule: 'daily',
  });
  const [pendingRec, setPendingRec] = useState<{
    sources?: string[];
    destination?: string;
    schedule?: string;
  } | null>(null);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: prev.length + 1 }]);
  }, []);

  // Load catalog from Bobsled Core setup describe API
  useEffect(() => {
    async function loadCatalog() {
      try {
        const r = await explorerFetch('/api/setup/describe');
        if (r.ok) {
          const data = (await r.json()) as SetupCatalog;
          setCatalog(data);
        }
      } catch {
        // Fall back to defaults if API fails
      }
      setPhase('welcome');
    }
    loadCatalog();
  }, []);

  useEffect(() => {
    if (phase === 'welcome' && messages.length === 0) {
      addMessage({
        role: 'assistant',
        content:
          "Welcome to Bobsled Core Setup! I'll help you configure a data pipeline.\n\nWhat's your primary goal? Describe it in plain English, or pick a preset below.",
        type: 'text',
      });
    }
  }, [phase, messages.length, addMessage]);

  const presets = catalog?.presets ?? [
    {
      id: 'saas-analytics',
      displayName: 'SaaS Analytics',
      description: 'Product, revenue, and growth reporting',
      recommendedIntegrations: ['stripe', 'hubspot', 'github'],
      defaultDestination: 'bigquery',
      defaultSchedule: 'every 4h',
    },
    {
      id: 'crm-revops',
      displayName: 'CRM RevOps',
      description: 'Full revenue operations pipeline',
      recommendedIntegrations: ['hubspot', 'salesforce', 'stripe'],
      defaultDestination: 'bigquery',
      defaultSchedule: 'every 4h',
    },
    {
      id: 'ad-spend',
      displayName: 'Ad Spend Reporting',
      description: 'Paid media performance tracking',
      recommendedIntegrations: ['google_ads', 'facebook_ads', 'hubspot'],
      defaultDestination: 'bigquery',
      defaultSchedule: 'daily',
    },
    {
      id: 'support-ops',
      displayName: 'Support Ops',
      description: 'Customer support analytics',
      recommendedIntegrations: ['zendesk', 'intercom', 'slack'],
      defaultDestination: 'postgres',
      defaultSchedule: 'every 4h',
    },
    {
      id: 'finance-ops',
      displayName: 'Finance Ops',
      description: 'Financial reporting and cost tracking',
      recommendedIntegrations: ['stripe', 'quickbooks', 'vantage'],
      defaultDestination: 'bigquery',
      defaultSchedule: 'daily',
    },
  ];

  const destinations = catalog?.destinations ?? [
    {
      type: 'duckdb',
      displayName: 'DuckDB',
      plainLanguagePurpose: 'Local zero-infra warehouse',
      bestFor: ['demos', 'local dev'],
      requiredFields: ['db_path'],
    },
    {
      type: 'bigquery',
      displayName: 'BigQuery',
      plainLanguagePurpose: 'Managed analytics warehouse',
      bestFor: ['shared reporting'],
      requiredFields: ['project', 'dataset'],
    },
    {
      type: 'snowflake',
      displayName: 'Snowflake',
      plainLanguagePurpose: 'Enterprise cloud warehouse',
      bestFor: ['enterprise analytics'],
      requiredFields: ['account', 'warehouse'],
    },
    {
      type: 'postgres',
      displayName: 'PostgreSQL',
      plainLanguagePurpose: 'Relational database',
      bestFor: ['operational analytics'],
      requiredFields: ['host', 'database'],
    },
  ];

  const handleUserGoal = async (text: string) => {
    addMessage({ role: 'user', content: text });
    setAnswers((a) => ({ ...a, goal: text }));

    // Try to get recommendation from Bobsled Core API
    try {
      const r = await explorerFetch('/api/setup/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: text }),
      });
      if (r.ok) {
        const rec = (await r.json()) as {
          preset?: { id: string; displayName: string };
          sources?: Array<{ integration: string }>;
          destination?: { type: string };
          schedule?: string;
          summary?: string;
        };
        if (rec.preset) {
          setPendingRec({
            sources: rec.sources?.map((s) => s.integration),
            destination: rec.destination?.type,
            schedule: rec.schedule,
          });
          addMessage({
            role: 'assistant',
            content: `Based on your goal, I'd recommend the **${rec.preset.displayName}** preset.\n\n${rec.summary ?? ''}\n\nWould you like to use this recommendation, or customize?`,
            type: 'selection',
            options: [
              { label: `Use ${rec.preset.displayName} preset`, value: rec.preset.id },
              { label: 'Customize from scratch', value: 'custom' },
            ],
          });
          setPhase('preset');
          return;
        }
      }
    } catch {
      // API not available, proceed with manual flow
    }

    setPhase('preset');
    addMessage({
      role: 'assistant',
      content: 'Would any of these presets match what you need?',
      type: 'preset',
    });
  };

  const selectPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) {
      setPhase('sources');
      addMessage({ role: 'user', content: "I'll configure custom sources" });
      addMessage({
        role: 'assistant',
        content:
          'Head to the **Integrations** page to browse available connectors, then use the **Pipeline Builder** to configure your pipeline.',
        type: 'text',
      });
      setPhase('summary');
      return;
    }

    const sources = pendingRec?.sources ?? preset.recommendedIntegrations;
    const schedule = pendingRec?.schedule ?? preset.defaultSchedule;
    const prefilledDest = pendingRec?.destination;
    setPendingRec(null);

    addMessage({ role: 'user', content: `I'll use the ${preset.displayName} preset` });
    setAnswers((a) => ({
      ...a,
      preset: presetId,
      presetName: preset.displayName,
      sources,
      schedule,
    }));
    setPhase('destination');
    addMessage({
      role: 'assistant',
      content: `The **${preset.displayName}** preset includes: ${sources.join(', ')}.${prefilledDest ? ` (Recommended destination: ${prefilledDest})` : ''}\n\nWhere should the data land?`,
      type: 'selection',
      options: destinations.map((d) => ({
        label: d.displayName,
        value: d.type,
        desc: d.plainLanguagePurpose,
      })),
    });
  };

  const selectDestination = (destType: string) => {
    const dest = destinations.find((d) => d.type === destType);
    addMessage({ role: 'user', content: dest?.displayName ?? destType });
    setAnswers((a) => ({
      ...a,
      destination: destType,
      destinationName: dest?.displayName ?? destType,
    }));
    setPhase('schedule');
    addMessage({
      role: 'assistant',
      content: 'How often should the data sync?',
      type: 'selection',
      options: [
        { label: 'Hourly', value: 'hourly' },
        { label: 'Every 4 hours', value: 'every 4h' },
        { label: 'Daily', value: 'daily' },
        { label: 'Weekly', value: 'weekly' },
      ],
    });
  };

  const selectSchedule = useCallback(
    (schedule: string) => {
      addMessage({ role: 'user', content: schedule });
      setAnswers((a) => ({ ...a, schedule }));
      setPhase('summary');
      addMessage({
        role: 'assistant',
        content: [
          `Here's your configuration:\n`,
          `**Goal:** ${answers.goal}`,
          answers.presetName ? `**Preset:** ${answers.presetName}` : null,
          `**Sources:** ${answers.sources.join(', ')}`,
          `**Destination:** ${answers.destinationName || answers.destination}`,
          `**Schedule:** ${schedule}`,
          '',
          'Next steps:',
          '- Go to **Pipeline Builder** to refine resources and export `bobsled.yml`',
          '- Go to **Terminal** to run `bobsled setup render` with your config',
          '- Go to **Integrations** to explore resource schemas',
        ]
          .filter(Boolean)
          .join('\n'),
        type: 'text',
      });
    },
    [answers, addMessage]
  );

  const handleOptionSelect = (value: string) => {
    if (phase === 'preset') {
      selectPreset(value);
    } else if (phase === 'destination') {
      selectDestination(value);
    } else if (phase === 'schedule') {
      selectSchedule(value);
    }
  };

  const handleInputSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    if (phase === 'welcome' || phase === 'goal') {
      handleUserGoal(text);
    } else if (phase === 'schedule') {
      selectSchedule(text);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Setup Wizard</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Guided pipeline configuration
          {catalog && <span className="ml-2 text-accent">(connected to Bobsled Core)</span>}
        </p>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {phase === 'loading' && (
          <div className="space-y-2 py-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-secondary" />
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-primary/10 text-foreground shadow-sm'
                  : 'bg-card border border-border/60 shadow-xs'
              }`}
            >
              <div className="text-xs whitespace-pre-wrap">{msg.content}</div>

              {/* Preset cards */}
              {msg.type === 'preset' && (
                <div className="grid grid-cols-1 gap-2 mt-3">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => selectPreset(preset.id)}
                      className="text-left bg-secondary rounded-lg p-3 border border-transparent hover:border-primary/30 hover:bg-primary/10 hover:shadow-sm transition-colors"
                    >
                      <div className="text-xs font-medium">{preset.displayName}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {preset.description} ({preset.recommendedIntegrations.join(', ')})
                      </div>
                    </button>
                  ))}
                  <button
                    onClick={() => selectPreset('custom')}
                    className="text-left bg-secondary rounded-lg p-3 border border-transparent hover:border-primary/30 hover:bg-primary/10 hover:shadow-sm transition-colors"
                  >
                    <div className="text-xs font-medium">Custom</div>
                    <div className="text-[10px] text-muted-foreground">
                      Choose your own integrations
                    </div>
                  </button>
                </div>
              )}

              {/* Selection options */}
              {msg.type === 'selection' && msg.options && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {msg.options.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleOptionSelect(opt.value)}
                      className="text-left text-[10px] bg-secondary px-2.5 py-1.5 rounded hover:bg-primary/10 hover:text-primary transition-colors"
                    >
                      <div>{opt.label}</div>
                      {opt.desc && <div className="text-muted-foreground mt-0.5">{opt.desc}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleInputSubmit();
          }}
          placeholder={
            phase === 'summary'
              ? 'Setup complete!'
              : phase === 'loading'
                ? 'Loading...'
                : 'Type your response...'
          }
          disabled={phase === 'summary' || phase === 'loading'}
          className="flex-1 bg-input border border-border rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        <button
          onClick={handleInputSubmit}
          disabled={!input.trim() || phase === 'summary' || phase === 'loading'}
          className="px-4 py-2 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
