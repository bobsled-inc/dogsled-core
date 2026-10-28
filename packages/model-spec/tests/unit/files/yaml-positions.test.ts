import { describe, expect, it } from 'vitest';
import {
  buildPositionMap,
  formatZodErrorWithPositions,
} from '../../../src/files/yaml-positions.js';

describe('yaml-positions', () => {
  describe('buildPositionMap', () => {
    it('maps top-level keys to line positions', () => {
      const yaml = `name: test\ntype: model\ndescription: hello`;
      const map = buildPositionMap(yaml);
      expect(map.get('name')).toEqual({ line: 1, col: 1 });
      expect(map.get('type')).toEqual({ line: 2, col: 1 });
      expect(map.get('description')).toEqual({ line: 3, col: 1 });
    });

    it('maps nested keys', () => {
      const yaml = `source:\n  ref: example.table\n  filter: x > 0`;
      const map = buildPositionMap(yaml);
      expect(map.get('source')).toEqual({ line: 1, col: 1 });
      expect(map.get('source.ref')).toEqual({ line: 2, col: 3 });
      expect(map.get('source.filter')).toEqual({ line: 3, col: 3 });
    });

    it('maps array items', () => {
      const yaml = `columns:\n  - name: id\n    expr: t0.id\n  - name: email\n    expr: t0.email`;
      const map = buildPositionMap(yaml);
      expect(map.has('columns.0')).toBe(true);
      expect(map.has('columns.0.name')).toBe(true);
      expect(map.has('columns.1')).toBe(true);
    });

    it('handles empty content', () => {
      const map = buildPositionMap('');
      expect(map.size).toBe(0);
    });
  });

  describe('formatZodErrorWithPositions', () => {
    it('formats errors with line:col when position exists', () => {
      const yaml = `name: test\ntype: model\nbad_field: oops`;
      const map = buildPositionMap(yaml);
      const zodError = {
        issues: [{ path: ['bad_field'], message: 'Unrecognized key' }],
      };
      const result = formatZodErrorWithPositions(zodError, map, 'models/test.yml');
      expect(result).toContain('models/test.yml:3:1');
      expect(result).toContain('Unrecognized key');
    });

    it('falls back to parent path when exact path not found', () => {
      const yaml = `columns:\n  - name: id`;
      const map = buildPositionMap(yaml);
      const zodError = {
        issues: [{ path: ['columns', 0, 'missing_field'], message: 'Required' }],
      };
      const result = formatZodErrorWithPositions(zodError, map, 'test.yml');
      expect(result).toContain('test.yml:');
      expect(result).toContain('Required');
    });

    it('falls back to no-position format when nothing found', () => {
      const map = buildPositionMap('name: test');
      const zodError = {
        issues: [{ path: ['nonexistent', 'deep'], message: 'Error' }],
      };
      const result = formatZodErrorWithPositions(zodError, map, 'test.yml');
      expect(result).toBe('test.yml: nonexistent.deep: Error');
    });
  });
});
