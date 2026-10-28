# @bobsled-inc/dogsled

The `dogsled` command line and library for Dogsled Core: extract data from APIs,
databases, files and MCP servers, load it into a warehouse, and build SQL models on
top of it, all described in YAML files in your repository.

## Install

You need Node.js 24 or later. Install Dogsled into your project and run it with
`npx`:

```bash
npm install @bobsled-inc/dogsled
npx dogsled --version
```

Installing Dogsled into each project keeps its version and warehouse drivers with
the project. You can also install it globally with
`npm install -g @bobsled-inc/dogsled` and run `dogsled` directly; then install any
warehouse drivers globally too.

Warehouse drivers are optional. Install the ones you use next to Dogsled, for
example `npm install snowflake-sdk`; PostgreSQL support is included.

## First steps

```bash
npx dogsled init shop --duckdb
cd shop
npx dogsled integrations list --category finance
npx dogsled doctor
```

[Get started](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/getting-started.md)
continues from here: it loads a CSV file and a public API into DuckDB and builds a
SQL model.

## Documentation

- [Get started](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/getting-started.md)
- [Guides and reference](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/README.md)
- [CLI reference](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/cli.md)

## Library

The package also exports the engine for host applications, for example
`@bobsled-inc/dogsled/pipeline`, `/manifest`, `/model-spec/project`,
`/source-query`, `/project-skills` and `/connections`. See the
[library API notes](https://github.com/bobsled-inc/dogsled-core/blob/main/packages/dogsled/docs/library-api.md).

## License

Apache-2.0. Third-party code bundled in this package is listed in
`THIRD_PARTY_NOTICES.md`.
