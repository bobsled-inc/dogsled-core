/**
 * `compromise` NER fallback for mention extraction.
 *
 * When the LLM disambiguator returns `provider_error` or
 * `budget_exceeded`, the discriminated-union path in `extract.ts` already
 * surfaces an `unresolved` row. This module provides the offline-NER
 * fallback that runs BEFORE candidate retrieval — it extracts entity
 * mention spans from raw chunk text using the dependency-light
 * `compromise` library. Used in `--fallback compromise` mode.
 *
 * Note: `compromise` is loaded dynamically so the module compiles even
 * when the runtime dependency isn't installed (it's an optional
 * `peerDependencies` slot in package.json). The factory throws a
 * `CommandError(1)` (runtime error per AGENTS.md exit-code policy)
 * with an actionable install hint if the import fails or the module
 * shape is unexpected, so the dispatch path stays safe in production
 * builds.
 */

import { CommandError } from '@bobsled-inc/protocol';

export interface CompromiseFallbackInput {
  text: string;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
}

export interface FallbackMentionSpan {
  entity_type: string;
  entity_name: string;
  span_start: number;
  span_end: number;
  /** Source-form confidence — compromise's NER quality varies by entity type. */
  source_confidence: number;
}

export interface CompromiseFallback {
  extract(input: CompromiseFallbackInput): Promise<FallbackMentionSpan[]>;
}

/**
 * Research notes:
 *  - People names: ~85-90% precision on news text → 0.7 source confidence.
 *  - Places: ~70-75% recall (limited gazetteer) → 0.6.
 *  - Organizations: ~60-70% precision (weakest) → 0.55.
 */
type CompromiseEntityType = 'company' | 'person' | 'product' | 'location';

const ENTITY_CONFIDENCE: Record<CompromiseEntityType, number> = {
  person: 0.7,
  location: 0.6,
  company: 0.55,
  product: 0.55,
};

interface CompromiseDoc {
  people: () => CompromiseTermSet;
  organizations: () => CompromiseTermSet;
  places: () => CompromiseTermSet;
  match: (selector: string) => CompromiseTermSet;
}

interface CompromiseTermSet {
  out: (format: string) => Array<{ text: string; offset?: { start: number; length: number } }>;
}

interface CompromiseModule {
  default?: (text: string) => CompromiseDoc;
}

let cachedCompromise: ((text: string) => CompromiseDoc) | null = null;

