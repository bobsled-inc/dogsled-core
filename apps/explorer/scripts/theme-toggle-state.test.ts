import assert from 'node:assert/strict';
import test from 'node:test';
import { getThemeToggleState } from '../src/lib/theme-toggle-state';

test('returns a neutral, disabled state before the client mounts', () => {
  const state = getThemeToggleState({ mounted: false, resolvedTheme: undefined });

  assert.deepEqual(state, {
    ariaLabel: 'Toggle theme',
    currentTheme: 'dark',
    label: 'Theme',
    nextTheme: null,
  });
});

test('offers light mode when the current theme resolves to dark', () => {
  const state = getThemeToggleState({ mounted: true, resolvedTheme: 'dark' });

  assert.equal(state.currentTheme, 'dark');
  assert.equal(state.nextTheme, 'light');
  assert.equal(state.label, 'Light mode');
  assert.equal(state.ariaLabel, 'Switch to light mode');
});

test('defaults to dark when mounted but resolvedTheme is undefined', () => {
  const state = getThemeToggleState({ mounted: true, resolvedTheme: undefined });

  assert.equal(state.currentTheme, 'dark');
  assert.equal(state.nextTheme, 'light');
  assert.equal(state.label, 'Light mode');
  assert.equal(state.ariaLabel, 'Switch to light mode');
});

test('offers dark mode when the current theme resolves to light', () => {
  const state = getThemeToggleState({ mounted: true, resolvedTheme: 'light' });

  assert.equal(state.currentTheme, 'light');
  assert.equal(state.nextTheme, 'dark');
  assert.equal(state.label, 'Dark mode');
  assert.equal(state.ariaLabel, 'Switch to dark mode');
});
