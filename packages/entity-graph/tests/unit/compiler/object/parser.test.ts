import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseObjectSpec, resolveObjectSpec } from '../../../../src/compiler/object/parser.js';
import type { ResolvedEntityRelationshipSpec } from '../../../../src/compiler/relationship/types.js';

const RELATIONSHIP: ResolvedEntityRelationshipSpec = {
  name: 'works_at',
  leftEntity: 'contact',
  rightEntity: 'company',
  joinColumns: [{ left: 'email_domain', right: 'domain' }],
  joinType: 'inner',
  relationshipType: 'many_to_one',
  review: {
    thresholds: {
      auto_confirm: 0.92,
      review: 0.65,
      auto_reject: 0.4,
    },
  },
};

describe('object parser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-parser-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts the minimal object spec and resolves relation refs', () => {
    const filePath = path.join(tmpDir, 'company.object.yml');
    fs.writeFileSync(
      filePath,
      [
        `spec_version: '1'`,
        `type: object`,
        `name: company`,
        `identity:`,
        `  resolution_ref: ./company_resolution.yml`,
        `links:`,
        `  - relation_ref: ./works_at.entity-relationship.yml`,
        `    direction: inbound`,
      ].join('\n')
    );

    const parsed = parseObjectSpec(filePath);
    const resolved = resolveObjectSpec(
      parsed,
      [RELATIONSHIP],
      new Map([['works_at', path.join(tmpDir, 'works_at.entity-relationship.yml')]])
    );

    expect(resolved).toMatchObject({
      name: 'company',
      identityResolutionRef: './company_resolution.yml',
      links: [{ relationName: 'works_at', direction: 'inbound' }],
    });
  });

  it('rejects out-of-scope object fields', () => {
    const filePath = path.join(tmpDir, 'company.object.yml');
    fs.writeFileSync(
      filePath,
      [
        `spec_version: '1'`,
        `type: object`,
        `name: company`,
        `identity:`,
        `  resolution_ref: ./company_resolution.yml`,
        `links: []`,
        `traversal_budget: 3`,
      ].join('\n')
    );

    expect(() => parseObjectSpec(filePath)).toThrow(/Unrecognized key/);
  });

  it('rejects unknown relation refs during resolution', () => {
    const filePath = path.join(tmpDir, 'company.object.yml');
    fs.writeFileSync(
      filePath,
      [
        `spec_version: '1'`,
        `type: object`,
        `name: company`,
        `identity:`,
        `  resolution_ref: ./company_resolution.yml`,
        `links:`,
        `  - relation_ref: ./missing.entity-relationship.yml`,
        `    direction: inbound`,
      ].join('\n')
    );

    expect(() => resolveObjectSpec(parseObjectSpec(filePath), [RELATIONSHIP])).toThrow(
      /unknown relation_ref/
    );
  });
});
