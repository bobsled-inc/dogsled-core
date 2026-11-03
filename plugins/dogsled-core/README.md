# Dogsled Core plugin for Claude Code and Codex

Install Dogsled's built-in skills together. Ask your agent to set up a project,
build a pipeline, define data models, or diagnose a failed run.

The plugin contains instructions and reference documents. It uses the agent's
terminal tool to run Dogsled. It does not install the CLI, add a hosted service,
connect accounts, or run commands on installation.

## Install in Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add bobsled-inc/dogsled-core
/plugin install dogsled-core@dogsled
```

Then ask: "Use the Dogsled Core plugin to help me set up a data pipeline."
For the guided tutorial, run `/dogsled-core:dogsled-get-started`.

## Install in Codex

Run these commands in your terminal with a current Codex CLI:

```bash
codex plugin marketplace add bobsled-inc/dogsled-core
codex plugin add dogsled-core@dogsled
```

Start a new Codex chat and ask: "Use the Dogsled Core plugin to help me set up a data
pipeline." In the desktop app, you can also select the Dogsled marketplace in
Plugins and install Dogsled Core there after adding the marketplace.

These GitHub commands work after the plugin files reach the repository's default
branch. To test an unpublished checkout, use its absolute directory path instead
of `bobsled-inc/dogsled-core` when adding the marketplace.

## Install the Dogsled CLI

Use Node.js 24 or newer. In your data project, install Dogsled:

```bash
npm install @bobsled-inc/dogsled
npx dogsled --help
```

Ask the agent to use `npx dogsled` for a project-local installation. The CLI and
plugin are released separately. Database drivers and credentials
depend on the source and destination you choose. Keep credentials in environment
variables, never in skill files or committed configuration.

## Update

In Claude Code, run `/plugin marketplace update dogsled` and
`/plugin update dogsled-core@dogsled`. In Codex, use the plugin management UI to update
the marketplace and plugin, or inspect `codex plugin marketplace --help` for the
commands supported by your installed version. Start a new chat after updating.

## Maintain this bundle

Edit `.agents/skills/` in the repository. Do not edit the generated skill copies
under this folder. Only skills marked `exposed: true` are shipped. Both apps use
the same skill files; their catalog files point to this directory.

From the repository root, run:

```bash
pnpm --filter @bobsled-inc/skills generate:manifest
pnpm --filter @bobsled-inc/skills test:unit
claude plugin validate plugins/dogsled-core
claude plugin validate .claude-plugin/marketplace.json
```

Generation expands document includes and copies skill-local Markdown references.
Links to other repository documents point to their public GitHub pages.
Commit the generated files with the source changes. Bump `PLUGIN_VERSION` in
`packages/skills/scripts/build-plugins.ts` when publishing changes to the bundle. The unit tests check for stale or missing files
and load skills from an isolated copy of the plugin.

Publishing this GitHub marketplace does not list Dogsled in either provider's
official directory. Official listings require a separate submission.
