'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { getThemeToggleState } from '@/lib/theme-toggle-state';

function SunIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v1.5m0 15V21m9-9h-1.5m-15 0H3m15.364 6.364l-1.06-1.06M6.697 6.697l-1.06-1.06m12.727 0l-1.06 1.06M6.697 17.303l-1.06 1.06M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.752 15.002A9.718 9.718 0 0112 21a9 9 0 01-9-9 9.718 9.718 0 015.998-9.752 7.5 7.5 0 1012.754 12.754z"
      />
    </svg>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const themeState = getThemeToggleState({ mounted, resolvedTheme });

  return (
    <button
      type="button"
      aria-pressed={themeState.currentTheme === 'light'}
      onClick={() => {
        if (themeState.nextTheme) {
          setTheme(themeState.nextTheme);
        }
      }}
      disabled={!themeState.nextTheme}
      aria-label={themeState.ariaLabel}
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      <span className="flex items-center gap-2">
        {themeState.currentTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
        <span>{themeState.label}</span>
      </span>
      <span
        aria-hidden="true"
        className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70"
      >
        {themeState.currentTheme}
      </span>
    </button>
  );
}
