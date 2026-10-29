# TV Night artifact design

The local artifact follows Dogsled's design system, inspected at commit `837d5988ff75bfd6a1ebddd40c66ceee448659f1` in the Dogsled product repository. That repository is a design reference, not a runtime dependency.

References: `packages/ui/DESIGN.md`, `packages/ui/AGENT_GUIDE.md`, the DataTable Compact/Empty/Loading/HorizontalScroll stories, SectionToolbar, StatusCard, Connections, GraphGroup, and pipeline RunDetail/RunGraph stories. The standalone page uses the `--artifact-*` mapping in `apps/agent/agent/skills/html-artifact-design/references/design-tokens.md`.

The layout uses a journey sidebar, restrained surfaces, compact tables, nearby evidence, and status labels. It deliberately omits the product Workspace story's chat/file split: chat already lives in the user's agent. System fonts replace product web fonts so the file works offline. Colours, spacing, type sizes, and focus treatment follow the artifact contract. Browser controls only explore saved data; they never execute commands.

Check light, dark, and system themes at desktop, 750 px, and 390 px widths. Tables scroll within their region. All controls need visible labels and keyboard focus. Compare the shipped rendering to the named stories before changing visual language.
