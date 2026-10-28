'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import YAML from 'yaml';
import { PageHeader } from '@/components/ui/page-header';
import { useEntityGraphAssistantContext } from '@/components/entity-graph/entity-graph-assistant-context';
import { DesignStepBody } from '@/components/entity-graph/design-step-body';
import { DESIGN_STEPS, DesignSteps, type DesignStep } from '@/components/entity-graph/design-steps';
import { isEntityGraphDesignStep } from '@/lib/entity-graph-design-flow';
import { isPlainObject } from '@/lib/guards';
import { type ResolutionSpec } from '@/lib/entity-graph-design-spec';
import {
  buildEntityGraphHref,
  getEntityGraphEntityDefinition,
  getEntityGraphOverviewHref,
  getEntityGraphScenarioDefinition,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import {
  clearPersistedEntityGraphWizardStateForContext,
  createBlankResolutionSpec,
  loadPersistedEntityGraphWizardStateForContext,
  savePersistedEntityGraphWizardStateForContext,
  type PersistedEntityGraphWizardState,
} from '@/lib/entity-graph-wizard-state';
import { formatEntityGraphRouteErrorMessage, parseJsonText } from '@/lib/entity-graph-route-errors';

interface SpecsResponse {
  specs?: string[];
}

interface LoadSpecResponse {
  yaml?: string;
  spec?: ResolutionSpec;
  error?: string;
}

export interface DesignSurfaceRoutes {
  /** Build the URL for this exact page with updated query params (used by router.replace). */
  buildPath: (params: Record<string, string>) => string;
  /** Static href for resolve in the same context (used by Commit & Resolve redirect). */
  resolveHref: (params?: Record<string, string>) => string;
  /** Href for the parent overview page (used by breadcrumb + error fallback). */
  overviewHref: string;
  /** Href for switching to a different entity within the same scenario. */
  entityHref: (entityId: 'company' | 'customer' | 'location') => string;
  /** Breadcrumb crumbs between "Dogsled" and the current page label (e.g. "Design"). */
  breadcrumbs?: ReadonlyArray<{ label: string; href?: string }>;
}

interface EntityGraphDesignPageInnerProps {
  scenarioId: EntityGraphScenarioId;
  entityId: EntityGraphEntityId;
  routes?: DesignSurfaceRoutes;
}

export function EntityGraphDesignPageInner({
  scenarioId,
  entityId,
  routes,
}: EntityGraphDesignPageInnerProps) {
  const { clearAssistantSpec, setAssistantSpec } = useEntityGraphAssistantContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const scenarioDefinition = getEntityGraphScenarioDefinition(scenarioId);
  const entityDefinition = getEntityGraphEntityDefinition(entityId);
  const resolvedRoutes = useMemo<DesignSurfaceRoutes>(
    () =>
      routes ?? {
        buildPath: (params) =>
          buildEntityGraphHref('/entity-graph/design', {
            scenario: scenarioId,
            entity: entityId,
            params,
          }),
        resolveHref: (params) =>
          buildEntityGraphHref('/entity-graph/resolve', {
            scenario: scenarioId,
            entity: entityId,
            params,
          }),
        overviewHref: getEntityGraphOverviewHref(scenarioId, entityId),
        entityHref: (e) =>
          buildEntityGraphHref('/entity-graph/design', { scenario: scenarioId, entity: e }),
      },
    [routes, scenarioId, entityId]
  );
  const initialStepParam = searchParams.get('step');
  const initialStepRef = useRef<DesignStep | null>(
    isEntityGraphDesignStep(initialStepParam) ? initialStepParam : null
  );
  const initialQueryRef = useRef(searchParams.toString());
  const skipInitialRemoteLoadRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const latestDraftRef = useRef<PersistedEntityGraphWizardState | null>(null);

  // The "initial" snapshots above freeze on first render. If the route context
  // changes via router.replace (entity switcher) without a remount, we'd reuse
  // stale URL state when restoring a saved draft. Refresh them when the
  // scenario+entity context changes.
  useEffect(() => {
    initialStepRef.current = isEntityGraphDesignStep(initialStepParam) ? initialStepParam : null;
    initialQueryRef.current = searchParams.toString();
  }, [entityId, initialStepParam, scenarioId, searchParams]);

  const [step, setStepState] = useState<DesignStep>(initialStepRef.current ?? 'overview');
  const [specName, setSpecNameState] = useState(entityDefinition.defaultResolutionSpec);
  const [availableSpecs, setAvailableSpecs] = useState<string[]>([]);
  const [spec, setSpecState] = useState<ResolutionSpec | null>(null);
  const [yamlText, setYamlTextState] = useState('');
  const [yamlDirty, setYamlDirtyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [draftActive, setDraftActive] = useState(false);

  const syncStepToUrl = useCallback(
    (next: DesignStep) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('step', next);
      router.replace(resolvedRoutes.buildPath(Object.fromEntries(params.entries())));
    },
    [resolvedRoutes, router, searchParams]
  );

  const setStep = useCallback(
    (next: DesignStep) => {
      setStepState(next);
      syncStepToUrl(next);
    },
    [syncStepToUrl]
  );

  const setYamlTextFromEditor = useCallback((value: string) => {
    setDraftActive(true);
    setYamlDirtyState(true);
    setYamlTextState(value);
  }, []);

  const setSpec = useCallback((next: ResolutionSpec) => {
    setDraftActive(true);
    setSpecState(next);
  }, []);

  const setSpecName = useCallback((next: string) => {
    setDraftActive(true);
    setSpecNameState(next);
  }, []);

  const resetYamlToForm = useCallback(() => {
    if (!spec) return;
    try {
      setDraftActive(true);
      setYamlTextState(YAML.stringify(spec));
      setYamlDirtyState(false);
      setSaveError(null);
    } catch {
      // ignore serialization hiccups during editing
    }
  }, [spec]);

  useEffect(() => {
    const savedState = loadPersistedEntityGraphWizardStateForContext({ scenarioId, entityId });
    if (savedState) {
      skipInitialRemoteLoadRef.current = true;
      setStepState(initialStepRef.current ?? savedState.step);
      setSpecNameState(savedState.specName);
      setSpecState(savedState.spec);
      setYamlTextState(savedState.yamlText);
      setYamlDirtyState(savedState.yamlDirty);
      setDraftActive(true);

      if (!initialStepRef.current) {
        const params = new URLSearchParams(initialQueryRef.current);
        params.set('step', savedState.step);
        router.replace(resolvedRoutes.buildPath(Object.fromEntries(params.entries())));
      }
    }

    setHydrated(true);
  }, [entityId, resolvedRoutes, router, scenarioId]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    explorerFetch(
      `/api/entity-graph/specs?type=resolution&scenario=${encodeURIComponent(scenarioId)}`
    )
      .then((response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return response.json();
      })
      .then((payload: SpecsResponse) => {
        if (cancelled) return;
        const specs = payload.specs ?? [];
        if (draftActive) {
          const nextSpecs = specName && !specs.includes(specName) ? [specName, ...specs] : specs;
          setAvailableSpecs(nextSpecs);
          return;
        }

        setAvailableSpecs(specs);
        if (specs.length > 0 && !specs.includes(specName)) {
          setSpecNameState(specs[0]!);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draftActive, hydrated, scenarioId, specName]);

  useEffect(() => {
    if (!hydrated) return;
    if (skipInitialRemoteLoadRef.current) {
      skipInitialRemoteLoadRef.current = false;
      return;
    }

    let cancelled = false;
    setError(null);
    setSpecState(null);
    setSaveError(null);
    explorerFetch(
      `/api/entity-graph/specs/${encodeURIComponent(specName)}?type=resolution&scenario=${encodeURIComponent(scenarioId)}`
    )
      .then((response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return response.json();
      })
      .then((payload: LoadSpecResponse) => {
        if (cancelled) return;
        if (payload.error) {
          setError(payload.error);
          return;
        }
        setSpecState(payload.spec ?? null);
        setYamlTextState(payload.yaml ?? '');
        setYamlDirtyState(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, scenarioId, specName]);

  useEffect(() => {
    if (!spec || yamlDirty) return;
    try {
      setYamlTextState(YAML.stringify(spec));
    } catch {
      // ignore serialization hiccups during editing
    }
  }, [spec, yamlDirty]);

  useEffect(() => {
    setSaveError(null);
  }, [specName, yamlText]);

  useEffect(() => {
    latestDraftRef.current =
      hydrated && draftActive && spec
        ? {
            scenarioId,
            entityId,
            step,
            specName,
            spec,
            yamlText,
            yamlDirty,
            savedAt: new Date().toISOString(),
          }
        : null;
  }, [draftActive, entityId, hydrated, scenarioId, spec, specName, step, yamlDirty, yamlText]);

  useEffect(() => {
    setAssistantSpec({
      specName,
      specYaml: yamlText.trim() ? yamlText : null,
    });
  }, [setAssistantSpec, specName, yamlText]);

  // Returns the cleanup fn directly so it fires on unmount + when the assistant
  // context's clearer changes — clears the spec from the assistant rail.
  useEffect(() => clearAssistantSpec, [clearAssistantSpec]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !draftActive || !spec) return;
    const timer = window.setTimeout(() => {
      savePersistedEntityGraphWizardStateForContext(
        { scenarioId, entityId },
        {
          scenarioId,
          entityId,
          step,
          specName,
          spec,
          yamlText,
          yamlDirty,
          savedAt: new Date().toISOString(),
        }
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftActive, entityId, hydrated, scenarioId, spec, specName, step, yamlDirty, yamlText]);

  useEffect(() => {
    return () => {
      const draft = latestDraftRef.current;
      if (!draft) return;
      // Fallbacks are not dead code: PersistedEntityGraphWizardState types scenarioId
      // and entityId as optional, so legacy persisted blobs may lack them.
      savePersistedEntityGraphWizardStateForContext(
        { scenarioId: draft.scenarioId ?? 'default', entityId: draft.entityId ?? 'company' },
        { ...draft, savedAt: new Date().toISOString() }
      );
    };
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!yamlText) return false;

    setSaving(true);
    setSaveError(null);
    setToast(null);

    try {
      const response = await explorerFetch(
        `/api/entity-graph/specs/${encodeURIComponent(specName)}?type=resolution&scenario=${encodeURIComponent(scenarioId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yaml: yamlText }),
        }
      );
      const rawText = await response.text();
      const body = parseJsonText(rawText);
      if (!response.ok || !isPlainObject(body) || !body.ok) {
        throw new Error(
          formatEntityGraphRouteErrorMessage(body, `Save failed (${response.status})`, true)
        );
      }

      // Trust the server-validated spec from the response (route ran ResolutionSpecSchema)
      // instead of re-parsing the YAML and casting unknown → ResolutionSpec on the client.
      if (isPlainObject(body.spec)) {
        setSpecState(body.spec as ResolutionSpec);
      }
      setYamlDirtyState(false);
      setToast('Spec saved.');
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [scenarioId, specName, yamlText]);

  const commit = useCallback(async () => {
    const ok = await save();
    if (!ok) return;
    const canAutorun = specName === entityDefinition.defaultResolutionSpec;
    router.push(
      resolvedRoutes.resolveHref(canAutorun ? { autorun: '1', agentSample: '1' } : undefined)
    );
  }, [entityDefinition.defaultResolutionSpec, resolvedRoutes, router, save, specName]);

  const resetWizard = useCallback(() => {
    const blankSpec = createBlankResolutionSpec(specName);
    clearPersistedEntityGraphWizardStateForContext({ scenarioId, entityId });
    latestDraftRef.current = null;
    setDraftActive(false);
    setError(null);
    setSaveError(null);
    setSpecState(blankSpec);
    setYamlDirtyState(false);
    setYamlTextState(YAML.stringify(blankSpec));
    setStepState('overview');
    syncStepToUrl('overview');
    setToast('Saved draft cleared. Wizard reset to a blank slate.');
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
  }, [entityId, scenarioId, specName, syncStepToUrl]);

  const currentIndex = useMemo(() => DESIGN_STEPS.findIndex((item) => item.id === step), [step]);
  const prevStep = currentIndex > 0 ? DESIGN_STEPS[currentIndex - 1]!.id : null;
  const nextStep =
    currentIndex >= 0 && currentIndex < DESIGN_STEPS.length - 1
      ? DESIGN_STEPS[currentIndex + 1]!.id
      : null;

  if (error) {
    return (
      <div className="p-8 text-sm text-red-500">
        Failed to load spec: {error}
        <br />
        <Link
          href={resolvedRoutes.overviewHref}
          className="mt-2 inline-block text-primary hover:underline"
        >
          ← Back to Entity Graph
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          ...(resolvedRoutes.breadcrumbs ?? [
            { label: 'Entity Graph', href: resolvedRoutes.overviewHref },
          ]),
          { label: 'Design' },
        ]}
        title={`${entityDefinition.label} · Design`}
        description={
          spec?.description ??
          `Configure how ${entityDefinition.pluralLabel} resolve into golden ${entityDefinition.singularLabel} records.`
        }
        actions={
          <div className="flex items-center gap-2">
            {scenarioDefinition.supportedEntities.length > 1 && (
              <div className="mr-2 flex items-center gap-1 rounded-full border border-border bg-background/70 p-1">
                {scenarioDefinition.supportedEntities.map((supportedEntityId) => {
                  const supportedEntity = getEntityGraphEntityDefinition(supportedEntityId);
                  const active = supportedEntityId === entityId;
                  return (
                    <button
                      key={supportedEntityId}
                      type="button"
                      onClick={() => router.replace(resolvedRoutes.entityHref(supportedEntityId))}
                      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {supportedEntity.label}
                    </button>
                  );
                })}
              </div>
            )}
            {availableSpecs.length > 1 && (
              <select
                value={specName}
                onChange={(e) => setSpecName(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                aria-label="Select resolution spec"
              >
                {availableSpecs.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={resetWizard}
              disabled={saving}
              className="rounded-md border border-transparent bg-transparent px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !yamlText}
              className="rounded-md border border-border bg-transparent px-3 py-1.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              onClick={() => void commit()}
              disabled={saving || !yamlText}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Commit & Resolve →
            </button>
          </div>
        }
      />

      <DesignSteps current={step} onChange={setStep} />

      {toast && (
        <div className="rounded-md border border-accent/30 border-l-4 border-l-accent bg-accent/10 px-3 py-2 text-xs text-accent">
          {toast}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-5">
        {spec ? (
          <DesignStepBody
            step={step}
            spec={spec}
            specName={specName}
            workspaceHint={`${scenarioDefinition.workspaceDir}/entity-graph/${specName}.yml`}
            yamlText={yamlText}
            yamlDirty={yamlDirty}
            setYamlText={setYamlTextFromEditor}
            setSpec={setSpec}
            resetYamlToForm={resetYamlToForm}
            saveError={saveError}
          />
        ) : (
          <div
            className="grid grid-cols-2 gap-4 animate-pulse"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="sr-only">Loading spec…</span>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <div className="h-4 bg-muted rounded w-3/4 mb-1" />
                <div className="h-6 bg-muted/60 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => prevStep && setStep(prevStep)}
          disabled={!prevStep}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={() => nextStep && setStep(nextStep)}
          disabled={!nextStep}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
