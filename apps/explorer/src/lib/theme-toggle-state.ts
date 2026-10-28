export type ExplorerTheme = 'dark' | 'light';

interface ThemeToggleStateArgs {
  mounted: boolean;
  resolvedTheme: string | undefined;
}

interface ThemeToggleState {
  ariaLabel: string;
  currentTheme: ExplorerTheme;
  label: string;
  nextTheme: ExplorerTheme | null;
}

export function getThemeToggleState({
  mounted,
  resolvedTheme,
}: ThemeToggleStateArgs): ThemeToggleState {
  if (!mounted) {
    return {
      ariaLabel: 'Toggle theme',
      currentTheme: 'dark',
      label: 'Theme',
      nextTheme: null,
    };
  }

  const currentTheme: ExplorerTheme = resolvedTheme === 'light' ? 'light' : 'dark';
  const nextTheme: ExplorerTheme = currentTheme === 'dark' ? 'light' : 'dark';

  return {
    ariaLabel: `Switch to ${nextTheme} mode`,
    currentTheme,
    label: nextTheme === 'light' ? 'Light mode' : 'Dark mode',
    nextTheme,
  };
}
