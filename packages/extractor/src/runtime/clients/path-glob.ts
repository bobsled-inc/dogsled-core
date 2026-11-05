import { ExtractorConfigError } from '../errors.js';

export function hasGlobWildcard(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * Compile a provider path glob. `*` and `?` match within one path segment,
 * `**` matches across segments, and every other character is literal.
 */
export function globToRegExp(pattern: string, label: string): RegExp {
  if (pattern.length > 240) {
    throw new ExtractorConfigError(`${label} path glob exceeds 240 characters`);
  }
  const wildcardRuns = pattern.match(/[*?]{4,}/g);
  if (wildcardRuns) {
    throw new ExtractorConfigError(`${label} path glob contains too many consecutive wildcards`);
  }
  const wildcardCount = [...pattern].filter((char) => char === '*' || char === '?').length;
  if (wildcardCount > 40) {
    throw new ExtractorConfigError(`${label} path glob contains too many wildcards`);
  }
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char ? char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') : '';
    }
  }
  out += '$';
  return new RegExp(out);
}
