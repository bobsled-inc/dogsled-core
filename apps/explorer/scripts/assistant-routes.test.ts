import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { POST as agentPost } from '../src/app/api/agent/route';
import { classifyClaudeFailure } from '../src/lib/claude-cli';
import { buildEntityGraphSystemPrompt } from '../src/lib/entity-graph-assistant-prompt';
import { getEntityGraphSpecsDir } from '../src/lib/entity-graph-workspace';

test('generic assistant rejects histories that do not end with a user turn', async () => {
  const response = await agentPost(
    new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'assistant', content: 'Previous answer' }],
      }),
    })
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'last message must be from the user');
});

test('Entity Graph assistant prompt uses unsaved draft YAML when the design surface sends it', async () => {
  const prompt = await buildEntityGraphSystemPrompt(
    'design',
    'default',
    'company',
    'company_resolution',
    ['name: company_resolution', '# draft-marker: unsaved', 'type: resolution'].join('\n')
  );

  assert.match(prompt, /Current resolution spec \(company_resolution\.yml\)/);
  assert.match(prompt, /draft-marker: unsaved/);
});

test('Entity Graph assistant fallback prompt deterministically prefers the default resolution spec', async () => {
  const specsDir = getEntityGraphSpecsDir('default');
  const extraSpecPath = path.join(specsDir, 'zzz_resolution.yml');

  await fs.writeFile(
    extraSpecPath,
    ['spec_version: "0.2"', 'name: zzz_resolution', 'type: resolution'].join('\n'),
    'utf8'
  );

  try {
    const prompt = await buildEntityGraphSystemPrompt('hub', 'default', 'company');
    assert.match(prompt, /Current resolution spec \(company_resolution\.yml\)/);
    assert.doesNotMatch(prompt, /Current resolution spec \(zzz_resolution\.yml\)/);
  } finally {
    await fs.rm(extraSpecPath, { force: true });
  }
});

test('Claude failure classification marks missing CLI binaries as unavailable', () => {
  const failure = classifyClaudeFailure('spawn claude ENOENT');

  assert.equal(failure.code, 'unavailable');
  assert.match(failure.message, /unavailable/i);
  assert.match(failure.hint ?? '', /claude/i);
});

test('Claude failure classification marks login problems as auth failures', () => {
  const failure = classifyClaudeFailure('Authentication failed: API key missing');

  assert.equal(failure.code, 'auth');
  assert.match(failure.message, /authentication/i);
});

test('Claude failure classification marks timeouts distinctly', () => {
  const failure = classifyClaudeFailure('Claude CLI exited with code 1', { timedOut: true });

  assert.equal(failure.code, 'timeout');
  assert.match(failure.message, /too long|timed out/i);
});
