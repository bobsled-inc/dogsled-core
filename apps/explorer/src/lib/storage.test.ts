import { afterEach, describe, expect, it } from 'vitest';

import { loadStoredJson } from './storage';

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
    return;
  }

  Reflect.deleteProperty(globalThis as typeof globalThis & { window?: Window }, 'window');
});

describe('loadStoredJson', () => {
  it('preserves falsy values that were stored successfully', () => {
    const localStorage = new LocalStorageMock();
    localStorage.setItem('boolean-value', JSON.stringify(false));
    localStorage.setItem('number-value', JSON.stringify(0));
    localStorage.setItem('string-value', JSON.stringify(''));

    globalThis.window = { localStorage } as unknown as Window & typeof globalThis;

    expect(loadStoredJson('boolean-value', true)).toBe(false);
    expect(loadStoredJson('number-value', 42)).toBe(0);
    expect(loadStoredJson('string-value', 'fallback')).toBe('');
  });
});
