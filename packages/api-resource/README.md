# @bobsled-inc/api-resource

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Dependency-light request planning shared by Bobsled Core extraction and its
catalog-only API resource probe.

This private workspace validates scalar inputs, applies defaults, interpolates
resource templates, and constructs the first HTTP request. It deliberately
does not perform network access, retries, pagination, loading, or state
management. Static HTTP authentication is shared here with normal extraction;
the catalog probe performs OAuth/custom-token exchanges through the caller's
injected executor so the caller retains DNS, SSRF, redirect, timeout, abort,
and response-limit policy.

The package must remain safe to import without loading extractor, DuckDB, or
other native execution dependencies.
