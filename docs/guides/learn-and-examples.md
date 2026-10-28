# Tutorial and examples

## The interactive tutorial

`dogsled learn` is a step-by-step tutorial in your terminal. It has 150 lessons in 19
sections, from the CLI basics through extraction, loading, models, verified
queries, entity resolution and MCP extraction. Each lesson explains a step, runs
the command, and shows the result.

The tutorial uses sample data from this repository, so it runs from a source
checkout:

```bash
git clone https://github.com/bobsled-inc/dogsled-core.git
cd dogsled-core
pnpm run setup
node packages/dogsled/bin/cli.mjs learn --cli "node $PWD/packages/dogsled/bin/cli.mjs"
```

`--cli` tells the tutorial how to run `dogsled`; leave it out if `dogsled` is on your
`PATH`, or set `DOGSLED_CLI`. Other options:

- `--list` shows every section and your progress.
- `--section "Model Spec"` or `--goto 25` jumps ahead.
- `--auto` runs the lessons without waiting for you.
- `--reset` clears your progress.

Progress is saved in `.dogsled/tutor-lab/` under the repository root. Most
sections need no credentials. Sections that call live APIs, such as Linear or a
cloud warehouse, list the environment variables they need and are skipped when
those variables are not set.

## Example projects

The [`examples/`](../../examples/README.md) folder contains runnable projects with
fictional data. Each one has a README that walks through it, and most have an
automated check that runs in CI:

```bash
pnpm e2e:golden-path-quickstart
pnpm e2e
```

Two further example projects ship with the npm package. `dogsled examples list`
shows them and `dogsled examples init <name>` copies one into a new folder:

```bash
dogsled examples list
dogsled examples init s3-documents-ingestion
```
