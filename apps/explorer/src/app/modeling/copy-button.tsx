'use client';

import { useEffect, useRef, useState } from 'react';

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={async () => {
        if (!navigator.clipboard?.writeText) return;
        try {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          await navigator.clipboard.writeText(code);
          setCopied(true);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access denied or unavailable
        }
      }}
      className="absolute top-2 right-2 rounded px-2 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-secondary hover:text-foreground"
      aria-label="Copy code"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
