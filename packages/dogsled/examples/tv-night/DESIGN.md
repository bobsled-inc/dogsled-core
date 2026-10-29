# TV Night artifact design

The CLI renders the validated onboarding snapshot through the portable HTML
composition in `src/runtime/onboarding/`. It uses Dogsled's typography, colours,
logomark and icons, with licensed fonts embedded for offline use. Asset inputs and
the regeneration command are documented in `assets/README.md` beside the renderer.

## Layout and controls

- Keep the chapter journey visible in a sticky sidebar. At narrow widths it becomes
  a labelled, scrollable outline above the content, without a collapsed rail.
- Show one chapter at a time, with a compact introduction followed by understanding,
  saved results, working definitions and agent handoff. Use 32 px above each section
  and 40 px below, with dividers spanning the content area.
- Place result tabs and the visible/total row count beside search. Search all saved
  columns, sort values and paginate bounded previews. Open row details below the
  table; article passages and supporting excerpts stay collapsed.
- Keep safe files and declared dependency lineage together. Use elbow connectors
  and open arrowheads. Do not infer relationships or successful execution from an
  arrow. Missing definitions and graph cycles stay explicit.
- Keep Previous, Mark as reviewed and Next step in a sticky action bar. Previous
  and Next browse chapters; they do not execute work or update progress.
- Keep the learner's original question, viewing preferences, source attribution,
  answer history and optional SQL guidance in the project-context disclosure,
  accessible from More. Existing chapter, files, lineage and data anchors work.

## Review and refresh contract

The HTML explores a timestamped snapshot. It never queries the database, executes
commands or writes project files. Refreshing the browser does not refresh evidence.
The agent runs `dogsled onboarding render` to regenerate the same page.

Mark as reviewed prepares and copies a request for the agent, including
`dogsled onboarding review <step> --checkpoint <sha256>` followed by a render. The
hash identifies the tables the learner saw. If those results changed, the CLI
rejects the request with drift exit code 3 so the learner can review the new result.
Malformed fingerprints use validation exit code 2. The existing review command
without the optional guard remains available for agent-led inspection.

The browser never displays a newly confirmed review on its own. Reviewed appears
only when the next rendered snapshot contains the matching journal entry. A copy
failure selects the exact request for manual copying. No local storage, tracking,
watcher or tutorial server is involved.

## Appearance and accessibility

Use Inter for prose and Roboto Mono for code with system fallbacks. Body text is
14 px, main headings 34 px, section headings 24 px and handoff titles 20 px. Use
quiet primary backgrounds, subtle dividers, branded selection and visible focus.
The More menu offers system, light and dark themes.

Keep tab arrow keys, Home and End working. Search Escape restores focus to its
trigger; closing a record restores focus to its row action. Status labels explain
states in text. Wide tables and graphs scroll inside their own regions. The action
bar's measured height reserves room for wrapped controls at narrow widths.

## Verification

Run the onboarding unit suite, including the DOM interaction tests, and the normal
repository gate. Tests cover empty, partial, failed and reviewed snapshots,
clipboard fallback, tabs, search, sorting, pagination, safe file inspection, stale
review rejection and spoiler disclosure. The package build checks asset drift.

For visual review, generate the page from the same saved project before and after
the change. Inspect light, dark and system themes at desktop, 750 px and 390 px.
Check table and graph overflow, sticky actions and keyboard focus. No external
design repository is required to build or inspect the page.
