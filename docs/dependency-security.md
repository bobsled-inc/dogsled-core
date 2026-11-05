# Installed dependency security

The npm release gate audits the packed package in two clean consumer projects:
all supported optional warehouse drivers at their published minimum versions,
and all at their latest versions allowed by the peer ranges and the three-week
release-age policy. It derives the driver inventory from the internal workspace
manifests. Both installs use npm's `--before` cutoff, disable lifecycle scripts,
and inherit no workspace overrides. The only exception is the exact-version
release-age exemptions below: npm cannot exempt a version from `--before`, so
the audit pins each exempted version to its registry tarball through consumer
`overrides` and checks the installed integrity against the registry. The gate verifies installed driver versions,
rejects independently resolved internal packages, and audits the resulting trees.
The staged AI manifest omits providers already inlined into its built output. Otherwise npm would install duplicate upstream providers with older transitive
provider-utils pins despite the fixed code bundled by Dogsled. Required external
runtime dependencies remain declared, and public imports are smoke-tested.

High and critical advisories fail unless every installed dependency path matches
an unexpired exception in `scripts/security/consumer-exceptions.json`. Exceptions
require an exact advisory, package version, dependency path, reviewed parent SDK versions,
owner, evidence,
review deadline and one of two statuses:

- `not_applicable`: Dogsled cannot reach the vulnerable code, for example because
  it never calls the affected function or never passes it untrusted input.
- `accepted_risk`: Dogsled can reach the vulnerable code. Maintainers have
  reviewed the impact and accept it until the review deadline, usually while a
  fixed version waits out the release-age policy.

An entry without a valid status fails the gate. The report lists each finding
with its advisory, actual installed path, owner, review deadline and disposition:
`not_applicable`, `accepted_risk` or `unhandled`. Only `unhandled` findings fail
the release, and an expired exception leaves its findings `unhandled`.
Registry errors, malformed reports and missing dependency evidence fail closed.
Consumer lockfiles and npm explanations remain local release evidence. The
release report includes audit dispositions and is printed in Actions logs,
uploaded as a seven-day Actions artifact, and attached to the GitHub release.

## Security-fix release-age exemptions

pnpm installs only versions published at least 21 days earlier
(`minimumReleaseAge: 30240` minutes), and the clean consumer audits use the same
cutoff. That default is never lowered. The only exception is a published
security fix for an advisory that affects Dogsled: the owner may exempt that
exact version (`name@version`, never a name or pattern) in
`minimumReleaseAgeExclude`. Before approval, check that the release comes from
the package's usual publisher, that its registry signature verifies (and its
provenance, where the package publishes one), that it has no install scripts,
and that its diff matches the release notes. Each entry is listed here and
removed once it meets the normal age. A structural test fails when an entry is
not an exact version, is missing from this table, or is still present after its
removal date.

Approved by the owner on 2026-10-28. `npm audit signatures` verified the registry
signature of every version below, and none has an install script.
follow-redirects@1.16.2 was separately approved and signature-verified on 2026-11-02; it has no install script.

| Package@version                                                                                                                                                                                                                   | Advisories fixed                                                                                    | Published                         | Remove after         | Evidence                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `undici@8.12.2`                                                                                                                                                                                                                   | GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-qrxm-fqhp-jwvm                  | 2026-10-15T15:05:34Z              | 2026-11-05T15:05:34Z | npm trusted publishing from `nodejs/undici` `release.yml` (SLSA provenance)                                                                                                                |
| `undici@7.30.1`                                                                                                                                                                                                                   | GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-qrxm-fqhp-jwvm                  | 2026-10-15T14:18:31Z              | 2026-11-05T14:18:31Z | npm trusted publishing from `nodejs/undici` `release.yml` on `v7.x` (SLSA provenance)                                                                                                      |
| `undici@6.29.1`                                                                                                                                                                                                                   | GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm                                       | 2026-10-15T14:19:28Z              | 2026-11-05T14:19:28Z | npm trusted publishing from `nodejs/undici` `release.yml` on `v6.x` (SLSA provenance)                                                                                                      |
| `body-parser@2.4.0`                                                                                                                                                                                                               | GHSA-27r3-jxmh-p828                                                                                 | 2026-10-22T11:39:38Z              | 2026-11-12T11:39:38Z | npm trusted publishing from `expressjs/body-parser` `npm-publish.yml` at `v2.4.0` (SLSA provenance)                                                                                        |
| `fast-uri@3.1.9`                                                                                                                                                                                                                  | GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr (moderate); GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp (low) | 2026-10-19T23:05:26Z              | 2026-11-09T23:05:26Z | npm trusted publishing from `fastify/fast-uri` `release.yml` on `v3.x` (SLSA provenance)                                                                                                   |
| `vitest@4.1.12`, `@vitest/coverage-v8@4.1.12`, `@vitest/expect@4.1.12`, `@vitest/mocker@4.1.12`, `@vitest/pretty-format@4.1.12`, `@vitest/runner@4.1.12`, `@vitest/snapshot@4.1.12`, `@vitest/spy@4.1.12`, `@vitest/utils@4.1.12` | GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp (moderate, `@vitest/mocker`)                               | 2026-10-15T14:39:54Z to 14:51:24Z | 2026-11-05T14:51:24Z | npm trusted publishing from `vitest-dev/vitest` `publish.yml` on `v4` (SLSA provenance)                                                                                                    |
| `follow-redirects@1.16.2`                                                                                                                                                                                                         | GHSA-mrwp-f3q8-3g9p                                                                                 | 2026-10-25T21:32:25Z              | 2026-11-15T21:32:25Z | Same maintainers (rubenverborgh, olalonde) as earlier releases; npm registry signature verified (SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U); the package has never had provenance |

