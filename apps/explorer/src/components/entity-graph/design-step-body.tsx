'use client';

import { useState } from 'react';
import { type DesignStep } from './design-steps';
import OverviewStep from './design-overview-step';
import { ThresholdPanel } from './threshold-panel';
import {
  KNOWN_ALGORITHMS,
  KNOWN_TRANSFORMS,
  type BlockingRule,
  type ResolutionInput,
  type ResolutionSpec,
  type ResolutionThresholds,
} from '@/lib/entity-graph-design-spec';

export interface DesignStepBodyProps {
  step: DesignStep;
  spec: ResolutionSpec;
  specName: string;
  workspaceHint: string;
  yamlText: string;
  yamlDirty: boolean;
  setYamlText: (value: string) => void;
  setSpec: (next: ResolutionSpec) => void;
  resetYamlToForm: () => void;
  saveError: string | null;
}

interface SpecStepProps {
  spec: ResolutionSpec;
  setSpec: (next: ResolutionSpec) => void;
}

interface ThresholdsStepProps {
  spec: ResolutionSpec;
  onChange: (next: ResolutionThresholds) => void;
}

interface ReviewStepProps {
  yamlText: string;
  yamlDirty: boolean;
  setYamlText: (value: string) => void;
  resetYamlToForm: () => void;
  error: string | null;
}

function normalizeBlockingConfig(
  rules: BlockingRule[],
  candidateLimit: number | undefined
): ResolutionSpec['blocking'] {
  if ((!rules || rules.length === 0) && candidateLimit === undefined) {
    return undefined;
  }

  return {
    rules,
    candidate_limit: candidateLimit,
  };
}

export function DesignStepBody({
  step,
  spec,
  specName,
  workspaceHint,
  yamlText,
  yamlDirty,
  setYamlText,
  setSpec,
  resetYamlToForm,
  saveError,
}: DesignStepBodyProps) {
  switch (step) {
    case 'overview':
      return <OverviewStep spec={spec} specName={specName} workspaceHint={workspaceHint} />;
    case 'entity':
      return <EntityStep spec={spec} setSpec={setSpec} />;
    case 'inputs':
      return <InputsStep spec={spec} setSpec={setSpec} />;
    case 'standardize':
      return <StandardizeStep spec={spec} setSpec={setSpec} />;
    case 'blocking':
      return <BlockingStep spec={spec} setSpec={setSpec} />;
    case 'scoring':
      return <ScoringStep spec={spec} setSpec={setSpec} />;
    case 'thresholds':
      return (
        <ThresholdsStep spec={spec} onChange={(next) => setSpec({ ...spec, thresholds: next })} />
      );
    case 'review':
      return (
        <ReviewStep
          yamlText={yamlText}
          yamlDirty={yamlDirty}
          setYamlText={setYamlText}
          resetYamlToForm={resetYamlToForm}
          error={saveError}
        />
      );
  }
}

function EntityStep({ spec, setSpec }: SpecStepProps) {
  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold">Entity</h2>
      <p className="text-xs text-muted-foreground">
        The entity is the subject the resolution produces (Company, Person, Product). Derived from
        the spec name: <code>{spec.name}</code>.
      </p>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Description
        </label>
        <textarea
          value={spec.description ?? ''}
          onChange={(e) => setSpec({ ...spec, description: e.target.value })}
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
        />
      </div>
    </div>
  );
}

