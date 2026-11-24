import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const release = parse(read('.github/workflows/release.yml'));
const health = parse(read('.github/workflows/release-health.yml'));
const step = (job) => job.steps.find((entry) => entry.env?.HUSKY_ORIGIN);
const steps = {
  notify: step(release.jobs.notify),
  'release-status': step(release.jobs['release-status']),
  'release-health': step(health.jobs.report),
};
const names = Object.keys(steps);
const HOST = 'husky-host.example.com';
const ORIGIN = `https://${HOST}:8443`;
const BODY_SENTINEL = 'CHANNEL-SENTINEL';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Runs the real step script with a stub `curl`; everything public is stdout, stderr and the summary. */
function runStep(name, { status = 200, body, curlExit = 0, origin = ORIGIN } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'husky-logs-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(root, 'health-check'));
  writeFileSync(path.join(root, 'health-check/health-report.json'), '{}');
  // Mimics the curl options the steps use: --output, --write-out, --fail and --show-error.
  writeFileSync(
    path.join(bin, 'curl'),
    `#!${process.execPath}
const args = process.argv.slice(2);
const value = (...flags) => args[args.findIndex((arg) => flags.includes(arg)) + 1];
const has = (...flags) => args.some((arg) => flags.includes(arg));
const url = args.at(-1);
if (url.includes('audience=husky')) {
  process.stdout.write('{"value":"oidc-token"}');
} else {
  require('fs').writeFileSync(process.env.CALLED, url);
  const status = Number(process.env.FAKE_STATUS);
  const exit = Number(process.env.FAKE_EXIT) || (has('--fail') && status >= 400 ? 22 : 0);
  if (exit && has('--show-error')) process.stderr.write('curl: failed for ' + url + '\\n');
  if (!exit || exit !== 22) {
    const body = process.env.FAKE_EXIT !== '0' ? '' : process.env.FAKE_BODY;
    if (has('--output', '-o')) require('fs').writeFileSync(value('--output', '-o'), body);
    else process.stdout.write(body);
  }
  if (has('--write-out', '-w'))
    process.stdout.write(
      value('--write-out', '-w')
        .replace('\\\\n', '\\n')
        .replace('%{http_code}', process.env.FAKE_EXIT === '0' ? String(status) : '000')
    );
  process.exitCode = exit;
}
`,
    { mode: 0o755 }
  );
  const file = (suffix) => path.join(root, suffix);
  const result = spawnSync('bash', ['-e', '-c', steps[name].run], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HUSKY_ORIGIN: origin,
      RELEASE_VERSION: '0.5.1',
      RELEASE_BREAKING: 'false',
      NOTIFY_ONE_LINE: 'patch release',
      NOTIFY_PRS: '[]',
      PUBLISH_RESULT: 'success',
      RUN_ID: '1',
      RUN_URL: 'https://example.com/run',
      RELEASE_URL: 'https://example.com/release',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/oidc?x=1',
      GITHUB_OUTPUT: file('output'),
      GITHUB_STEP_SUMMARY: file('summary'),
      RUNNER_TEMP: root,
      CALLED: file('called'),
      FAKE_STATUS: String(status),
      FAKE_EXIT: String(curlExit),
      FAKE_BODY: body ?? JSON.stringify({ ok: true, channel: BODY_SENTINEL }),
    },
  });
  const contents = (suffix) => (existsSync(file(suffix)) ? readFileSync(file(suffix), 'utf8') : '');
  const log = `${result.stdout}\n${result.stderr}`;
  return {
    exit: result.status,
    log,
    masks: log.split('\n').filter((line) => line.startsWith('::add-mask::')),
    /** What the runner leaves readable: it drops mask commands and applies them to later lines. */
    visible: `${log
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n')}\n${contents('summary')}`,
    summary: contents('summary'),
    output: contents('output'),
    called: contents('called'),
  };
}

const rejected = JSON.stringify({ ok: false, error: BODY_SENTINEL });