async function loadCompromise(): Promise<(text: string) => CompromiseDoc> {
  if (cachedCompromise) return cachedCompromise;
  try {
    // The `compromise` package is an optional peer — documented in package metadata
    // and the workspace catalog so consumer projects can install it on
    // demand. Use a string-typed dynamic import so this module compiles
    // without the dep present (it's only loaded when --fallback compromise
    // is active).
    const moduleName = 'compromise';
    const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as
      | CompromiseModule
      | ((t: string) => CompromiseDoc);
    if (typeof mod === 'function') {
      cachedCompromise = mod;
      return cachedCompromise;
    }
    if (mod && typeof mod === 'object' && typeof (mod as CompromiseModule).default === 'function') {
      cachedCompromise = (mod as CompromiseModule).default!;
      return cachedCompromise;
    }
    // Module-shape failure is a runtime condition (the package is
    // installed but its export shape is unexpected), not user input
    // validation — CommandError(1) per AGENTS.md.
    throw new CommandError('compromise module shape unrecognized', 1);
  } catch (err) {
    if (err instanceof CommandError) throw err;
    // Narrow the install-hint rewrite to actual missing-module errors.
    // Other failures (package present but errors on init, transitive dep
    // problems, etc.) need their original message + stack so operators
    // can debug; sending them to "install compromise" is misleading.
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    const isMissingModule =
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      /cannot find (module|package) ['"]compromise['"]/i.test(message);
    if (isMissingModule) {
      throw new CommandError(
        `compromise NER fallback requires the 'compromise' package. Install via ` +
          `'pnpm add compromise' in your project (declared as optional peerDependency).`,
        1
      );
    }
    throw err;
  }
}

function pickSpans(set: CompromiseTermSet, type: CompromiseEntityType): FallbackMentionSpan[] {
  const offsets = set.out('offset');
  return offsets
    .filter(
      (t) =>
        // Skip entries lacking valid offsets — fabricating span_start=0 /
        // span_end=text.length produces collision-prone mention IDs and
        // misleading spans.
        typeof t.text === 'string' &&
        t.text.length > 1 &&
        typeof t.offset?.start === 'number' &&
        Number.isFinite(t.offset.start) &&
        t.offset.start >= 0 &&
        typeof t.offset?.length === 'number' &&
        Number.isFinite(t.offset.length) &&
        t.offset.length > 0
    )
    .map((t) => {
      const start = t.offset!.start;
      const length = t.offset!.length;
      return {
        entity_type: type,
        entity_name: t.text,
        span_start: start,
        span_end: start + length,
        source_confidence: ENTITY_CONFIDENCE[type],
      };
    });
}

function normalizeEntityType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GENERIC_TYPE_ALIASES: Record<CompromiseEntityType, readonly string[]> = {
  company: [
    'company',
    'organization',
    'org',
    'customer',
    'account',
    'vendor',
    'supplier',
    'partner',
  ],
  person: [
    'person',
    'people',
    'contact',
    'user',
    'employee',
    'engineer',
    'developer',
    'maintainer',
    'author',
    'reviewer',
    'assignee',
  ],
  product: ['product', 'sku', 'service', 'offering'],
  location: ['location', 'place', 'address', 'office', 'region', 'country', 'city'],
};

function mapEntityType(
  fallbackType: CompromiseEntityType,
  entityTypes: readonly string[] | undefined
): string {
  if (!entityTypes || entityTypes.length === 0) return fallbackType;
  if (entityTypes.length > 1) return fallbackType;
  const normalized = entityTypes.map((entityType) => ({
    raw: entityType,
    normalized: normalizeEntityType(entityType),
  }));
  const fallbackNormalized = normalizeEntityType(fallbackType);
  const direct = normalized.find((entityType) => entityType.normalized === fallbackNormalized);
  if (direct) return direct.raw;

  const aliases = GENERIC_TYPE_ALIASES[fallbackType].map(normalizeEntityType);
  const aliased = normalized.find((entityType) =>
    aliases.some(
      (alias) => entityType.normalized === alias || entityType.normalized.includes(alias)
    )
  );
  if (aliased) return aliased.raw;

  return entityTypes.length === 1 ? entityTypes[0]! : fallbackType;
}

/**
 * Lazy-load wrapper around the `compromise` library. Tests can stub the
 * runtime via `createCompromiseFallback({nlp: fakeNlp})` to exercise the
 * span-extraction path without taking the dynamic-import dependency.
 */
export interface CompromiseFallbackOptions {
  /** Test seam — inject a fake `nlp` factory to avoid the dynamic import. */
  nlp?: (text: string) => CompromiseDoc;
  /**
   * Domain entity types from a mention extraction spec. When supplied, generic
   * compromise labels such as `company` are mapped onto these project-specific
   * entity types so downstream candidate retrieval and relationship ontologies
   * speak the same vocabulary.
   */
  entityTypes?: readonly string[];
}

export function createCompromiseFallback(
  options: CompromiseFallbackOptions = {}
): CompromiseFallback {
  return {
    async extract(input) {
      const nlp = options.nlp ?? (await loadCompromise());
      const doc = nlp(input.text);
      return [
        ...pickSpans(doc.people(), 'person'),
        ...pickSpans(doc.organizations(), 'company'),
        ...pickSpans(doc.places(), 'location'),
      ].map((span) => ({
        ...span,
        entity_type: mapEntityType(span.entity_type as CompromiseEntityType, options.entityTypes),
      }));
    },
  };
}
