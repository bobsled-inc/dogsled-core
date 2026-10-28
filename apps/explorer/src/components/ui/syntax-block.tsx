'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { highlightCode, type CodeLanguage } from '@/lib/code-highlighting';

export function SyntaxBlock({
  className = '',
  code,
  language = 'plaintext',
}: {
  className?: string;
  code: string;
  language?: CodeLanguage;
}) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [code]);

  return (
    <div className="group relative">
      <pre
        className={`overflow-auto rounded-2xl border border-border bg-card p-4 font-mono text-[11px] leading-5 whitespace-pre-wrap ${className}`.trim()}
      >
        <code dangerouslySetInnerHTML={{ __html: highlighted || ' ' }} />
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
        className="absolute right-3 top-3 rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}