## Driver security minimums

| Driver                   | Minimum  | Reason                                                                                                                                    |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mysql2`                 | 3.22.0   | GHSA-3f6p-5ww8-9rcr authentication downgrade fix                                                                                          |
| `snowflake-sdk`          | 3.4.0    | Driver credential/logging fixes and TOML 5 minimum                                                                                        |
| `pg`                     | 8.4.0    | Removes pinned vulnerable semver 4.3.2 (GHSA-c2qf-rxjj-qqgw)                                                                              |
| `@databricks/sql`        | 2.0.0    | Uses thrift ^0.23.0, fixing GHSA-r67j-r569-jrwp and GHSA-526f-jxpj-jmg2                                                                   |
| `@google-cloud/bigquery` | 8.1.1    | Reviewed auth chain avoids old gtoken/google-p12-pem/node-forge (GHSA-86w9-cpqp-85rv)                                                     |
| `@aws-sdk/client-s3`     | 3.1017.0 | Reviewed Node driver avoids the old retry dependency's React Native tooling peer chain, including vulnerable braces (GHSA-vfj7-8cjw-p6xm) |

Install these versions or newer supported versions.
Dogsled checks installed versions before loading these SDKs in its default
adapters, queries and connectivity checks. A missing, unverifiable, prerelease
or older driver fails before connection creation. Injected test adapters remain
credential-free. Databricks 1.x is no longer supported. Install 2.x before using
that integration. Native addons still require their usual platform installation.

Snowflake 3.4.0 became age-eligible on 2026-10-21T11:25:23.294Z and requires
`toml ^5.0.0`. This floor fixes the older TOML advisories
GHSA-82x6-q7mm-w9cf and GHSA-v5mp-jgw5-2x6j. TOML 5.0.1 fixes three newer
high advisories. A workspace override and the exemption above pin it, and both
clean consumer trees resolve it within Snowflake's range.

Axios 1.20.0 accepts `follow-redirects ^1.16.0`. Version 1.16.1 became
age-eligible on 2026-10-22T13:52:31.780Z and fixed GHSA-q3jh-wrc6-jgq8 and
GHSA-8r9p-f939-6h3c. Version 1.16.2 fixes GHSA-mrwp-f3q8-3g9p (published
2026-10-25T21:32:25Z; age-eligible 2026-11-15T21:32:25Z). A workspace override
and the exemption above pin it to 1.16.2, and the lockfile resolves 1.16.2 everywhere.

MCP SDK 1.32.0 became age-eligible on 2026-10-23T17:32:51.427Z.
The workspace catalog and lockfile now pin this version, which also supplies the
staged Dogsled runtime dependency. All MCP workspace and consumer exceptions
have been removed.

The exempted versions above replace every undici, Zod, TOML, DOMPurify, Next and
body-parser exception. The catalog pins undici 8.12.2 for Dogsled's own HTTP
clients and Zod 4.6.6 for every package and the npm bundle. The `undici@7`,
`undici@6`, `toml`, `dompurify` and `body-parser` overrides cover the
Turbopuffer, AI SDK, Snowflake, Mermaid and MCP SDK copies, and the clean
consumer trees resolve the same versions.

The published Dogsled manifest leaves optional drivers optional and does not
promote the internal peer declarations. npm can otherwise reject installing
Dogsled in a project that pins an old driver for unrelated work. The bundled
internal manifests declare only other bundled packages: npm treats any other
dependency or peer they declare as part of the bundle when it is installed under
Dogsled, as in a global install, and leaves its folder empty. The top-level
manifest declares every external runtime dependency instead. Missing drivers
are not forced into the project. The runtime checks above reject unsupported
versions when that warehouse is actually used.

## Reviewed exceptions

Owner for each entry: security/release maintainers. Re-review when a driver changes
its dependency tree or integration behavior, even if the deadline has not arrived.
These exceptions describe Dogsled's adapters, not arbitrary direct SDK usage.

- Databricks SQL > proxy-agent > pac-proxy-agent > get-uri > basic-ftp 5.3.1:
  GHSA-c475-qrg2-pj4r affects `Client.list()` parsing of FTP directory listings.
  Databricks `dist/connection/connections/HttpConnection.js#getAgent` uses plain
  HTTP/HTTPS agents unless `options.proxy` is supplied. The loader destination, loader check command and connections runner
  construct connection options with host, path and token only. Regression tests
  assert those exact options and the absence of `proxy`. The PAC/FTP path cannot
  receive input through these adapters. Review by 2026-11-20.
- Snowflake and Tedious > Azure Identity > MSAL Node 5.1.1 (workspace) and
  6.0.1 (consumers): GHSA-xcx6-jx8p-x3h5 affects the authorization-code flow.
  Snowflake workload identity uses `DefaultAzureCredential`, whose chain never
  calls `acquireTokenByCode`. Its broker and VS Code credentials need an Azure
  Identity plugin, and Dogsled registers none. Dogsled constructs no
  authorization-code or interactive credential. Tedious loads Azure Identity, but
  Dogsled's SQL Server destination hard-codes `authentication.type: 'default'`
  (SQL login), so Tedious never constructs an Azure credential. MSAL Node 7.1.0
  fixes it, but Azure Identity 4.14.0 (latest) and 4.15.0-beta.1 still require
  `^6`, so no exemption can help yet: consumer trees need a new Azure Identity
  release before these exceptions can go. They expire on 2026-11-05 for re-review.

The `tedious > sprintf-js` advisory is moderate. Tedious uses literal format
strings, so remote values cannot set precision specifiers. It requires no
exception at the high threshold. No generic package-name or severity exception
is used. New dependency paths and expired exceptions block the release.
