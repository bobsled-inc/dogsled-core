# OSI import and export

Dogsled supports importing and exporting semantic models in the Open Semantic
Interchange (OSI) format. Dogsled converts OSI documents to native source, model,
metric, and relationship YAML, and verified queries (with `0.2.0.dev0`), for
editing, validation, compilation, and execution.

Read the [OSI import and export guide](ossie-interchange.md) for the supported
OSI versions, CLI and SDK commands, BOBSLED extensions, connection mapping,
diagnostics, metadata preservation, and export limitations.

## Move an older raw OSI project file

1. Import the raw document into a new directory:

   ```sh
   dogsled model ossie import sales.yml --out ../imported-sales --yaml
   ```

2. Review the import result and fix any fields reported as incomplete.
3. Replace the raw document with the generated native files.
4. Run the project's normal validation, compilation, and execution checks.

Do not keep the raw OSI document and its converted native files in the same
project. They describe the same objects. Dogsled still has a direct reader for
existing projects, but this is a legacy compatibility path. Do not use it for new
authoring.
