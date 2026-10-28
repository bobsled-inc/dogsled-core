# Paid enrichment APIs

Some library integrations call APIs that charge per request or per match, such as
email finders and people-data providers. Dogsled will not call them through a plain
`extract run`. You first write a plan that lists the input rows and a budget,
estimate its cost, and then run the plan.

| Integration      | Resource           | Billing     | Unit            |
| ---------------- | ------------------ | ----------- | --------------- |
| `hunter`         | `email_finder`     | per request | provider credit |
| `datagma`        | `find_people`      | upper bound | provider credit |
| `findymail`      | `email_finder`     | per match   | provider credit |
| `leadmagic`      | `email_finder`     | per match   | provider credit |
| `exa`            | `search`           | upper bound | USD             |
| `peopledatalabs` | `person_enrich`    | per match   | provider credit |
| `apollo`         | `search_companies` | per request | provider credit |

## Write a plan

The input rows come from a seed file: CSV, JSON Lines or YAML.

Create `seeds/prospects.csv`:

```csv
first_name,last_name,company_domain
Ada,Lovelace,example.com
Grace,Hopper,example.org
```

Plans live in `extract-intents.yml` at the project root. Each step calls one
resource once per seed row and maps seed columns to the resource's inputs.

Create `extract-intents.yml`:

```yaml
spec_version: '1'
type: extract-intents
plans:
  enrich_outbound:
    description: Find work emails for outbound prospects
    budget:
      max_estimated_credits: 300
      on_exceed: fail
    seeds:
      prospects:
        format: csv
        path: ./seeds/prospects.csv
    steps:
      - id: hunter_email_finder
        integration: hunter
        resource: email_finder
        seed: prospects
        input:
          first_name: ${{ seed.first_name }}
          last_name: ${{ seed.last_name }}
          domain: ${{ seed.company_domain }}
        limits:
          max_input_rows: 300
```

Inputs can also be literal values. `limits.max_input_rows` caps the rows a step
uses, and the budget applies to all steps of a plan together. With
`on_exceed: fail` a plan over budget does not run; `warn` logs and continues.

## Estimate, then run

Estimating makes no API calls:

```bash
dogsled extract estimate --plan enrich_outbound
```

```text
Estimate for enrich_outbound: 2 credit(s), 2 request(s), confidence=exact
hunter_email_finder: 2 credit(s), 2 request(s), confidence=exact
```

`confidence` is `exact` for per-request billing, `upper_bound` when you pay only for
matches, and `unknown` when the cost cannot be known in advance. `--format json`
prints the estimate as JSON.

Run the plan with the provider's key set, and load the results like any extraction:

```bash
export HUNTER_API_KEY=<key>
dogsled extract run --plan enrich_outbound | dogsled load run --dest duckdb --db-path enrich.duckdb
```

Calling a paid resource without a plan fails with exit code 2:

```bash
dogsled extract run --integration hunter email_finder || echo "exit code $?"
```

```text
Billable resources require an explicit extract plan: hunter/email_finder.
exit code 2
```

`dogsled extract scaffold-test` skips paid resources unless you pass
`--allow-billable-test`.
