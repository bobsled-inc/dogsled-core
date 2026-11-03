# Model Spec — Expression DSL Reference

The Expression DSL defines column transformations, filters, and join conditions in Model Spec YAML specs. Expressions are parsed into an AST and transpiled to dialect-specific SQL (Snowflake, BigQuery, Postgres, Databricks).

## Operator Precedence (lowest to highest)

| Level | Operators                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| 1     | `OR`                                                                                                        |
| 2     | `AND`                                                                                                       |
| 3     | `NOT` (prefix)                                                                                              |
| 4     | `=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`, `IS NULL`, `IS NOT NULL`, `IN`, `NOT IN`, `BETWEEN`, `LIKE`, `ILIKE` |
| 5     | `+`, `-`, `\|\|` (string concat)                                                                            |
| 6     | `*`, `/`, `%`                                                                                               |
| 7     | `-` (unary minus)                                                                                           |
| 8     | Literals, column refs, function calls, `CASE`, `CAST`, parens, `raw_sql()`                                  |

## Literal Types

| Type    | Syntax                       | Examples              |
| ------- | ---------------------------- | --------------------- |
| Number  | Digits with optional decimal | `42`, `3.14`, `100.0` |
| String  | Single-quoted                | `'hello'`, `'day'`    |
| Boolean | Keywords                     | `TRUE`, `FALSE`       |
| Null    | Keyword                      | `NULL`                |
| Star    | Wildcard                     | `*`, `table.*`        |

## Column References

```yaml
# Simple column
expr: ORDER_ID

# Qualified (table.column) — use in joins
expr: stg_orders.ORDER_ID

# Qualified with connection prefix
expr: ecom.raw_products.NAME

# Table wildcard
expr: stg_orders.*
```

## Comparison and Logical Operators

```yaml
# Equality
expr: "STATUS = 'active'"

# Inequality
expr: "STATUS != 'deleted'"

# Range
expr: "AMOUNT > 100"
expr: "AMOUNT BETWEEN 10 AND 1000"
expr: "AMOUNT NOT BETWEEN 10 AND 1000"

# Set membership
expr: "STATUS IN ('active', 'pending', 'shipped')"
expr: "STATUS NOT IN ('deleted', 'archived')"

# Null checks
expr: "EMAIL IS NOT NULL"
expr: "PHONE IS NULL"

# Pattern matching
expr: "NAME LIKE '%smith%'"
expr: "NAME ILIKE '%SMITH%'"

# Logical combination
expr: "STATUS = 'active' AND AMOUNT > 0"
expr: "STATUS = 'deleted' OR STATUS = 'archived'"
expr: "NOT (STATUS = 'deleted')"
```

## CASE Expressions

```yaml
# Searched CASE
expr: >-
  CASE
    WHEN AMOUNT > 1000 THEN 'high'
    WHEN AMOUNT > 100 THEN 'medium'
    ELSE 'low'
  END

# Simple CASE
expr: >-
  CASE STATUS
    WHEN 'active' THEN 1
    WHEN 'inactive' THEN 0
    ELSE -1
  END
```

## CAST Expressions

```yaml
expr: "CAST(PRICE / 100.0 AS NUMERIC(16, 2))"
expr: "CAST(CREATED_AT AS DATE)"
expr: "CAST(ID AS VARCHAR)"
```

## raw_sql() Escape Hatch

Use `raw_sql()` when the Expression DSL cannot represent a construct. Content passes through verbatim — no parsing, no transpilation, and no per-dialect capability checks. **Use sparingly**: you lose cross-dialect portability, and the column's lineage entry drops to `isComplete: false`, so it no longer traces back to its upstream columns.

```yaml
# A dialect-specific operator
expr: "raw_sql(payload ->> 'id')"

# A non-standard-case identifier
expr: 'raw_sql("MixedCase")'
```

**When to use raw_sql().** Each of these was checked against the parser:

