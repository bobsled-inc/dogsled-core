# Bobsled Core plugin for Claude Code and Codex

Install Bobsled Core's built-in skills together. Ask your agent to set up a project,
build a pipeline, define data models, or diagnose a failed run.

The plugin contains instructions and reference documents. It uses the agent's
terminal tool to run Bobsled Core. It does not install the CLI, add a hosted service,
connect accounts, or run commands on installation.

## Install in Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add bobsled-inc/bobsled-core
/plugin install bobsled-core@bobsled
```

Open your project folder in Claude Code and ask:

> Use bobsled-get-started to install Bobsled Core and set up my project.

The skill checks Node.js 24+ and installs Bobsled Core in your project if needed.
For the guided tutorial, run `/bobsled-core:bobsled-tutorials`.

## Install in Codex

Run these commands in your terminal with a current Codex CLI:

```bash
codex plugin marketplace add bobsled-inc/bobsled-core
codex plugin add bobsled-core@bobsled
```

Start a new Codex chat in your project folder and ask:

> Use bobsled-get-started to install Bobsled Core and set up my project.

The skill checks Node.js 24+ and installs Bobsled Core in your project if needed.
In the desktop app, you can also select the Bobsled Core marketplace in
Plugins and install Bobsled Core there after adding the marketplace.

These GitHub commands work after the plugin files reach the repository's default
branch. To test an unpublished checkout, use its absolute directory path instead
of `bobsled-inc/bobsled-core` when adding the marketplace.

## Install the Bobsled Core CLI

The setup skill can install the CLI for you. To install it yourself, use Node.js
24 or newer and run these commands in your data project:

```bash
npm install @bobsled-inc/bobsled-core
npx bobsled --help
```

Ask the agent to use `npx bobsled` for a project-local installation. The CLI and
plugin are released separately. Database drivers and credentials
depend on the source and destination you choose. Keep credentials in environment
variables, never in skill files or committed configuration.

## Update

In Claude Code, run `/plugin marketplace update bobsled` and
`/plugin update bobsled-core@bobsled`. In Codex, use the plugin management UI to update
the marketplace and plugin, or inspect `codex plugin marketplace --help` for the
commands supported by your installed version. Start a new chat after updating.

## Maintain this bundle

Edit `.agents/skills/` in the repository. Do not edit the generated skill copies
under this folder. Only skills marked `exposed: true` are shipped. Both apps use
the same skill files; their catalog files point to this directory.

From the repository root, run:

```bash
pnpm --filter @bobsled-inc/skills generate:manifest
pnpm skills:check
pnpm --filter @bobsled-inc/skills test:unit
claude plugin validate plugins/bobsled-core
claude plugin validate .claude-plugin/marketplace.json
```

Generation expands document includes and copies skill-local Markdown references.
Links to other repository documents point to their public GitHub pages.
Commit the generated files with the source changes. Bump `PLUGIN_VERSION` in
`packages/skills/scripts/build-plugins.ts` when publishing changes to the bundle. The unit tests check for stale or missing files
and load skills from an isolated copy of the plugin.

CI and `pnpm precommit` run `pnpm skills:check` before any build. This uncached,
read-only check compares fresh generated output with the files in the checkout.
It fails on changed, missing, or extra skill files, so a build cannot hide stale
committed copies by rewriting them first. Publishing and plugin version bumps
remain separate maintainer steps.

Publishing this GitHub marketplace does not list Bobsled Core in either provider's
official directory. Official listings require a separate submission.
