import { readFileSync, writeFileSync } from 'node:fs';
import { collectBundledPackages } from './third-party-notices.mjs';
import { sha256File } from '../security/lib.mjs';

const packageUrl = ({ name, version }) =>
  `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`;

export function mergeBundledComponents(sbom, packages) {
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components))
    throw new Error('Expected a CycloneDX SBOM with components.');
  if (!packages.length) throw new Error('Missing bundled package inventory.');
  for (const pkg of packages) {
    const purl = packageUrl(pkg);
    let component = sbom.components.find((entry) => entry.purl === purl);
    if (!component) {
      const slash = pkg.name.lastIndexOf('/');
      component = {
        type: 'library',
        ...(slash < 0 ? {} : { group: pkg.name.slice(0, slash) }),
        name: pkg.name.slice(slash + 1),
        version: pkg.version,
        purl,
        'bom-ref': purl,
        licenses: [{ expression: pkg.license }],
      };
      sbom.components.push(component);
    }
    component.properties ??= [];
    if (!component.properties.some((property) => property.name === 'bobsled:inlined'))
      component.properties.push({ name: 'bobsled:inlined', value: 'true' });
    const parent = sbom.metadata?.component?.['bom-ref'];
    if (parent) {
      sbom.dependencies ??= [];
      let dependency = sbom.dependencies.find((entry) => entry.ref === parent);
      if (!dependency) {
        dependency = { ref: parent, dependsOn: [] };
        sbom.dependencies.push(dependency);
      }
      dependency.dependsOn ??= [];
      const ref = component['bom-ref'] ?? component.purl;
      if (!dependency.dependsOn.includes(ref)) dependency.dependsOn.push(ref);
    }
  }
  for (const pkg of packages)
    if (!sbom.components.some((component) => component.purl === packageUrl(pkg)))
      throw new Error(`SBOM omits bundled package ${pkg.id}.`);
  return sbom;
}

export function completeBundledSbom(file, packages = collectBundledPackages()) {
  const sbom = mergeBundledComponents(JSON.parse(readFileSync(file, 'utf8')), packages);
  writeFileSync(file, `${JSON.stringify(sbom, null, 2)}\n`);
  return sha256File(file);
}
