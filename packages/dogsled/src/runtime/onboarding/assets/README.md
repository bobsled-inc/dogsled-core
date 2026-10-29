# Portable tutorial assets

This is the offline asset boundary for the generated TV Night page. The checked-in
fonts, Dogsled mark and icon paths accompany the artifact composition. They require
no design-system checkout, package registry, CDN or browser fetch at runtime or build
time.

The composition follows the TV Night UI prototype. Icons retain the Dogsled icon
names; colours and typography map to its light and dark semantic tokens. This is an
artifact-specific HTML renderer, not a second public React component library.

`fonts.css` contains the Latin variable fonts Inter 5.3.0 and Roboto Mono 5.3.0,
encoded as data URLs. Their unmodified SIL Open Font License notices are adjacent
and are embedded in every generated page. The Dogsled mark and icon paths are
project assets. No React or third-party component runtime is redistributed.

After editing assets, regenerate the bundled TypeScript data:

```bash
node packages/dogsled/scripts/onboarding-assets.mjs
node packages/dogsled/scripts/onboarding-assets.mjs --check
```

The package build verifies the generated data, then embeds it in the CLI bundle.
No separate asset copying or sibling workspace is required when packing the CLI.