function InputsStep({ spec, setSpec }: SpecStepProps) {
  const inputs = spec.inputs ?? [];

  const update = (index: number, patch: Partial<ResolutionInput>) => {
    setSpec({
      ...spec,
      inputs: inputs.map((input, inputIndex) =>
        inputIndex === index ? { ...input, ...patch } : input
      ),
    });
  };

  const remove = (index: number) => {
    setSpec({ ...spec, inputs: inputs.filter((_, inputIndex) => inputIndex !== index) });
  };

  const add = () => {
    setSpec({
      ...spec,
      inputs: [...inputs, { ref: '', role: 'internal', trust_tier: 'silver', id_fields: [] }],
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold">Inputs</h2>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Trust tier</th>
              <th className="px-3 py-2 font-medium">Id fields</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {inputs.map((input, index) => (
              <tr key={`${input.ref || 'input'}-${index}`} className="border-t border-border">
                <td className="px-3 py-1.5">
                  <input
                    type="text"
                    value={input.ref}
                    onChange={(e) => update(index, { ref: e.target.value })}
                    className="w-full rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs outline-none focus:border-primary"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <select
                    value={input.role ?? 'internal'}
                    onChange={(e) => update(index, { role: e.target.value })}
                    className="rounded border border-border bg-background px-1 py-0.5 text-xs outline-none focus:border-primary"
                  >
                    <option value="internal">internal</option>
                    <option value="provider">provider</option>
                  </select>
                </td>
                <td className="px-3 py-1.5">
                  <select
                    value={input.trust_tier ?? 'silver'}
                    onChange={(e) => update(index, { trust_tier: e.target.value })}
                    className="rounded border border-border bg-background px-1 py-0.5 text-xs outline-none focus:border-primary"
                  >
                    <option value="gold">gold</option>
                    <option value="silver">silver</option>
                    <option value="bronze">bronze</option>
                  </select>
                </td>
                <td className="px-3 py-1.5">
                  <input
                    type="text"
                    value={(input.id_fields ?? []).join(', ')}
                    onChange={(e) =>
                      update(index, {
                        id_fields: e.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                    className="w-full rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs outline-none focus:border-primary"
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="text-muted-foreground hover:text-red-500"
                    aria-label="Remove source"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={add}
        className="rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      >
        + Add source
      </button>
    </div>
  );
}

function StandardizeStep({ spec, setSpec }: SpecStepProps) {
  const rules = spec.standardize ?? [];
  const updateField = (index: number, field: string) => {
    setSpec({
      ...spec,
      standardize: rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, field } : rule
      ),
    });
  };

  const updateTransforms = (index: number, transforms: string[]) => {
    setSpec({
      ...spec,
      standardize: rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, transforms } : rule
      ),
    });
  };

  const remove = (index: number) => {
    setSpec({ ...spec, standardize: rules.filter((_, ruleIndex) => ruleIndex !== index) });
  };

  const add = () => {
    setSpec({
      ...spec,
      standardize: [...rules, { field: '', transforms: ['lowercase', 'trim'] }],
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold">Standardize</h2>
      <p className="text-xs text-muted-foreground">
        Transforms run in order per field before scoring.
      </p>
      <ul className="space-y-2">
        {rules.map((rule, index) => {
          return (
            <li
              key={`${rule.field || 'field'}-${index}`}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={rule.field}
                  onChange={(e) => updateField(index, e.target.value)}
                  placeholder="field name"
                  className="flex-1 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="text-xs text-muted-foreground hover:text-red-500"
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {KNOWN_TRANSFORMS.map((transform) => {
                  const active = rule.transforms.includes(transform);
                  const nextTransforms = active
                    ? rule.transforms.filter((value) => value !== transform)
                    : [...rule.transforms, transform];
                  return (
                    <button
                      key={transform}
                      type="button"
                      onClick={() => updateTransforms(index, nextTransforms)}
                      className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'bg-secondary text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {transform}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={add}
        className="rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      >
        + Add field
      </button>
    </div>
  );
}

function BlockingStep({ spec, setSpec }: SpecStepProps) {
  const rules = spec.blocking?.rules ?? [];
  const candidateLimit = spec.blocking?.candidate_limit;

  const updateRule = (index: number, patch: { name?: string; key?: string }) => {
    setSpec({
      ...spec,
      blocking: normalizeBlockingConfig(
        rules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
        candidateLimit
      ),
    });
  };

  const remove = (index: number) => {
    const nextRules = rules.filter((_, ruleIndex) => ruleIndex !== index);
    setSpec({
      ...spec,
      blocking: normalizeBlockingConfig(nextRules, candidateLimit),
    });
  };

  const add = () => {
    setSpec({
      ...spec,
      blocking: normalizeBlockingConfig([...rules, { name: '', key: '' }], candidateLimit),
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold">Blocking</h2>
      <p className="text-xs text-muted-foreground">
        Blocking keys are optional. Remove them to broaden matching or experiment with other
        strategies.
      </p>
      <div className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
        Too narrow and you miss matches; too broad and scoring explodes. Use starter rules for demo
        speed, then trim or replace them only when you need a different recall/precision tradeoff.
      </div>
      <ul className="space-y-2">
        {rules.map((rule, index) => (
          <li
            key={`${rule.name || 'rule'}-${index}`}
            className="space-y-2 rounded-md border border-border p-3"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={rule.name}
                onChange={(e) => updateRule(index, { name: e.target.value })}
                placeholder="rule name"
                className="flex-1 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => remove(index)}
                className="text-xs text-muted-foreground hover:text-red-500"
              >
                Remove
              </button>
            </div>
            <textarea
              value={rule.key}
              onChange={(e) => updateRule(index, { key: e.target.value })}
              rows={2}
              placeholder="SQL key expression"
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none focus:border-primary"
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      >
        + Add rule
      </button>
      <div className="flex items-center gap-2 text-xs">
        <label className="text-muted-foreground" htmlFor="candidate-limit">
          Candidate limit
        </label>
        <input
          id="candidate-limit"
          type="number"
          min={1}
          step={1000}
          value={candidateLimit ?? ''}
          placeholder="unlimited"
          onChange={(e) => {
            const raw = e.target.value.trim();
            const parsed = raw === '' ? undefined : Number(raw);
            const nextLimit =
              parsed !== undefined && Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
            setSpec({
              ...spec,
              blocking: normalizeBlockingConfig(rules, nextLimit),
            });
          }}
          className="w-28 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs outline-none focus:border-primary"
        />
      </div>
    </div>
  );
}

function ScoringStep({ spec, setSpec }: SpecStepProps) {
  const features = spec.scoring?.features ?? [];
  const total = features.reduce((sum, feature) => sum + (feature.weight ?? 0), 0);

  const updateAlgorithm = (index: number, algorithm: string) => {
    setSpec({
      ...spec,
      scoring: {
        ...spec.scoring,
        features: features.map((feature, featureIndex) =>
          featureIndex === index ? { ...feature, algorithm } : feature
        ),
      },
    });
  };

  const updateWeight = (index: number, weight: number) => {
    const nextWeight = Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 1) : 0;
    setSpec({
      ...spec,
      scoring: {
        ...spec.scoring,
        features: features.map((feature, featureIndex) =>
          featureIndex === index ? { ...feature, weight: nextWeight } : feature
        ),
      },
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold">Scoring</h2>
      <p className="text-xs text-muted-foreground">
        Weights should sum to approximately 1.0. Current total:{' '}
        <span
          className={
            Math.abs(total - 1) > 0.01 ? 'text-amber-500 font-semibold' : 'text-foreground'
          }
        >
          {total.toFixed(2)}
        </span>
      </p>
      <ul className="space-y-2">
        {features.map((feature, index) => (
          <li
            key={`${feature.field}-${feature.algorithm}-${index}`}
            className="rounded-md border border-border p-3"
          >
            <div className="mb-2 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono">{feature.field}</span>
                <select
                  value={feature.algorithm}
                  onChange={(e) => updateAlgorithm(index, e.target.value)}
                  className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] outline-none focus:border-primary"
                >
                  {KNOWN_ALGORITHMS.map((algo) => (
                    <option key={algo} value={algo}>
                      {algo}
                    </option>
                  ))}
                  {!KNOWN_ALGORITHMS.includes(feature.algorithm as never) && (
                    <option value={feature.algorithm}>{feature.algorithm}</option>
                  )}
                </select>
              </div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={feature.weight}
                onChange={(e) => updateWeight(index, Number(e.target.value))}
                className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right font-mono text-xs outline-none focus:border-primary"
              />
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={feature.weight}
              onChange={(e) => updateWeight(index, Number(e.target.value))}
              className="w-full"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThresholdsStep({ spec, onChange }: ThresholdsStepProps) {
  const values = {
    auto_merge: spec.thresholds?.auto_merge ?? 0.93,
    review: spec.thresholds?.review ?? 0.6,
    auto_reject: spec.thresholds?.auto_reject ?? 0.5,
  };

  return (
    <div className="space-y-4 text-sm">
      <h2 className="text-base font-semibold">Thresholds</h2>
      <ThresholdPanel values={values} onChange={onChange} />
    </div>
  );
}

function ReviewStep({ yamlText, yamlDirty, setYamlText, resetYamlToForm, error }: ReviewStepProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yamlText);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setCopyError('Clipboard unavailable. Copy the YAML manually.');
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Review (YAML)</h2>
        <div className="flex items-center gap-3">
          {yamlDirty && (
            <button
              type="button"
              onClick={resetYamlToForm}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Use form values
            </button>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Full spec for hand-edits. Validation runs server-side on save.
      </p>
      {copyError && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {copyError}
        </div>
      )}
      {yamlDirty && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Manual YAML edits are active. Form changes stay local until you reset the YAML back to the
          form state.
        </div>
      )}
      <textarea
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
        className="h-[420px] w-full resize-none rounded-md border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
        spellCheck={false}
      />
      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
