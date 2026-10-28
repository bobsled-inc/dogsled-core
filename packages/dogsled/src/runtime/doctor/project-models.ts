import {
  buildDagFromDocuments,
  buildIndexedSourceRegistry,
  normalizeSourceRef,
} from '@bobsled-inc/model-spec';
import { entriesOfKind, type ProjectIndex } from '@bobsled-inc/project-index';
import type { DoctorCheck } from '../../commands/doctor.js';

export function checkProjectModelReferences(index: ProjectIndex): DoctorCheck[] {
  const documents = entriesOfKind(index, 'model').map((entry) => ({
    filePath: entry.path,
    data: entry.document,
  }));
  if (documents.length === 0) return [];
  const dag = buildDagFromDocuments(documents);
  if (!dag.ok) {
    return [
      {
        name: 'project.models',
        status: 'error',
        message:
          'Model definitions or dependencies are invalid; run dogsled model validate for diagnostics.',
      },
    ];
  }
  const sources = buildIndexedSourceRegistry(index);
  if (!sources.ok) {
    return [
      {
        name: 'project.models',
        status: 'error',
        message: 'Source definitions are invalid; run dogsled model validate for diagnostics.',
      },
    ];
  }
  const known = new Set([...sources.registry.keys()].map(normalizeSourceRef));
  const checks: DoctorCheck[] = [];
  for (const node of dag.order) {
    for (const ref of node.sourceRefs) {
      if (known.has(normalizeSourceRef(ref))) continue;
      const label = /^[a-z0-9_.-]+$/i.test(ref) ? ref : '<invalid reference>';
      checks.push({
        name: 'project.models.references',
        status: 'error',
        filePath: node.filePath,
        message: `Model ${node.name} references missing source ${label}`,
      });
      if (checks.length === 20) return checks;
    }
  }
  return checks.length
    ? checks
    : [
        {
          name: 'project.models.references',
          status: 'ok',
          message: 'Model source references resolve',
        },
      ];
}
