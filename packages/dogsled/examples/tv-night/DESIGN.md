# TV Night artifact design

The tutorial page uses Dogsled’s visual style: compact tables, clear status labels,
quiet backgrounds, and light and dark themes. The rules below and the
[local styles](../../src/runtime/onboarding/style.ts) define its appearance.

## Layout and controls

- Use a journey sidebar to show chapters and progress. Keep the original question
  in a shaded box near the top of the page.
- Group each chapter’s explanation, files and saved results together. Place evidence
  near the claim it supports, and keep spoilers collapsed until requested.
- Use compact tables with clear headers and status text. Wide tables scroll inside
  their own region rather than widening the page.
- Show the file tree on the left and the selected file on the right. Show model
  lineage as a single graph. The conversation stays in the learner’s agent.
- Browser controls explore saved data and files only. They never execute commands
  or query the database. Label results as saved snapshots.

## Appearance and accessibility

Use system fonts so the page works offline. Keep body text at 14 px with a 1.4 line
height, readable headings, and monospace text for code. Use neutral surfaces,
subtle borders, and a blue accent for links and focus. Keep colors in the local
CSS variables so light, dark and system themes remain consistent.

Give controls visible labels and a visible keyboard focus outline. Status labels
must explain the state in text rather than rely on color. Keep all content and
controls usable at desktop, 750 px and 390 px widths.

## Check a design change

Use this repository’s [walkthrough](README.md) to create a local example and run
`dogsled onboarding render`. Open the generated `.dogsled/onboarding/index.html`.
Capture the current page before changing the styles, then render the same saved
project after the change and compare the two versions.

Check light, dark and system themes at desktop, 750 px and 390 px widths. Inspect
both an empty project and a project with saved results. Confirm that tables scroll
within their region, the file viewer and lineage remain readable, and keyboard
navigation reaches every control with a visible focus outline. No external design
repository is needed for these checks.
