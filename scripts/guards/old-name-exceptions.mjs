export function validateOldNameExceptions(value, patternIds) {
  const invalid = () => {
    throw new Error(
      'Invalid old-name exceptions; use exact files, known patterns, nonempty matches and review reasons.'
    );
  };
  if (!value || value.version !== 1 || !Array.isArray(value.exceptions)) invalid();
  const seen = new Set();
  return value.exceptions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    if (Object.keys(entry).sort().join(',') !== 'path,pattern,patternId,reason') invalid();
    if (
      typeof entry.path !== 'string' ||
      !entry.path ||
      entry.path.startsWith('/') ||
      entry.path.endsWith('/') ||
      /[\\*?\[\]{}]/.test(entry.path) ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      invalid();
    if (
      !patternIds.includes(entry.patternId) ||
      typeof entry.pattern !== 'string' ||
      !entry.pattern ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim()
    )
      invalid();
    let regex;
    try {
      regex = new RegExp(entry.pattern, 'g');
    } catch {
      invalid();
    }
    if (regex.test('')) invalid();
    const key = JSON.stringify([entry.path, entry.patternId, entry.pattern]);
    if (seen.has(key)) invalid();
    seen.add(key);
    return { ...entry };
  });
}

export function filterOldNameFindings(relativePath, lines, findings, exceptions) {
  const applicable = exceptions.filter((entry) => entry.path === relativePath);
  if (applicable.length === 0) return findings;
  const ranges = new Map();
  for (const entry of applicable) {
    const byLine = ranges.get(entry.patternId) ?? new Map();
    for (let index = 0; index < lines.length; index++) {
      const allowed = byLine.get(index + 1) ?? [];
      const regex = new RegExp(entry.pattern, 'g');
      for (const match of lines[index].matchAll(regex)) {
        if (match[0].length > 0) allowed.push([match.index, match.index + match[0].length]);
      }
      if (allowed.length > 0) byLine.set(index + 1, allowed);
    }
    ranges.set(entry.patternId, byLine);
  }
  return new Map(
    [...findings].map(([id, rows]) => [
      id,
      rows.filter((row) => {
        const column = row.column - 1;
        return !(ranges.get(id)?.get(row.line) ?? []).some(
          ([start, end]) => column >= start && column < end
        );
      }),
    ])
  );
}
