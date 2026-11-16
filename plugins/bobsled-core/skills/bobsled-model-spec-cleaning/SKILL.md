---
name: bobsled-model-spec-cleaning
description: Author Model Spec cleaning expressions and entity-graph
  standardization transforms for dirty source data.
---

# Model Spec Cleaning

Use this skill when authoring staging models, applying profiler cleaning suggestions, or configuring entity-graph `standardize` transforms.

## Function Catalog

| Function                           | Use                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `nullif_empty(col)`                | Convert blank strings to `NULL`.                                                        |
| `normalize_email(col)`             | Trim and lowercase emails.                                                              |
| `normalize_email_uid2(col)`        | UID2-compatible email normalization for Gmail/googlemail dot and plus-tag handling.     |
| `extract_email_domain(col)`        | Derive account/domain keys from emails.                                                 |
| `strip_email_subaddress(col)`      | Remove `+tag` email subaddressing.                                                      |
| `strip_accents(col)`               | Remove accents before matching.                                                         |
| `normalize_company(col)`           | Clean company names with suffix/case/whitespace handling.                               |
| `strip_trading_as(col)`            | Remove d/b/a or trading-as aliases before company normalization.                        |
| `extract_domain(col)`              | Convert full URLs to comparable domains.                                                |
| `normalize_phone(col)`             | Keep phone digits and remove leading US/Canada country code.                            |
| `strip_phone_extension(col)`       | Remove phone extensions before phone normalization.                                     |
| `normalize_state(col)`             | Normalize US states to two-letter codes.                                                |
| `expand_street_abbreviations(col)` | Canonicalize USPS street suffixes, unit designators, and directionals.                  |
| `normalize_street(col)`            | Lowercase, strip punctuation, collapse whitespace, and canonicalize USPS street tokens. |
| `normalize_postal(col)`            | Normalize postal codes; US ZIP+4 reduces to ZIP5.                                       |
| `fingerprint(col)`                 | Build sorted/deduped entity-resolution blocking keys.                                   |
| `sha256(col)`                      | Terminal SHA-256 digest for non-keyed hashed values.                                    |
| `hmac_sha256(col)`                 | Terminal keyed match digest using `BOBSLED_CORE_MATCH_KEY_SECRET`.                      |
| `parse_number(col)`                | Parse formatted currency/number strings.                                                |
| `parse_date(col, format)`          | Parse strings to dates/timestamps (`us`, `eu`, `iso8601`, etc.).                        |

## Canonical Chains

- Company: `normalize_company(company_name)` or `normalize_company(strip_trading_as(company_name))`.
- Email: `normalize_email(email)` and `extract_email_domain(normalize_email(email))`.
- Privacy match key: `hmac_sha256(normalize_email_uid2(email))` for cross-party email joins when both parties use Bobsled Core's portable keyed construction.
- Phone: `normalize_phone(strip_phone_extension(phone))` when extensions appear.
- URL/domain: `extract_domain(lower(website_url))` for full URLs; `lower(strip_www(domain))` for bare domains.
- State: `normalize_state(state)`.
- Address: `normalize_street(street_address)` with `normalize_postal(postal_code)` for blocking/matching.
- Dirty strings: `nullif_empty(collapse_whitespace(trim(value)))`.
- Matching keys: `fingerprint(company_name)` for blocking or fuzzy candidate generation.

## Profiler Workflow

Run `bobsled model profile suggest cleaning <table> --integration <handle> --json`, then copy `model_expr` into staging model column `expr` fields. Treat suggestions as starting points: verify grain, null handling, and business-specific exceptions.

## Transform Ordering

Model Spec expressions run inside-out. Prefer: trim/null handling → type-specific cleanup → case normalization → whitespace collapse. Convenience wrappers already encode this ordering for company, email, phone, domain, and state use cases. Hashing transforms are terminal: apply `sha256` or `hmac_sha256` last, and do not feed hashed outputs into fuzzy comparators or display fields.

`hmac_sha256` intentionally emits the same portable nested keyed SHA-256 construction on every warehouse, not RFC-2104 HMAC. Set `BOBSLED_CORE_MATCH_KEY_SECRET` in the runtime environment before compiling or running specs that use it. The generated digest only interoperates with parties using the same Bobsled Core transform and secret.

## Entity Graph Standardize

Resolution specs use the same transform names in `standardize.transforms`. Example:

```yaml
standardize:
  - field: company_name
    transforms: [strip_trading_as, normalize_company]
  - field: email
    transforms: [strip_email_subaddress, normalize_email]
  - field: email
    transforms: [normalize_email_uid2, hmac_sha256]
  - field: phone
    transforms: [strip_phone_extension, normalize_phone]
  - field: state
    transforms: [normalize_state]
  - field: street
    transforms: [normalize_street]
  - field: postal_code
    transforms: [normalize_postal]
  - field: email_key
    transforms: []
    pre_hashed: true
```

Host agents should load this skill whenever they author entity-resolution
standardizers. Pair it with `entity-resolution`: this skill defines legal
transform names and safe ordering, while `entity-resolution` explains how those
standardized fields feed blocking, scoring, incremental runs, and live
`match`/`serve` access-plane behavior.

## Model Example

```yaml
spec_version: '0.2'
name: stg_customers
source:
  ref: crm.customers
columns:
  - name: customer_id
    expr: customer_id
  - name: email
    expr: normalize_email(email_raw)
  - name: email_domain
    expr: extract_email_domain(normalize_email(email_raw))
  - name: company_name
    expr: normalize_company(strip_trading_as(account_name))
  - name: phone
    expr: normalize_phone(strip_phone_extension(phone_raw))
  - name: state
    expr: normalize_state(billing_state)
  - name: street
    expr: normalize_street(billing_street)
  - name: postal_code
    expr: normalize_postal(billing_postal_code)
  - name: website_domain
    expr: extract_domain(lower(website_url))
  - name: amount
    expr: parse_number(amount_text)
  - name: close_date
    expr: parse_date(close_date_text, 'us')
```
