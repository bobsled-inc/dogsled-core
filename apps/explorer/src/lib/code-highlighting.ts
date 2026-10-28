import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);

export type CodeLanguage = 'bash' | 'json' | 'plaintext' | 'sql' | 'yaml';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function highlightCode(code: string, language: CodeLanguage): string {
  if (!code) {
    return '';
  }

  if (language === 'plaintext') {
    return escapeHtml(code);
  }

  try {
    return hljs.highlight(code, {
      ignoreIllegals: true,
      language,
    }).value;
  } catch {
    return escapeHtml(code);
  }
}

export function inferCodeLanguage(fileName?: string | null): CodeLanguage {
  if (!fileName) return 'plaintext';
  const normalized = fileName.toLowerCase();

  if (normalized.endsWith('.sql')) return 'sql';
  if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) return 'yaml';
  if (normalized.endsWith('.json')) return 'json';
  if (normalized.endsWith('.sh') || normalized.endsWith('.bash') || normalized.endsWith('.zsh')) {
    return 'bash';
  }

  return 'plaintext';
}
