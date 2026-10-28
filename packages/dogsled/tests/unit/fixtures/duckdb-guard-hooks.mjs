/**
 * ESM loader hooks used by the schema import-safety test.
 *
 * Any *eager* resolution of `@duckdb/node-api` (a static `import ... from
 * '@duckdb/node-api'` reached while loading a module graph) is redirected to a
 * synthetic module whose body throws. Dynamic `import('@duckdb/node-api')`
 * call sites are not redirected at graph-load time — they only resolve when
 * actually invoked — so the guard fires exclusively on eager loads.
 */

const GUARD_URL = 'duckdb-guard:eager-native-binding';

function isDuckDbSpecifier(specifier) {
  return specifier === '@duckdb/node-api' || specifier.startsWith('@duckdb/node-api/');
}

export async function resolve(specifier, context, next) {
  if (isDuckDbSpecifier(specifier)) {
    return { url: GUARD_URL, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === GUARD_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source:
        'throw new Error("EAGER_DUCKDB_LOAD: @duckdb/node-api was imported eagerly by the module graph");',
    };
  }
  return next(url, context);
}
