import { ExtractorConfigError } from '../errors.js';

/** Match a provider-relative key against a resource glob (`*`, `**`, `?`). */
export function globToRegExp(pattern: string, provider: string): RegExp {
  if (pattern.length > 240) {
    throw new ExtractorConfigError(`${provider} path glob exceeds 240 characters`);
  }
  const wildcardRuns = pattern.match(/[*?]{4,}/g);
  if (wildcardRuns) {
    throw new ExtractorConfigError(`${provider} path glob contains too many consecutive wildcards`);
  }
  const wildcardCount = [...pattern].filter((char) => char === '*' || char === '?').length;
  if (wildcardCount > 40) {
    throw new ExtractorConfigError(`${provider} path glob contains too many wildcards`);
  }
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*' && pattern[i + 2] === '/') {
      // `**/` also matches zero folders, so `**/*.csv` includes top-level files.
      out += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && next === '*') {
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
