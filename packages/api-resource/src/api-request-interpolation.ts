import type {
  ApiRequestInterpolationContext,
  ApiRequestInterpolationMappedValues,
  ApiRequestInterpolationReference,
  ApiRequestInterpolationSource,
} from './api-request-types.js';

export type InterpolationContext = ApiRequestInterpolationContext;
export type InterpolationMappedValues = ApiRequestInterpolationMappedValues;

export interface InterpolateValueOptions {
  /**
   * Omit object properties whose whole-value template references one of these
   * optional input fields that was not supplied. This is intentionally an
   * explicit opt-in because a missing value in a path, header, or auth config
   * must continue to fail validation rather than silently becoming absent.
   */
  omitMissingInputNames?: ReadonlySet<string>;
}

type InterpolationSource = ApiRequestInterpolationSource;

/**
 * Reserved credential names. They resolve from an explicit map only when
 * `trustedCredentialNames` lists them, and never from the process.env fallback.
 */
const BLOCKED_ENV_KEYS = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS',
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'SLACK_TOKEN',
  'SLACK_BOT_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'PGPASSWORD',
]);

const TEMPLATE_RE =
  /\$\{\{\s*(input|mapped|secrets|env|integration)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/g;
const WHOLE_TEMPLATE_RE =
  /^\s*\$\{\{\s*(input|mapped|secrets|env|integration)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}\s*$/;
const UNRESOLVED_TEMPLATE_RE = /\$\{\{[\s\S]*?\}\}/;
const OMITTED_VALUE = Symbol('omitted interpolation value');

export class InterpolationError extends Error {
  readonly source: InterpolationSource;
  readonly key?: string;
  readonly path: string;

  constructor(
    source: InterpolationSource,
    key: string | undefined,
    path: string,
    reason: 'missing' | 'reserved' = 'missing'
  ) {
    const reference = `${source}${key ? `.${key}` : ''}`;
    super(
      reason === 'reserved'
        ? `Reserved credential name ${reference} referenced in ${path}. Project files cannot read reserved names, even through auth_env_vars. Have the host supply it for this run with declaredEnvNames, or list a different name in auth_env_vars.`
        : `Missing ${reference} referenced in ${path}`
    );
    this.name = 'InterpolationError';
    this.source = source;
    this.key = key;
    this.path = path;
  }
}

export function assertApiCredentialName(
  key: string | undefined,
  source: 'env' | 'secrets' = 'env',
  path = 'credential',
  trustedCredentialNames?: ReadonlySet<string>
): asserts key is string {
  if (!key) {
    throw new InterpolationError(source, key, path);
  }
  if (BLOCKED_ENV_KEYS.has(key) && !trustedCredentialNames?.has(key)) {
    throw new InterpolationError(source, key, path, 'reserved');
  }
}

function resolveInputValue(
  source: 'input' | 'mapped',
  key: string | undefined,
  values: Record<string, unknown> | undefined,
  path: string
): unknown {
  if (key === undefined) {
    return values ?? {};
  }

  if (!values || !Object.hasOwn(values, key)) {
    throw new InterpolationError(source, key, path);
  }

  return values[key];
}

function resolveNamedValue(
  source: 'secrets' | 'env',
  key: string | undefined,
  values: Record<string, string | undefined> | undefined,
  path: string,
  allowProcessEnvFallback: boolean,
  declaredEnvVars: ReadonlySet<string> | undefined,
  trustedCredentialNames: ReadonlySet<string> | undefined,
  declaredSecretNames: readonly string[] = []
): string {
  assertApiCredentialName(key, source, path, trustedCredentialNames);
  if (!declaredEnvVars?.has(key) && !(source === 'secrets' && declaredSecretNames.includes(key))) {
    throw new Error(`Undeclared environment variable: ${key}. Add ${key} to auth_env_vars.`);
  }

  const explicit = values && Object.hasOwn(values, key) ? values[key] : undefined;
  const value =
    source === 'secrets'
      ? explicit
      : (explicit ??
        (allowProcessEnvFallback && !BLOCKED_ENV_KEYS.has(key) ? process.env[key] : undefined));
  if (value === undefined) {
    throw new InterpolationError(source, key, path);
  }

  return value;
}

function resolveIntegrationValue(
  key: string | undefined,
  context: InterpolationContext,
  path: string
): string {
  if (key !== 'base_url' || !context.integration?.base_url) {
    throw new InterpolationError('integration', key, path);
  }

  return context.integration.base_url;
}

function resolveToken(
  source: InterpolationSource,
  key: string | undefined,
  context: InterpolationContext,
  path: string
): unknown {
  const value = resolveTokenValue(source, key, context, path);
  context.onReference?.({ source, ...(key === undefined ? {} : { key }), path });
  return value;
}

function resolveTokenValue(
  source: InterpolationSource,
  key: string | undefined,
  context: InterpolationContext,
  path: string
): unknown {
  switch (source) {
    case 'input':
      return resolveInputValue('input', key, context.input, path);
    case 'mapped':
      return resolveInputValue('mapped', key, context.mapped, path);
    case 'secrets':
      return resolveNamedValue(
        'secrets',
        key,
        context.secrets,
        path,
        false,
        context.declaredEnvVars,
        context.trustedCredentialNames,
        context.declaredSecretNames
      );
    case 'env':
      return resolveNamedValue(
        'env',
        key,
        context.env,
        path,
        context.allowProcessEnvFallback !== false,
        context.declaredEnvVars,
        context.trustedCredentialNames
      );
    case 'integration':
      return resolveIntegrationValue(key, context, path);
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unknown interpolation source: ${_exhaustive}`);
    }
  }
}

function stringifyInterpolatedValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function assertResolvedTemplateString(value: string, path: string): void {
  if (UNRESOLVED_TEMPLATE_RE.test(value)) {
    throw new Error(`Unresolved template in ${path}`);
  }
}

export function interpolateString(
  template: string,
  context: InterpolationContext,
  path = 'value'
): string {
  const resolved = template.replace(
    TEMPLATE_RE,
    (_match, source: InterpolationSource, key?: string) =>
      stringifyInterpolatedValue(resolveToken(source, key, context, path))
  );
  assertResolvedTemplateString(resolved, path);
  return resolved;
}

/**
 * Holds the references a value resolves until `commit`, so a value that ends up
 * not being sent (a skipped query parameter, an omitted or overridden optional
 * header) reports nothing. Without an observer it costs nothing.
 */
export function bufferReferences(context: InterpolationContext): {
  context: InterpolationContext;
  /** Report the held references, only those `keep` accepts when given. */
  commit: (keep?: (reference: ApiRequestInterpolationReference) => boolean) => void;
} {
  const observer = context.onReference;
  if (!observer) return { context, commit: () => undefined };
  const pending: ApiRequestInterpolationReference[] = [];
  return {
    context: { ...context, onReference: (reference) => pending.push(reference) },
    commit: (keep) => {
      for (const reference of pending) {
        if (!keep || keep(reference)) observer(reference);
      }
    },
  };
}

const URL_SCHEME_RE = /^https?:\/\//i;

type UrlComponent = 'origin' | 'path' | 'query' | 'fragment' | 'unclassified';

/** Characters that end an http(s) authority or are dropped while parsing one. */
const AUTHORITY_BREAKING_RE = /[/\\?#\s]/;

/** Where the authority, query and fragment of a resolved http(s) URL begin. */
function urlComponentBounds(url: string, schemeLength: number) {
  const fragmentStart = indexOrEnd(url.indexOf('#', schemeLength), url);
  const queryIndex = url.indexOf('?', schemeLength);
  const queryStart = queryIndex >= 0 && queryIndex < fragmentStart ? queryIndex : fragmentStart;
  const authority = /[/\\?#]/.exec(url.slice(schemeLength));
  const authorityEnd = authority ? schemeLength + authority.index : url.length;
  return { authorityEnd, fragmentStart, queryStart };
}

function indexOrEnd(index: number, value: string): number {
  return index < 0 ? value.length : index;
}

/** The decoded name of the query parameter at `position`, as `URLSearchParams` reads it. */
function queryParameterAt(
  url: string,
  position: number,
  bounds: ReturnType<typeof urlComponentBounds>
): string {
  const start = Math.max(url.lastIndexOf('&', position - 1), bounds.queryStart) + 1;
  const separator = /[&=]/.exec(url.slice(start, bounds.fragmentStart));
  const raw = url.slice(start, separator ? start + separator.index : bounds.fragmentStart);
  return new URLSearchParams(`${raw}=`).keys().next().value ?? raw;
}

function urlComponentOf(
  start: number,
  end: number,
  bounds: ReturnType<typeof urlComponentBounds>
): UrlComponent {
  const crosses = (boundary: number) => start < boundary && boundary < end;
  if (crosses(bounds.authorityEnd) || crosses(bounds.queryStart) || crosses(bounds.fragmentStart)) {
    return 'unclassified';
  }
  if (start >= bounds.fragmentStart) return 'fragment';
  if (start >= bounds.queryStart) return 'query';
  return start < bounds.authorityEnd ? 'origin' : 'path';
}

/**
 * Interpolate an absolute URL template and report each reference by where its
 * resolved value lands in the resolved URL: `<path>.origin` for the scheme and
 * authority, `<path>` for the pathname, `<path>.query` for the query string.
 * A reference written inside the template's authority always reports as origin,
 * because it chooses the destination, or as `<path>.unclassified` when its
 * value carries a character that ends or bends the authority.
 * References whose value lands in the fragment are not reported, because a
 * fragment is never sent, and a value that spans a component boundary (for
 * example an unencoded `?` in a webhook path) is reported as
 * `<path>.unclassified`. Values are rendered one reference at a time, which
 * yields exactly the text interpolating the whole template produces. A URL
 * whose scheme itself comes from a template is reported as origin throughout.
 */
export function interpolateUrl(
  template: string,
  context: InterpolationContext,
  path: string,
  render: (template: string, context: InterpolationContext, path: string) => string
): string {
  const scheme = URL_SCHEME_RE.exec(template);
  if (!scheme) return render(template, context, `${path}.origin`);
  const observer = context.onReference;
  const silent = bufferReferences(context).context;
  const templateAuthorityEnd = urlComponentBounds(template, scheme[0].length).authorityEnd;
  const pieces: string[] = [];
  const spans: {
    start: number;
    end: number;
    inAuthority: boolean;
    value: string;
    references: ApiRequestInterpolationReference[];
  }[] = [];
  let length = 0;
  let consumed = 0;
  for (const match of template.matchAll(TEMPLATE_RE)) {
    const literal = template.slice(consumed, match.index);
    const references: ApiRequestInterpolationReference[] = [];
    const value = render(
      match[0],
      observer ? { ...context, onReference: (reference) => references.push(reference) } : silent,
      path
    );
    pieces.push(literal, value);
    spans.push({
      start: length + literal.length,
      end: length + literal.length + value.length,
      inAuthority: match.index < templateAuthorityEnd,
      value,
      references,
    });
    length += literal.length + value.length;
    consumed = match.index + match[0].length;
  }
  pieces.push(template.slice(consumed));
  const resolved = pieces.join('');
  assertResolvedTemplateString(resolved, path);
  if (observer) {
    const bounds = urlComponentBounds(resolved, scheme[0].length);
    for (const span of spans) {
      const resolvedComponent = urlComponentOf(span.start, span.end, bounds);
      if (resolvedComponent === 'fragment') continue;
      const component = span.inAuthority
        ? AUTHORITY_BREAKING_RE.test(span.value)
          ? 'unclassified'
          : 'origin'
        : resolvedComponent;
      const reportedPath = component === 'path' ? path : `${path}.${component}`;
      const parameter =
        component === 'query' ? queryParameterAt(resolved, span.start, bounds) : undefined;
      for (const reference of span.references) {
        observer({
          ...reference,
          path: reportedPath,
          ...(parameter === undefined ? {} : { parameter }),
        });
      }
    }
  }
  return resolved;
}

/**
 * Rewrites every template reference with `render`, leaving the rest of the
 * text untouched. Uses the same grammar as interpolation and resolves nothing.
 */
export function mapTemplateReferences(
  template: string,
  render: (reference: { source: InterpolationSource; key?: string }) => string
): string {
  return template.replace(TEMPLATE_RE, (_match, source: InterpolationSource, key?: string) =>
    render({ source, ...(key === undefined ? {} : { key }) })
  );
}

export function interpolatePath(
  template: string,
  context: InterpolationContext,
  path = 'endpoint'
): string {
  const resolved = template.replace(
    TEMPLATE_RE,
    (_match, source: InterpolationSource, key?: string) =>
      encodePathSegment(stringifyInterpolatedValue(resolveToken(source, key, context, path)))
  );
  assertResolvedTemplateString(resolved, path);
  return resolved;
}

/**
 * Encode an interpolated value as one URI path segment. WHATWG URL parsing
 * normalizes literal `%2E` and `%2E%2E` segments, so dot-only values are
 * encoded one additional time to keep them data rather than path syntax.
 */
function encodePathSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (value === '.' || value === '..') {
    return encoded.replace(/\./g, '%25' + '2E');
  }
  return encoded;
}

export function interpolateValue(
  template: unknown,
  context: InterpolationContext,
  path = 'value',
  options: InterpolateValueOptions = {}
): unknown {
  const interpolate = (value: unknown, valuePath: string, allowOmit: boolean): unknown => {
    if (typeof value === 'string') {
      const wholeMatch = value.match(WHOLE_TEMPLATE_RE);
      if (wholeMatch) {
        let resolved: unknown;
        try {
          resolved = resolveToken(
            wholeMatch[1] as InterpolationSource,
            wholeMatch[2],
            context,
            valuePath
          );
        } catch (error) {
          if (
            allowOmit &&
            error instanceof InterpolationError &&
            error.source === 'input' &&
            error.key !== undefined &&
            options.omitMissingInputNames?.has(error.key)
          ) {
            return OMITTED_VALUE;
          }
          throw error;
        }
        if (typeof resolved === 'string') assertResolvedTemplateString(resolved, valuePath);
        return resolved;
      }

      return interpolateString(value, context, valuePath);
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => interpolate(item, `${valuePath}[${index}]`, false));
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) {
        const resolved = interpolate(child, `${valuePath}.${key}`, true);
        if (resolved !== OMITTED_VALUE) {
          result[key] = resolved;
        }
      }
      return result;
    }

    return value;
  };

  const resolved = interpolate(template, path, false);
  return resolved === OMITTED_VALUE ? undefined : resolved;
}
