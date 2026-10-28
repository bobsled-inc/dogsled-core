'use client';

import { useMemo, useRef } from 'react';
import type { KeyboardEventHandler, TextareaHTMLAttributes } from 'react';
import { highlightCode, type CodeLanguage } from '@/lib/code-highlighting';

interface CodeEditorProps {
  className?: string;
  language?: CodeLanguage;
  onChange: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'className' | 'onChange' | 'onKeyDown' | 'rows' | 'value'
  >;
  value: string;
}

export function CodeEditor({
  className = '',
  language = 'plaintext',
  onChange,
  onKeyDown,
  placeholder,
  rows = 6,
  textareaProps,
  value,
}: CodeEditorProps) {
  const mirrorRef = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => highlightCode(value || ' ', language), [language, value]);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-border bg-card ${className}`.trim()}
    >
      {!value && placeholder && (
        <div className="pointer-events-none absolute inset-x-3 top-2 z-10 font-mono text-xs text-muted-foreground/70">
          {placeholder}
        </div>
      )}
      <pre
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
      >
        <code dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }} />
      </pre>
      <textarea
        {...textareaProps}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        rows={rows}
        spellCheck={false}
        className="relative z-10 block w-full resize-y bg-transparent px-3 py-2 font-mono text-xs leading-5 text-transparent caret-foreground focus:outline-none focus:ring-1 focus:ring-primary [text-shadow:0_0_0_var(--color-foreground)]"
        onScroll={(event) => {
          if (mirrorRef.current) {
            mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
            mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
      />
    </div>
  );
}