- Dialect-specific operators, such as Postgres `->>` or `@>`
- Array literals like `ARRAY['a','b']`
- The aggregate `FILTER (WHERE ...)` clause
- `WITHIN GROUP (ORDER BY ...)`
- Lambda expressions such as `x -> x + 1`
- Non-standard-case identifiers (see [Reserved words / non-standard identifiers](#reserved-words--non-standard-identifiers))
- Nested struct field access more than one level deep, such as `payload.user.id`
- `TRY_CAST`

**When NOT to use raw_sql():**

- Window functions, in full: `OVER`, `PARTITION BY`, `ORDER BY`, `ROWS`/`RANGE`/`GROUPS` frames, `INTERVAL` frame offsets, `NULLS FIRST`/`NULLS LAST`, `EXCLUDE`, and named windows. See [Window Functions](#window-functions)
- Functions with no catalog entry — an unrecognised function passes through as a function call with its arguments mapped, so `ST_GEOHASH(geom, 8)` needs nothing special
- `INTERVAL` literals, which are spelled per target from a structured node
- `::` cast shorthand, array indexing, `COUNT(DISTINCT x)`, and aggregates nested inside a window
- Subqueries and `EXISTS`, which parse. Their bodies stay opaque, so the column's lineage entry drops to `isComplete: false`, but `raw_sql()` costs the same and gives up dialect mapping too
- `QUALIFY` — a query-level clause, not a column expression; use the model-level `qualify:` field
- Basic CASE/CAST (use the DSL syntax)
- Standard operators (the DSL handles these)
- LATERAL FLATTEN, UNNEST, EXPLODE, JSON_TABLE (use `flatten_json` instead — these are FROM-clause constructs, not column expressions)

## flatten_json — Expand JSON Arrays into Rows

The `flatten_json` model-level field expands a JSON array column into multiple rows. It generates dialect-appropriate LATERAL/UNNEST/EXPLODE syntax in the FROM clause, and flatten output can now be referenced directly with colon-path expressions like `flattened.VALUE:workspace:id::STRING`. **Do not use `raw_sql()` for LATERAL FLATTEN, UNNEST, EXPLODE, or JSON_TABLE in column expressions** — these are FROM-clause constructs that belong in `flatten_json`.

### Basic flatten

```yaml
flatten_json:
  column: PAYLOAD
columns:
  - name: item_value
    expr: 'FLATTENED.VALUE::STRING'
```

### Flatten with path

```yaml
flatten_json:
  column: JSON
  path: infrastructure.databricks
  alias: f
columns:
  - name: platform
    expr: 'F.VALUE:databricks_cloud_platform::STRING'
```

### Chained flattens (array syntax)

Pass an array to chain multiple flattens. The second references the first's alias via `input`:

```yaml
flatten_json:
  - column: JSON
    path: infrastructure.databricks
    alias: f
  - input: 'f.VALUE:regional'
    alias: r
columns:
  - name: workspace_id
    expr: 'R.VALUE:workspace:id::STRING'
```

### Flatten fields

| Field    | Required | Description                                          |
| -------- | -------- | ---------------------------------------------------- |
| `column` | Yes\*    | Source column containing the JSON array              |
| `input`  | No\*     | Arbitrary expression for chaining (takes precedence) |
| `path`   | No       | Dot-separated path into the JSON (e.g. `data.items`) |
| `alias`  | No       | Alias for the flatten output (default: `flattened`)  |

\* Either `column` or `input` must be present.

### Dialect-specific output

| Dialect    | Generated SQL                                                            |
| ---------- | ------------------------------------------------------------------------ |
| Snowflake  | `, LATERAL FLATTEN(INPUT => T0.COL, PATH => 'items') AS FLATTENED`       |
| BigQuery   | `, UNNEST(JSON_EXTRACT_ARRAY(T0.col, '$.items')) AS flattened`           |
| Postgres   | `, json_array_elements(t0.col -> 'items') AS flattened`                  |
| Databricks | `, LATERAL VIEW EXPLODE(T0.col) AS flattened`                            |
| MySQL      | `, JSON_TABLE(T0.col, '$[*]' COLUMNS(value JSON PATH '$')) AS flattened` |
| DuckDB     | `, UNNEST(t0.col) AS flattened`                                          |

### Referencing flatten output

Prefer the DSL's native colon-path syntax in column `expr` fields:

```yaml
expr: 'FLATTENED.VALUE:workspace:id::STRING'
expr: 'F.VALUE:emails[0]:address::STRING'
expr: 'MEM.VALUE:id::NUMBER'
```

The compiler rewrites these to the correct dialect-specific JSON accessors automatically.

## Function Catalog

Functions are transpiled across dialects automatically. Unknown functions pass through verbatim.

### Aggregate Functions

| Function                      | Args | Notes                                             |
| ----------------------------- | ---- | ------------------------------------------------- |
| `count(expr)`                 | 0-1  | `count(*)` supported                              |
| `count_distinct(expr)`        | 1    | Emits `COUNT(DISTINCT expr)`                      |
| `sum(expr)`                   | 1    |                                                   |
| `avg(expr)`                   | 1    |                                                   |
| `min(expr)`                   | 1    |                                                   |
| `max(expr)`                   | 1    |                                                   |
| `listagg(expr, sep)`          | 1-2  | BQ/PG/DB: `STRING_AGG`                            |
| `approx_count_distinct(expr)` | 1    |                                                   |
| `array_agg(expr)`             | 1    |                                                   |
| `bool_and(expr)`              | 1    | SF: `BOOLAND_AGG`, BQ: `LOGICAL_AND`              |
| `bool_or(expr)`               | 1    | SF: `BOOLOR_AGG`, BQ: `LOGICAL_OR`                |
| `median(expr)`                | 1    | BQ: `PERCENTILE_CONT(..., 0.5)`                   |
| `percentile_cont(pct, expr)`  | 2    | Dialect-specific syntax                           |
| `percentile_disc(pct, expr)`  | 2    | Dialect-specific syntax                           |
| `stddev(expr)`                | 1    |                                                   |
| `variance(expr)`              | 1    |                                                   |
| `any_value(expr)`             | 1    |                                                   |
| `corr(y, x)`                  | 2    |                                                   |
| `covar_pop(y, x)`             | 2    |                                                   |
| `covar_samp(y, x)`            | 2    |                                                   |
| `mode(expr)`                  | 1    | BQ: `APPROX_TOP_COUNT`, PG: `MODE() WITHIN GROUP` |
| `bit_and(expr)`               | 1    | SF: `BITAND_AGG`                                  |
| `bit_or(expr)`                | 1    | SF: `BITOR_AGG`                                   |

### Date/Time Functions

| Function                             | Args | Notes                                                                 |
| ------------------------------------ | ---- | --------------------------------------------------------------------- |
| `date_trunc('unit', expr)`           | 2    | BQ reverses args, unquotes unit                                       |
| `datediff('unit', start, end)`       | 3    | BQ: `DATE_DIFF(end, start, UNIT)`                                     |
| `dateadd('unit', amount, date)`      | 3    | BQ: `DATE_ADD(date, INTERVAL amount UNIT)`                            |
| `date_part('unit', expr)`            | 2    | BQ/PG/DB: `EXTRACT(unit FROM expr)`                                   |
| `year(expr)`                         | 1    | BQ/PG: `EXTRACT(YEAR FROM expr)`                                      |
| `month(expr)`                        | 1    | BQ/PG: `EXTRACT(MONTH FROM expr)`                                     |
| `day(expr)`                          | 1    | BQ/PG: `EXTRACT(DAY FROM expr)`                                       |
| `hour(expr)`                         | 1    | BQ/PG: `EXTRACT(HOUR FROM expr)`                                      |
| `quarter(expr)`                      | 1    | BQ/PG: `EXTRACT(QUARTER FROM expr)`                                   |
| `dayofweek(expr)`                    | 1    | BQ: `EXTRACT(DAYOFWEEK)`, PG: `EXTRACT(DOW)`                          |
| `dayofyear(expr)`                    | 1    | BQ: `EXTRACT(DAYOFYEAR)`, PG: `EXTRACT(DOY)`                          |
| `weekofyear(expr)`                   | 1    | BQ: `EXTRACT(ISOWEEK)`, PG: `EXTRACT(WEEK)`                           |
| `current_date()`                     | 0    |                                                                       |
| `current_timestamp()`                | 0    | PG: `NOW()`                                                           |
| `to_date(expr, fmt?)`                | 1-2  | BQ: `PARSE_DATE` (reversed args)                                      |
| `to_timestamp(expr, fmt?)`           | 1-2  | BQ: `PARSE_TIMESTAMP` (reversed args)                                 |
| `last_day(expr)`                     | 1-2  | PG: emulated with interval math                                       |
| `date_from_parts(y, m, d)`           | 3    | BQ: `DATE()`, PG/DB: `MAKE_DATE()`                                    |
| `add_months(date, n)`                | 2    | BQ: `DATE_ADD(...INTERVAL n MONTH)`                                   |
| `months_between(d1, d2)`             | 2    | BQ: `DATE_DIFF(...MONTH)`                                             |
| `convert_timezone(src, tgt, ts)`     | 3    | BQ: `DATETIME()`, PG: `AT TIME ZONE`                                  |
| `timestamp_from_parts(y,m,d,h,mi,s)` | 6    | BQ: `DATETIME()`, PG/DB: `MAKE_TIMESTAMP()`                           |
| `next_day(date, dow)`                | 2    |                                                                       |
| `format_date(format, date)`          | 2    | SF: `TO_VARCHAR`, BQ: `FORMAT_DATE`, PG: `TO_CHAR`, DB: `DATE_FORMAT` |
| `timestamp_seconds(epoch)`           | 1    | SF/PG: `TO_TIMESTAMP`, BQ: `TIMESTAMP_SECONDS`, DB: `FROM_UNIXTIME`   |

### String Functions

| Function                               | Args | Notes                                                                     |
| -------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `concat(a, b, ...)`                    | 1+   |                                                                           |
| `upper(s)`                             | 1    |                                                                           |
| `lower(s)`                             | 1    |                                                                           |
| `trim(s)`                              | 1    |                                                                           |
| `ltrim(s, chars?)`                     | 1-2  |                                                                           |
| `rtrim(s, chars?)`                     | 1-2  |                                                                           |
| `length(s)`                            | 1    |                                                                           |
| `left(s, n)`                           | 2    |                                                                           |
| `right(s, n)`                          | 2    |                                                                           |
| `substring(s, start, len?)`            | 2-3  | SF/BQ: `SUBSTR`                                                           |
| `replace(s, old, new?)`                | 2-3  |                                                                           |
| `repeat(s, n)`                         | 2    |                                                                           |
| `reverse(s)`                           | 1    |                                                                           |
| `lpad(s, n, pad?)`                     | 2-3  |                                                                           |
| `rpad(s, n, pad?)`                     | 2-3  |                                                                           |
| `initcap(s)`                           | 1    |                                                                           |
| `regexp_replace(s, pat, rep?, flags?)` | 2-4  |                                                                           |
| `split_part(s, delim, idx)`            | 3    | BQ: `SPLIT(s, d)[OFFSET(idx-1)]`                                          |
| `regexp_substr(s, pat)`                | 2-3  | BQ/DB: `REGEXP_EXTRACT`, PG: `REGEXP_MATCHES`                             |
| `regexp_like(s, pat)`                  | 2-3  | BQ: `REGEXP_CONTAINS`, PG: `~` operator                                   |
| `regexp_count(s, pat)`                 | 2-3  | BQ: `REGEXP_EXTRACT_ALL` + `ARRAY_LENGTH`, DB: `SIZE(REGEXP_EXTRACT_ALL)` |
| `contains(s, sub)`                     | 2    | BQ: `CONTAINS_SUBSTR`, PG: `POSITION`                                     |
| `startswith(s, prefix)`                | 2    | BQ: `STARTS_WITH`, PG: `LIKE prefix \|\| '%'`                             |
| `endswith(s, suffix)`                  | 2    | BQ: `ENDS_WITH`, PG: `LIKE '%' \|\| suffix`                               |
| `split(s, delim)`                      | 2    | PG: `STRING_TO_ARRAY`                                                     |
| `translate(s, from, to)`               | 3    |                                                                           |
| `editdistance(a, b)`                   | 2    | BQ: `EDIT_DISTANCE`, PG/DB: `LEVENSHTEIN`                                 |
| `position(needle, haystack)`           | 2    | SF: `CHARINDEX`, BQ: `STRPOS`, PG: `POSITION`, DB: `LOCATE`               |
| `soundex(s)`                           | 1    |                                                                           |
| `base64_encode(s)`                     | 1    | BQ: `TO_BASE64`, DB: `BASE64`                                             |
| `base64_decode(s)`                     | 1    | SF: `BASE64_DECODE_STRING`, BQ: `FROM_BASE64`, DB: `UNBASE64`             |
| `ascii(s)`                             | 1    | BQ: `TO_CODE_POINTS`                                                      |
| `chr(n)`                               | 1    | BQ: `CODE_POINTS_TO_STRING`                                               |

### Numeric Functions

| Function                     | Args | Notes                                                               |
| ---------------------------- | ---- | ------------------------------------------------------------------- |
| `abs(x)`                     | 1    |                                                                     |
| `ceil(x)`                    | 1    |                                                                     |
| `floor(x)`                   | 1    |                                                                     |
| `round(x, scale?)`           | 1-2  |                                                                     |
| `trunc(x, scale?)`           | 1-2  |                                                                     |
| `mod(x, y)`                  | 2    |                                                                     |
| `sqrt(x)`                    | 1    |                                                                     |
| `ln(x)`                      | 1    |                                                                     |
| `exp(x)`                     | 1    |                                                                     |
| `power(x, y)`                | 2    | BQ: `POW`                                                           |
| `log(base, x)`               | 1-2  | BQ reverses args                                                    |
| `greatest(a, b, ...)`        | 2+   |                                                                     |
| `least(a, b, ...)`           | 2+   |                                                                     |
| `div0(x, y)`                 | 2    | Returns 0 on divide-by-zero                                         |
| `div0null(x, y)`             | 2    | Returns NULL on divide-by-zero. BQ: `SAFE_DIVIDE`, DB: `TRY_DIVIDE` |
| `sign(x)`                    | 1    | DB: `SIGNUM`                                                        |
| `random()`                   | 0    | BQ/DB: `RAND()`                                                     |
| `width_bucket(x, lo, hi, n)` | 4    |                                                                     |
| `cbrt(x)`                    | 1    | BQ: `POW(x, 1.0/3)`                                                 |
| `pi()`                       | 0    | BQ: `ACOS(-1)`                                                      |

### Conditional Functions

| Function                              | Args | Notes                                    |
| ------------------------------------- | ---- | ---------------------------------------- |
| `coalesce(a, b, ...)`                 | 1+   |                                          |
| `nullif(a, b)`                        | 2    |                                          |
| `ifnull(a, b)`                        | 2    | PG/DB: `COALESCE`                        |
| `nvl(a, b)`                           | 2    | BQ: `IFNULL`, PG: `COALESCE`             |
| `iff(cond, then, else)`               | 3    | BQ/DB: `IF`, PG: `CASE WHEN...END`       |
| `zeroifnull(x)`                       | 1    | Emits `COALESCE(x, 0)` or `IFNULL(x, 0)` |
| `try_cast(expr, type)`                | 2    | BQ: `SAFE_CAST`                          |
| `decode(expr, s1, r1, ..., default?)` | 3+   | BQ/PG/DB: emits `CASE WHEN...END`        |

### Conversion Functions

| Function              | Args | Notes                                        |
| --------------------- | ---- | -------------------------------------------- |
| `to_varchar(x, fmt?)` | 1-2  | BQ: `FORMAT`/`CAST AS STRING`, PG: `TO_CHAR` |
| `to_boolean(x)`       | 1    | Emits `CAST(x AS BOOLEAN)`                   |
| `to_number(x, fmt?)`  | 1-2  | BQ: `CAST AS NUMERIC`, DB: `CAST AS DECIMAL` |
| `typeof(x)`           | 1    | PG: `PG_TYPEOF`                              |

### JSON Functions

| Function                                | Args | Notes                                                                                      |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `json_value(obj, path)`                 | 2    | SF: `:` accessor, BQ: `JSON_VALUE`, PG: `->>`                                              |
| `parse_json(s)`                         | 1    | PG: `::jsonb`, DB: `FROM_JSON`                                                             |
| `json_extract_path_text(obj, paths...)` | 2+   |                                                                                            |
| `object_construct(k1, v1, ...)`         | 0+   | BQ: `JSON_OBJECT`, PG: `JSONB_BUILD_OBJECT`                                                |
| `object_keys(obj)`                      | 1    | PG: `JSONB_OBJECT_KEYS`, DB: `JSON_OBJECT_KEYS`                                            |
| `array_construct(a, b, ...)`            | 0+   | BQ: `[...]`, PG: `ARRAY[...]`, DB: `ARRAY(...)`                                            |
| `array_size(arr)`                       | 1    | BQ: `ARRAY_LENGTH`, PG: `CARDINALITY`, DB: `SIZE`                                          |
| `json_value_array(obj, path)`           | 2    | SF: `:` accessor, BQ: `JSON_VALUE_ARRAY`, PG: `JSONB_ARRAY_ELEMENTS_TEXT`, DB: `FROM_JSON` |
| `array_contains(val, arr)`              | 2    | BQ: `IN UNNEST`, PG: `= ANY`, DB: reversed args                                            |

#### JSON paths — pass RELATIVE paths only

`json_value` / `json_query` / `json_extract_path_text` all **auto-root from `$`**.
The path argument is a dotted, relative path — `'workspace.id'`, not `'$.workspace.id'`.

```yaml
# Right — relative path
expr: "json_value(DATA, 'workspace.id')"

# Wrong — absolute JSONPath rejected at compile time with errorCode JSON_PATH_DOUBLE_ROOT
expr: "json_value(DATA, '$.workspace.id')"
```

Why it matters: Model Spec prepends the `$` root for dialects that need it (BigQuery JSON_VALUE,
MySQL JSON_EXTRACT). Passing `'$.foo'` used to silently produce `'$.$.foo'` on BigQuery
and `:"$":foo` on Snowflake — both compile to invalid paths. The compiler now rejects
leading `$` / `$.` / `$[` at parse time with `[JSON_PATH_DOUBLE_ROOT]`.

For the colon-syntax form (`DATA:workspace:id`) the `$` issue doesn't arise — colons are
parsed as path separators.

#### Reserved words / non-standard identifiers

Reserved-word column names (`SELECT`, `ORDER`, `GROUP`, etc.) are **auto-quoted** per dialect
when emitted — you don't need to wrap them or pick a different name in the YAML.

```yaml
# Compiles correctly on every dialect — auto-quoted at emit
- name: ORDER
  expr: ORDER
```

Case-folding still applies: BigQuery / Postgres / DuckDB / Databricks / MySQL lowercase
unquoted identifiers; Snowflake uppercases them. When a source uses non-standard case
(e.g. `MixedCase`) and the column lookup fails as `unknown column`, escape with raw_sql:

```yaml
# Snowflake/Postgres/DuckDB/Redshift
expr: 'raw_sql("MixedCase")'

# BigQuery/Databricks/MySQL
expr: 'raw_sql(`MixedCase`)'
```

Note: backticks in the **Model Spec expression DSL itself** are rejected with `[BACKTICK_IDENT]` —
the DSL has no backtick-quoting syntax. Use `raw_sql()` as the escape hatch.

### Hash Functions

| Function          | Args | Notes                                          |
| ----------------- | ---- | ---------------------------------------------- |
| `md5(s)`          | 1    |                                                |
| `sha2(s, bits?)`  | 1-2  | BQ: `SHA256`/`SHA512`, PG: `DIGEST` + `ENCODE` |
| `sha1(s)`         | 1    | PG: `DIGEST` + `ENCODE`                        |
| `hash(a, b, ...)` | 1+   | BQ: `FARM_FINGERPRINT`, PG: `HASHTEXT`         |

### Window Functions

| Function                        | Args | Notes                                    |
| ------------------------------- | ---- | ---------------------------------------- |
| `row_number()`                  | 0    |                                          |
| `rank()`                        | 0    |                                          |
| `dense_rank()`                  | 0    |                                          |
| `ntile(n)`                      | 1    |                                          |
| `lag(expr, offset?, default?)`  | 1-3  |                                          |
| `lead(expr, offset?, default?)` | 1-3  |                                          |
| `first_value(expr)`             | 1    | Accepts `IGNORE NULLS` / `RESPECT NULLS` |
| `last_value(expr)`              | 1    | Accepts `IGNORE NULLS` / `RESPECT NULLS` |
| `nth_value(expr, n)`            | 2    |                                          |
| `cume_dist()`                   | 0    |                                          |
| `percent_rank()`                | 0    |                                          |
| `ratio_to_report(expr)`         | 1    | Emulated where there is no native form   |

Any aggregate can also be used as a window function.

The `OVER` clause is part of the DSL — **do not wrap window expressions in `raw_sql()`**. Doing so loses cross-dialect mapping and blanks the column's lineage.

```yaml
# Ranking, partitioned and ordered
expr: 'ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY ORDER_DATE DESC)'

# Running total with a frame
expr: 'SUM(AMOUNT) OVER (PARTITION BY CUSTOMER_ID ORDER BY ORDER_DATE ROWS UNBOUNDED PRECEDING)'

# Sliding frame
expr: 'AVG(AMOUNT) OVER (ORDER BY ORDER_DATE ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)'

# Share of partition — a window inside ordinary arithmetic
expr: 'AMOUNT / SUM(AMOUNT) OVER (PARTITION BY CUSTOMER_ID)'

# Offset with null handling
expr: 'LAST_VALUE(STATUS) IGNORE NULLS OVER (PARTITION BY USER_ID ORDER BY CHANGED_AT)'
```

#### Null placement

Default null ordering differs per dialect, so state it whenever the answer depends on where nulls land — `dedupe` and `qualify` pick a row by this ordering.

```yaml
expr: 'RANK() OVER (PARTITION BY REGION ORDER BY REVENUE DESC NULLS LAST)'
```

`nulls` is also available wherever a model declares ordering — model-level `order_by`, `windows[].order_by`, and `dedupe.order_by`:

```yaml
dedupe:
  keys: [ORDER_ID]
  strategy: keep_first
  order_by:
    - column: UPDATED_AT
      direction: desc
      nulls: last
```

#### Frames

`ROWS`, `RANGE`, and `GROUPS` frame units are supported, with `BETWEEN` or the shorthand single-bound form, plus the `EXCLUDE` clause (`CURRENT ROW`, `GROUP`, `TIES`, `NO OTHERS`).

```yaml
expr: 'SUM(AMOUNT) OVER (ORDER BY ORDER_DATE GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)'
```

A `RANGE` frame can be bounded by an interval rather than a row count, which is
how a trailing time window is written:

```yaml
expr: "SUM(AMOUNT) OVER (ORDER BY ORDER_DATE RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW)"
```

`INTERVAL <n> <unit>` is a DSL literal, usable anywhere an expression is, not
only in a frame. Both `INTERVAL 7 DAY` and `INTERVAL '7' DAY` are accepted, a
negative amount is allowed, the plural spelling is normalised, and units are
`YEAR`, `MONTH`, `WEEK`, `DAY`, `HOUR`, `MINUTE` and `SECOND`. Postgres, Redshift
and Snowflake want the amount and unit inside one string literal and the other
targets want them bare; the compiler emits whichever the target expects.

The amount must be a whole number, because BigQuery, MySQL, DuckDB and Databricks
reject a fractional one; use a smaller unit, `12 HOUR` rather than `0.5 DAY`. A
unit outside the portable set, `QUARTER` for example, is not recognised and the
expression falls back to `raw_sql` like any other unparsed text, so it is passed
through unmapped. Compile with `--strict` to turn that fallback into an error.

#### Named windows

Declare a window once at model level and reference it by name. Targets without a `WINDOW` clause get the definition inlined at each use site, including references nested inside `CASE`, a cast, or a function argument.

```yaml
windows:
  - name: by_customer
    partition_by: [CUSTOMER_ID]
    order_by:
      - column: ORDER_DATE
        direction: asc
        nulls: last
    frame: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
columns:
  - name: running_total
    expr: SUM(AMOUNT) OVER by_customer
```

#### Per-dialect support

Constructs no target supports are rejected at compile time with an `[unsupported_feature:<capability>]` error rather than emitted as SQL the warehouse would reject at run time.

| Construct                      | Snowflake | BigQuery | Databricks | Redshift | Postgres | DuckDB | MySQL     |
| ------------------------------ | --------- | -------- | ---------- | -------- | -------- | ------ | --------- |
| `OVER`, frames, `ROWS`/`RANGE` | yes       | yes      | yes        | yes      | yes      | yes    | yes       |
| `NULLS FIRST` / `NULLS LAST`   | yes       | yes      | yes        | yes      | yes      | yes    | rewritten |
| `GROUPS` frame                 | no        | no       | no         | no       | yes      | yes    | no        |
| Frame `EXCLUDE`                | no        | no       | no         | no       | yes      | yes    | no        |
| `WINDOW` clause                | inlined   | yes      | yes        | inlined  | yes      | yes    | yes       |
| `QUALIFY` / `dedupe`           | yes       | yes      | yes        | yes      | emulated | yes    | emulated  |

MySQL has no `NULLS FIRST`/`NULLS LAST` syntax, so the compiler emits a leading `(<expr> IS NULL)` sort key instead. That extra key changes which rows count as peers, so it is refused inside a `RANGE` or `GROUPS` frame, where peer membership decides the frame contents.

Postgres and MySQL have no `QUALIFY` clause, so the predicate's window
expressions are hoisted into the SELECT list and filtered from a wrapping
subquery. That makes `qualify` and the `dedupe` operator work on both, where
they previously failed to compile. One restriction comes with it: the rewrite
adds a helper column, and neither target has a `SELECT * EXCEPT` to remove it
again, so `include_all_columns` together with `qualify` or `dedupe` is refused
there. List the columns explicitly.

The `GROUPS` and `EXCLUDE` rows are set conservatively from vendor documentation and have not yet been proven against every live warehouse through the integration harness. A target marked `no` that turns out to support the construct is a flag to flip, not a compiler change.

### Geo Functions

| Function                            | Args | Notes                                  |
| ----------------------------------- | ---- | -------------------------------------- |
| `st_distance(a, b)`                 | 2    |                                        |
| `st_point(lon, lat)`                | 2    | BQ: `ST_GEOGPOINT`, PG: `ST_MakePoint` |
| `haversine(lat1, lon1, lat2, lon2)` | 4    | BQ/PG: uses native geo distance        |

### Cleaning Functions

These functions compile to dialect-correct SQL across all six warehouses. Use them in `expr:` fields for staging model clean-ups, or copy them directly from `model_expr` fields in profiler cleaning suggestions.

| Function                      | Effect                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `collapse_whitespace(col)`    | Collapse runs of whitespace into one space.                                                                     |
| `nullif_empty(col)`           | Trim and convert empty strings to `NULL`.                                                                       |
| `normalize_email(col)`        | Lowercase and trim email values.                                                                                |
| `extract_email_domain(col)`   | Extract the domain from an email address.                                                                       |
| `strip_email_subaddress(col)` | Remove plus-addressing before `@`.                                                                              |
| `strip_accents(col)`          | Remove common accents/diacritics.                                                                               |
| `strip_legal_suffixes(col)`   | Remove terminal Inc., LLC, Ltd., Corp., Co., etc.                                                               |
| `strip_trading_as(col)`       | Remove d/b/a, dba, trading as, and t/a aliases.                                                                 |
| `normalize_company(col)`      | Trim, strip legal suffix, lowercase, and collapse whitespace.                                                   |
| `strip_www(col)`              | Remove `http://`, `https://`, and `www.` prefixes.                                                              |
| `extract_domain(col)`         | Extract host/domain from a full URL.                                                                            |
| `digits_only(col)`            | Keep only `0–9` digits.                                                                                         |
| `strip_country_code(col)`     | Remove leading US/Canada `1` from 11-digit phone strings.                                                       |
| `strip_phone_extension(col)`  | Remove phone extension suffixes.                                                                                |
| `normalize_phone(col)`        | Apply `digits_only` and `strip_country_code`.                                                                   |
| `normalize_state(col)`        | Normalize US state names/codes to two-letter codes.                                                             |
| `remove_punctuation(col)`     | Remove punctuation, leaving letters, digits, and spaces.                                                        |
| `fingerprint(col)`            | Build an OpenRefine-style sorted/deduped token key.                                                             |
| `parse_number(col)`           | Parse formatted numeric strings such as `$1,234.56`.                                                            |
| `parse_date(col, 'format')`   | Parse dates/timestamps; supports `iso8601`, `timestamp`, `date`, `unix_seconds`, `unix_millis`, `us`, and `eu`. |

`parse_date` format literals:

| Format literal   | Emitted SQL                                                                     |
| ---------------- | ------------------------------------------------------------------------------- |
| `'iso8601'`      | `TRY_CAST(col AS TIMESTAMP)` (dialect-appropriate safe-cast variant)            |
| `'timestamp'`    | Same as `iso8601`                                                               |
| `'date'`         | `TRY_CAST(col AS DATE)`                                                         |
| `'unix_seconds'` | `to_timestamp(col)` / `TIMESTAMP_SECONDS` / `FROM_UNIXTIME` per dialect         |
| `'unix_millis'`  | `to_timestamp(col / 1000.0)` / `TIMESTAMP_MILLIS` / `FROM_UNIXTIME` per dialect |

> **BigQuery note**: Model Spec registers its own `parse_date` function, which overrides BigQuery's native `PARSE_DATE(format_string, date_string)`. If you need BigQuery's native function, use `raw_sql()`.

**Example — staging model with cleaning expressions:**

```yaml
spec_version: '0.2'
name: stg_companies
type: model
description: Clean and normalize raw company records
grain: company_id
source:
  ref: crm.raw_companies
materialization:
  type: view
columns:
  - name: company_id
    expr: ID
    primary_key: true
  - name: company_name_clean
    expr: 'collapse_whitespace(lower(strip_legal_suffixes(company_name)))'
  - name: domain_clean
    expr: 'lower(strip_www(website))'
  - name: phone_clean
    expr: 'strip_country_code(digits_only(phone))'
  - name: created_date
    expr: "parse_date(created_at, 'iso8601')"
```

The Expression DSL uses **Snowflake-style** syntax as the canonical form. Key differences:

| Pattern      | Snowflake (canonical)         | BigQuery                                    | Postgres                    |
| ------------ | ----------------------------- | ------------------------------------------- | --------------------------- |
| `date_trunc` | `DATE_TRUNC('day', col)`      | `DATE_TRUNC(col, DAY)` — reversed, unquoted | Same as SF                  |
| `datediff`   | `DATEDIFF('day', start, end)` | `DATE_DIFF(end, start, DAY)` — reversed     | `(end::date - start::date)` |
| `dateadd`    | `DATEADD('day', 3, col)`      | `DATE_ADD(col, INTERVAL 3 DAY)`             | `col + INTERVAL '3 day'`    |
| `to_date`    | `TO_DATE(col, fmt)`           | `PARSE_DATE(fmt, col)` — reversed           | Same as SF                  |
| Identifiers  | `"COL"` double-quoted         | `` `col` `` backtick-quoted                 | `"col"` double-quoted       |

## Common Expression Patterns

### Correct

```yaml
# Simple column rename
expr: ID

# Function call
expr: LOWER(EMAIL)

# Arithmetic with cast
expr: "CAST(PRICE / 100.0 AS NUMERIC(16, 2))"

# Date truncation
expr: "date_trunc('month', ORDER_DATE)"

# Conditional
expr: "CASE WHEN AMOUNT > 0 THEN 'credit' ELSE 'debit' END"

# Null handling
expr: "coalesce(PHONE, 'N/A')"

# String concatenation
expr: "FIRST_NAME || ' ' || LAST_NAME"

# Qualified column in join
expr: stg_orders.CUSTOMER_ID

# Date difference
expr: "datediff('day', CREATED_AT, CURRENT_DATE)"

# Safe division
expr: "div0(REVENUE, COST)"
```

### Incorrect

```yaml
# Semicolons not allowed
expr: "SELECT 1; DROP TABLE users"
# ^ Rejected by validation

# DDL keywords at start
expr: "DROP TABLE users"
# ^ Rejected by validation

# Missing quotes around string literal
expr: CASE WHEN STATUS = active THEN 1 END
# ^ 'active' needs quotes: STATUS = 'active'

# Wrong date_trunc arg order for canonical form
expr: "date_trunc(ORDER_DATE, 'month')"
# ^ Canonical (Snowflake) form: date_trunc('month', ORDER_DATE)
# The transpiler expects unit first, then expression

# Using double quotes for strings
expr: "STATUS = \"active\""
# ^ Use single quotes: STATUS = 'active'
```

## Expression Validation Rules

1. **No semicolons** — expressions cannot contain `;`
2. **No DDL keywords at start** — `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `INSERT`, `UPDATE`, `DELETE`, `GRANT`, `REVOKE` are rejected when they appear at the start
3. **Identifiers** — must match `/^[a-zA-Z_]\w*$/`
4. **Auto-fallback** — if the DSL parser fails, the expression falls back to `raw_sql` (pass-through). This means invalid DSL syntax won't crash compilation, but you lose transpilation.
5. **Functions not in catalog** — pass through verbatim (forward-compatible with new SQL functions)
