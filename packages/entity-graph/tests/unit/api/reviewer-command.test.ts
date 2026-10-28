import { describe, expect, it } from 'vitest';
import { reviewerCommandArgs, reviewerCommandEnv } from '../../../src/api/reviewer-command.js';
describe('local reviewer execution', () => {
  it('accepts argv and quoted legacy arguments without shell expansion', () => {
    expect(reviewerCommandArgs(['node', 'file with spaces.js', '$(id)', ''])).toEqual([
      'node',
      'file with spaces.js',
      '$(id)',
      '',
    ]);
    expect(reviewerCommandArgs('node "file with spaces.js" --name \'hello world\'')).toEqual([
      'node',
      'file with spaces.js',
      '--name',
      'hello world',
    ]);
  });
  it.each(['node foo; id', 'node foo | id', 'node $(id)', 'node > file', 'node "unclosed'])(
    'rejects shell syntax %s',
    (command) => {
      expect(() => reviewerCommandArgs(command)).toThrow();
    }
  );
  it('passes only the minimal command environment', () => {
    expect(
      reviewerCommandEnv({
        PATH: '/bin',
        LANG: 'C',
        GITHUB_TOKEN: 'synthetic',
        NODE_OPTIONS: '--require evil',
        OPENAI_API_KEY: 'synthetic',
        HOME: '/secret',
      })
    ).toEqual({ PATH: '/bin', LANG: 'C' });
  });
});