describe('Husky log hygiene', () => {
  it.each(names)('%s reads the origin from a secret first and masks it before any call', (name) => {
    expect(steps[name].env.HUSKY_ORIGIN).toBe('${{ secrets.HUSKY_ORIGIN || vars.HUSKY_ORIGIN }}');
    const { run } = steps[name];
    expect(run.indexOf('::add-mask::')).toBeGreaterThan(-1);
    expect(run.indexOf('::add-mask::')).toBeLessThan(run.indexOf('curl'));
    expect(run).not.toMatch(/\bset -x|--verbose|--trace|\s-v\s/);
  });

  const outcomes = [
    ['success', {}],
    ['a rejected body', { body: rejected }],
    ['a body that is not JSON', { body: `<html>${BODY_SENTINEL}</html>` }],
    ['an empty body', { body: '' }],
    ['HTTP 409', { status: 409, body: rejected }],
    ['HTTP 500', { status: 500, body: rejected }],
    ['a network failure', { curlExit: 6 }],
  ];
  it.each(names.flatMap((name) => outcomes.map(([label, options]) => [name, label, options])))(
    '%s prints neither the response nor the origin after %s',
    (name, _label, options) => {
      const result = runStep(name, options);
      expect(result.called).toContain(`${ORIGIN}/api/`);
      expect(result.masks).toEqual([`::add-mask::${ORIGIN}`, `::add-mask::${HOST}`]);
      for (const text of [BODY_SENTINEL, ORIGIN, HOST, 'oidc-token', 'request-token'])
        expect(result.visible).not.toContain(text);
    }
  );

  it.each(names)('%s masks the bare host of an origin with a login, port or path', (name) => {
    for (const origin of [`https://user:pass@${HOST}:8443`, `https://${HOST}/base`, HOST])
      expect(runStep(name, { origin }).masks).toEqual([
        `::add-mask::${origin}`,
        `::add-mask::${HOST}`,
      ]);
  });

  it.each(['notify', 'release-status'])('%s stays non-blocking and reports the status', (name) => {
    for (const status of [409, 500]) {
      const result = runStep(name, { status, body: rejected });
      expect(result.exit).toBe(0);
      expect(result.summary).toContain(`HTTP ${status}, non-blocking`);
      expect(result.output).toBe('');
    }
    const offline = runStep(name, { curlExit: 6 });
    expect(offline.exit).toBe(0);
    expect(offline.summary).toContain('HTTP 000, non-blocking');
  });

  it('notify records acceptance only for an accepted body', () => {
    expect(runStep('notify').output).toBe('notified=true\n');
    for (const body of [rejected, '', 'not json']) {
      const result = runStep('notify', { body });
      expect(result).toMatchObject({ exit: 0, output: '' });
      expect(result.summary).toBe('Husky rejected the notification (HTTP 200, non-blocking).\n');
    }
  });

  it('release-health warns on a rejected report and still fails on a network error', () => {
    const accepted = runStep('release-health');
    expect(accepted).toMatchObject({ exit: 0, summary: '' });
    expect(accepted.visible).toContain('Husky responded 200');
    const refused = runStep('release-health', { status: 422, body: rejected });
    expect(refused.exit).toBe(0);
    expect(refused.summary).toContain('Husky rejected the report with HTTP 422.');
    const offline = runStep('release-health', { curlExit: 6 });
    expect(offline.exit).toBe(1);
    expect(offline.visible).toContain('Husky request failed (HTTP 000).');
  });

  it.each(['notify', 'release-health'])('%s skips without an origin', (name) => {
    const result = runStep(name, { origin: '' });
    expect(result).toMatchObject({ exit: 0, masks: [], called: '', output: '' });
    expect(result.summary).toMatch(/HUSKY_ORIGIN.* is not (?:configured|set)/);
  });

  it.each([
    ['release.yml', release, ['notify', 'release-status']],
    ['release-health.yml', health, ['report']],
  ])('%s exposes the origin to no other step', (_file, workflow, jobs) => {
    const users = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes('.HUSKY_ORIGIN')
    );
    expect(users.map(([name]) => name)).toEqual(jobs);
    for (const [, job] of users) {
      const exposed = job.steps.filter((entry) => JSON.stringify(entry).includes('.HUSKY_ORIGIN'));
      expect(exposed).toHaveLength(1);
      expect(exposed[0].run).not.toContain('${{');
    }
  });
});
