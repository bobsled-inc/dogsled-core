# Customer ontologies

An ontology describes business concepts and how they relate. A semantic model
names the data fields, joins, and metrics used to answer questions. A mapping
connects the two. These customer definitions are separate from Dogsled's own
system model and from the existing relationship extraction configuration.

## Author a definition

Put a YAML file in any indexed project folder. The `type` identifies the file;
no special folder is required. Names are case-sensitive.

```yaml
spec_version: '0.2'
type: ontology
name: sales
ontology:
  - concept: OrderNumber
    type: ValueType
    extends: [String]
  - concept: Order
    type: EntityType
    identify_by: [number]
    relationships:
      - name: number
        roles: [{ concept: OrderNumber }]
        multiplicity: OneToOne
        verbalizes: ['{Order} has number {OrderNumber}']
```

The native envelope adds `spec_version` and `type` to the pinned Ossie ontology
shape. All standard ontology fields remain available: descriptions, AI context,
prefixes, concepts, inheritance, identifying relationships, constraints,
derivations, verbalizations, and IRIs. Ontology root extensions are not accepted.
The bundled schema is the complete field reference.

A mapping uses `type: ontology_mapping`. It names an ontology and a semantic scope:

```yaml
spec_version: '0.2'
type: ontology_mapping
name: warehouse_orders
ontology_ref: { name: sales }
semantic_model_ref:
  name: sales_data
  bindings:
    datasets:
      orders: warehouse.orders
concept_mappings:
  - concept: Order
    object_mappings:
      - expression: orders.order_number
```

Here `warehouse.orders` is a source's `connection.name`. Derived models use their
model name. Dataset aliases belong to the named scope. Mappings with the same scope
name must have the same bindings. Optional bindings list `relationships`, `metrics`,
and `verified_queries`. Standard nested referent and link mappings remain available.
A link tree's depth follows the relationship's role order; sibling nodes are branches.

## Inspect and validate

```bash
dogsled ontology list --project-root . --json
dogsled ontology describe sales --concept Order --yaml
dogsled ontology validate --strict --json
```

Validation checks document shapes, names, inheritance, relationship roles,
identifiers, and mapping references. Direct `dataset.field` expressions have field
reference checks. Other mapping expressions and rule expressions are preserved
with `expression_not_verified` warnings. Strict validation fails on these warnings.
Dogsled does not execute rules or check warehouse rows during these operations.

An unmapped ontology is valid. Missing ontology or model bindings make a mapping
incomplete. Diagnostics contain a code, file path, field path, severity, and message.
Validation failures use exit code 2. Runtime failures use exit code 1.

Exact reads include related concepts, parent definitions, source hashes, root context,
and diagnostics. A source hash identifies file contents; it is not a Cloud deployment
version. A host must attach its deployment identity when using these APIs.

## Preview changes

```bash
dogsled ontology create business/concepts.yml ./new-ontology.yml --yaml
dogsled ontology edit business/concepts.yml ./description-patch.yml --yaml
dogsled ontology delete business/concepts.yml --yaml
```

These commands preview changes. Add `--apply` to write. Create the parent folder
first. Creation never overwrites a file. Patches preserve unrelated YAML comments.
A rename is a patch to `name`; the preview lists affected mapping files. Update
those references in the same draft before deploying. Delete never deletes related
files automatically. Edits can leave a draft with reported reference errors.

## Exchange Ossie documents

```bash
dogsled ontology export --ossie-version 0.2.0.dev0 --yaml
dogsled ontology export --ossie-version 0.2.0.dev0 --out ./new-export
dogsled ontology import ./sales.ontology.yml ./sales.mapping.yml --json
```

Ontology exchange supports only `0.2.0.dev0`. The default target remains `0.1.1`,
so ontology export requires an explicit supported target. An unsupported target
fails before any files are written, with or without strict mode. Semantic-model-only
conversion retains its existing version support.

Import returns native file previews. Apply a reviewed native file with `create`.
Import does not fetch IRIs or guess connections. Pass `--connection warehouse` to
choose a connection for standard semantic sources. When a bundle includes semantic
models, its mappings bind to the imported native files. Embedded legacy mappings are split
into separate mapping files. Allowed foreign mapping extensions stay inert.
Native bindings use a versioned `DOGSLED` mapping extension. Rules and identities
survive conversion; comments and source folder layout are not exchange guarantees.

The ontology and mapping schema revision is
`0a908aa87ef093588416dbbcde399f8bdeac00cd`. Its referenced semantic schema is bundled
with it. Existing semantic conversion uses a different pinned development revision.
Semantic fields that its converter cannot preserve require an explicit diagnostic;
a shared version label is not a guarantee of compatibility.

## Library and MCP access

Import config-only APIs from `@bobsled-inc/dogsled/ontology`:

- `parseOntologyDocument(value)` validates a native document.
- `loadOntologyCatalog(index)` reads an existing Project Index and reports diagnostics.
- `getOntologyContext(catalog, request)` retrieves exact definitions and related context.
- `editOntologyFile(root, request)` previews or applies a create, patch, or delete.
- `importOntologyDocuments(inputs, context?)` and `exportOntologyDocuments(inputs, options)` return conversion results.
- `createOntologyTools({ projectRoot, authorize })` exposes shared operations to a host.

Start a local MCP server without a SQL runner:

```bash
dogsled ontology serve --project-root .
```

The server exposes `ontology_list`, `ontology_describe`, `ontology_validate`,
`ontology_edit`, `ontology_import`, and `ontology_export`. It uses stdio and grants
read/preview access to the selected local project. Add `--allow-write` only when
MCP clients should apply file edits. Embedded hosts must supply an authorization
callback for every read and write. Definition text never grants tool permissions.

The server does not query data. A host agent first reads definitions and mappings,
then uses its existing semantic-model and query tools to obtain evidence. Cloud
search, deployment, and vector indexing are separate integrations.

## Relationship extraction

An existing extraction relation can add `ontology_ref` with `ontology`, `concept`,
`relationship`, `left_concept`, and `right_concept`. Its existing `left_entity` and
`right_entity` fields bind those concept roles to extraction entity types.
The compiler obtains the shared description and rejects conflicting local meaning.
Only binary, non-derived relationships are accepted by this adapter. This limit
does not restrict the general ontology format.

A [complete checked example](../../packages/model-spec/tests/fixtures/customer-ontology/business/concepts.yml)
includes a [source model](../../packages/model-spec/tests/fixtures/customer-ontology/warehouse/orders.yml)
and a [mapping](../../packages/model-spec/tests/fixtures/customer-ontology/business/mapping.yml).
Validate that example without a warehouse connection:

```bash
dogsled ontology validate --project-root packages/model-spec/tests/fixtures/customer-ontology --strict
```

## Learn with existing projects

- The [Retail tutorial](retail.md) follows sales lines to products and suppliers,
  using real field mappings in its synthetic warehouse sources. Chapter 3 explains
  why counting sales lines differs from summing units sold.
- The [Ossie round-trip example](../../examples/osi-roundtrip/README.md) distinguishes
  an individual Order from a status summary. Its automated check exports and imports
  the ontology and validates the resulting mappings without a database connection.
