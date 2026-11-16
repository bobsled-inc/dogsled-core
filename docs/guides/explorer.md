# Explorer

Explorer is a local web app for browsing what Dogsled can do: the integration
library, prebuilt model packages, a pipeline builder that exports `bobsled.yml`, a
terminal that runs `dogsled` commands, data previews of local DuckDB files, and the
entity graph.

Explorer is not part of the npm package. It runs from a source checkout of this
repository, has no login, and listens on 127.0.0.1 only. Do not expose it to a
network.

## Start it

You need Node.js 24 or later and pnpm.

```bash
git clone https://github.com/bobsled-inc/dogsled-core.git
cd bobsled-core
pnpm run setup
pnpm --filter @bobsled-inc/explorer dev
```

```text
▲ Next.js 15.5.28
- Local:        http://127.0.0.1:3333
```

Open <http://127.0.0.1:3333>. `pnpm --filter @bobsled-inc/explorer dev -- --port 4000`
uses another port.

## Pages

| Page                                    | What it shows                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/`                                     | Overview: counts of integrations, resources and model packages, and quick links.                                         |
| `/integrations`, `/integrations/<name>` | The integration library and each integration's resources, fields and auth setup.                                         |
| `/models`, `/models/<package>`          | Prebuilt model packages with their staging models, marts and metrics.                                                    |
| `/pipelines/new`                        | A step-by-step pipeline builder; `/pipelines/new/export` shows the resulting files.                                      |
| `/terminal`                             | Runs `dogsled` commands and keeps a run history (`/runs`).                                                               |
| `/data`                                 | Previews tables in local DuckDB files.                                                                                   |
| `/journeys`                             | Guided tours that connect the pages into one workflow.                                                                   |
| `/entity-graph`                         | The entity graph design and resolution views.                                                                            |
| `/setup`                                | The setup wizard (see [Set up a project](setup-and-doctor.md)).                                                          |
| `/docs`                                 | A built-in reference for commands, integrations and model packages.                                                      |
| `/agent`                                | A chat assistant that answers questions about Dogsled. It runs the `claude` command line tool installed on your machine. |
