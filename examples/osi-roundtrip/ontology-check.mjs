import assert from 'node:assert/strict';
import { context } from '../../scripts/e2e/harness.mjs';

export async function checkOntologyRoundtrip(ctx) {
  const validated = JSON.parse(
    (await ctx.cli(['ontology', 'validate', '--strict', '--json'])).stdout
  );
  assert.equal(validated.ok, true);
  const described = JSON.parse(
    (await ctx.cli(['ontology', 'describe', 'shop', '--concept', 'Order', '--json'])).stdout
  );
  assert.ok(described.concepts.some((concept) => concept.concept === 'Order'));
  const exported = JSON.parse(
    (await ctx.cli(['ontology', 'export', '--ossie-version', '0.2.0.dev0', '--strict', '--json']))
      .stdout
  );
  assert.equal(exported.ready, true, JSON.stringify(exported.diagnostics));
  assert.equal(exported.files.length, 3);
  const rejected = JSON.parse(
    (await ctx.cli(['ontology', 'export', '--ossie-version', '0.1.1', '--json'], { expected: 2 }))
      .stdout
  );
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.files, []);

  // Use a separate project so imported identities cannot collide with the originals.
  const importedProject = await context('ontology-roundtrip');
  try {
    for (const file of exported.files) await importedProject.write(file.path, file.content);
    const imported = JSON.parse(
      (
        await importedProject.cli([
          'ontology',
          'import',
          ...exported.files.map((file) => file.path),
          '--json',
        ])
      ).stdout
    );
    assert.equal(imported.ready, true, JSON.stringify(imported.diagnostics));
    for (const file of imported.files)
      await importedProject.write(`native/${file.path}`, file.content);
    const revalidated = JSON.parse(
      (
        await importedProject.cli([
          'ontology',
          'validate',
          '--project-root',
          'native',
          '--strict',
          '--json',
        ])
      ).stdout
    );
    assert.equal(revalidated.ok, true, JSON.stringify(revalidated.diagnostics));
    const after = JSON.parse(
      (
        await importedProject.cli([
          'ontology',
          'describe',
          'shop',
          '--concept',
          'Order',
          '--project-root',
          'native',
          '--json',
        ])
      ).stdout
    );
    assert.deepEqual(after.concepts, described.concepts);
    assert.deepEqual(
      after.mappings.map((entry) => entry.document),
      described.mappings.map((entry) => entry.document)
    );
  } finally {
    await importedProject.cleanup();
  }
}
