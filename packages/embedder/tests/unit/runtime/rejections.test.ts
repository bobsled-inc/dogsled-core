import { readFileSync } from 'node:fs';

import { parseStderrMessage } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { describeRejections } from '../../../src/runtime/rejections.js';

describe('the report of refused inputs', () => {
  it('is the one that the contract of host embeddings shows', () => {
    const page = readFileSync(
      new URL('../../../../../docs/reference/host-embeddings.md', import.meta.url),
      'utf8'
    );
    const example = [...page.matchAll(/```json\n([\s\S]*?)```/g)]
      .map(([, json]) => JSON.parse(json!) as Record<string, unknown>)
      .find((json) => json['type'] === 'LOG');
    const counts = new Map([
      ['unsupported_text', 1],
      ['too_long', 2],
    ]);
    expect(example).toEqual({
      _v: 1,
      type: 'LOG',
      level: 'warn',
      time: '2026-01-01T00:00:00.000Z',
      ...describeRejections('handbook__chunks', counts),
    });
    expect(parseStderrMessage(example)).toEqual(example);
  });
});
