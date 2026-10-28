# Explorer browser smoke

Run `pnpm exec playwright install chromium`, then `pnpm e2e:explorer-smoke` from a
built source checkout. The test seeds and resolves the fictional Entity Graph
workspace, starts Explorer through its documented dev launcher on a free loopback
port, and uses Chromium to check the dashboard, entity workspace, integration
catalog, curriculum, and pipeline builder. It exports an actual builder config
through the clipboard and validates the YAML with Dogsled's public schema.
Screenshots and the exported config are retained under ignored
`test-results/e2e/explorer/`.

For a manual run:

```bash
pnpm run setup
pnpm --filter @bobsled-inc/explorer dev
```

Open the printed local URL. No account or cloud key is needed. The browser test
also checks rendered branding and JavaScript/console errors, and stops its dev
server on exit.

Known limitation: Explorer is a source-only application and is absent from the CLI
npm tarball. Source CI runs the Explorer smoke test and the outsider
job reports it as not applicable while running the other 14 scenarios. This test
does not add Explorer to the published package.
