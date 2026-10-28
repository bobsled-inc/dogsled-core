export interface MentionSurfaceFilters {
  stopwords?: readonly string[];
  exclude_regex?: readonly string[];
  min_chars?: number;
  max_words?: number;
}

export type SurfaceDropReason =
  | 'empty'
  | 'min_chars'
  | 'max_words'
  | 'stopword'
  | 'exclude_regex'
  | 'markdown_heading'
  | 'category_label'
  | 'code_or_path';

export interface SurfaceFilterContext {
  chunkText?: string;
  spanStart?: number;
  spanEnd?: number;
}

export type SurfaceFilterResult =
  | { ok: true; normalized: string }
  | { ok: false; normalized: string; reason: SurfaceDropReason; filter?: string };

const SURROUNDING_PUNCTUATION = /^[\s>"'`*_~()[\]{}.,:;!?|/\\-]+|[\s<"'`*_~()[\]{}.,:;!?|/\\-]+$/g;

export function normalizeMentionSurface(surface: string): string {
  return surface
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(SURROUNDING_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForComparison(surface: string): string {
  return normalizeMentionSurface(surface).normalize('NFKC').toLowerCase();
}

function isMarkdownHeading(context: SurfaceFilterContext): boolean {
  if (
    context.chunkText === undefined ||
    context.spanStart === undefined ||
    context.spanStart < 0 ||
    context.spanStart > context.chunkText.length
  ) {
    return false;
  }
  const lineStart = context.chunkText.lastIndexOf('\n', context.spanStart - 1) + 1;
  const prefix = context.chunkText.slice(lineStart, context.spanStart);
  return /^\s{0,3}#{1,6}\s*$/.test(prefix);
}

function isCategoryLabel(surface: string, normalized: string): boolean {
  if (surface.trim().endsWith(':')) return true;
  return /^(?:user|users|group|groups|service|services|resource|resources|section|category)$/i.test(
    normalized
  );
}

function isCodeOrPathLike(surface: string, normalized: string): boolean {
  if (surface.includes('`')) return true;
  if (/[\\/]/.test(normalized)) return true;
  return /^(?:[a-z]:\\|\.{0,2}\/|~\/)/i.test(surface.trim());
}

export function evaluateMentionSurface(
  surface: string,
  filters: MentionSurfaceFilters | undefined,
  context: SurfaceFilterContext = {}
): SurfaceFilterResult {
  const normalized = normalizeMentionSurface(surface);
  if (normalized.length === 0) return { ok: false, normalized, reason: 'empty' };
  if (isMarkdownHeading(context)) return { ok: false, normalized, reason: 'markdown_heading' };
  if (isCategoryLabel(surface, normalized)) {
    return { ok: false, normalized, reason: 'category_label' };
  }
  if (isCodeOrPathLike(surface, normalized)) {
    return { ok: false, normalized, reason: 'code_or_path' };
  }

  if (filters?.min_chars !== undefined && normalized.length < filters.min_chars) {
    return { ok: false, normalized, reason: 'min_chars' };
  }
  if (filters?.max_words !== undefined) {
    const words = normalized.split(/\s+/).filter((word) => word.length > 0);
    if (words.length > filters.max_words) return { ok: false, normalized, reason: 'max_words' };
  }

  const comparable = normalizeForComparison(normalized);
  const stopwords = new Set((filters?.stopwords ?? []).map((word) => normalizeForComparison(word)));
  if (stopwords.has(comparable)) return { ok: false, normalized, reason: 'stopword' };

  for (const pattern of filters?.exclude_regex ?? []) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'iu');
    } catch {
      continue;
    }
    if (regex.test(surface) || regex.test(normalized)) {
      return { ok: false, normalized, reason: 'exclude_regex', filter: pattern };
    }
  }

  return { ok: true, normalized };
}
