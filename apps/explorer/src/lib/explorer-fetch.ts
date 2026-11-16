export function explorerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method.toUpperCase() !== 'GET' && typeof document !== 'undefined') {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin === window.location.origin) {
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="bobsled-explorer-token"]'
      )?.content;
      if (token) headers.set('x-bobsled-explorer-token', token);
    }
  }
  return fetch(input, { ...init, headers });
}
