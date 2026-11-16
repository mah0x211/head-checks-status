import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runAction } from '../src/action.js';

const env = {
  GITHUB_EVENT_PATH: 'event.json', GITHUB_OUTPUT: 'output.txt',
  GITHUB_REPOSITORY: 'base/project', GITHUB_RUN_ID: '99',
  GITHUB_SHA: 'event-sha', INPUT_TOKEN: 'test-token',
};
const attempt = {
  id: 100, run_attempt: 2, workflow_id: 42, event: 'push',
  head_sha: 'head-sha', status: 'in_progress', conclusion: null,
  run_started_at: '2026-01-01T12:00:00Z',
};
const job = { id: 1, name: 'test', status: 'in_progress', conclusion: null };

function fetchFixture({ found = true } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async url => {
      calls.push(url);
      const path = url.pathname;
      if (path.endsWith('/runs/99')) return Response.json({ workflow_id: 42 });
      if (path.endsWith('/workflows/42/runs')) {
        const run = { ...attempt, head_sha: url.searchParams.get('head_sha') };
        return Response.json({ total_count: found ? 1 : 0, workflow_runs: found ? [run] : [] });
      }
      if (path.endsWith('/attempts/2')) return Response.json(attempt);
      if (path.endsWith('/attempts/2/jobs')) {
        return Response.json({ total_count: 1, jobs: [job] });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  };
}

function parseOutputs(commands) {
  const lines = commands.split('\n');
  const outputs = {};
  for (let i = 0; i < lines.length - 1;) {
    const [name, delimiter] = lines[i++].split('<<');
    const values = [];
    while (lines[i] !== delimiter) {
      assert.ok(i < lines.length, 'Unterminated output');
      values.push(lines[i++]);
    }
    i += 1;
    outputs[name] = values.join('\n');
  }
  return outputs;
}

test('fork PR uses the PR head and the receiving repository, and writes all outputs', async () => {
  const api = fetchFixture();
  const writes = [];
  const outputs = await runAction({
    env, fetchImpl: api.fetch,
    read: async path => {
      assert.equal(path, 'event.json');
      return JSON.stringify({ pull_request: {
        head: { sha: 'head-sha', repo: { full_name: 'contributor/fork' } },
      } });
    },
    append: async (...args) => writes.push(args),
  });
  assert.equal(api.calls[1].searchParams.get('head_sha'), 'head-sha');
  assert.ok(api.calls.every(url => url.pathname.startsWith('/repos/base/project/')));
  assert.equal(outputs.workflow_status, 'in_progress');
  assert.deepEqual(JSON.parse(outputs.jobs), { test: [job] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'output.txt');
  assert.deepEqual(parseOutputs(writes[0][1]), outputs);
});

test('non-PR events use the event SHA and support the environment token fallback', async () => {
  const api = fetchFixture({ found: false });
  const outputs = await runAction({
    env: { ...env, INPUT_TOKEN: '', GITHUB_TOKEN: 'fallback' },
    fetchImpl: api.fetch, read: async () => '{}', append: async () => {},
  });
  assert.equal(api.calls[1].searchParams.get('head_sha'), 'event-sha');
  assert.equal(outputs.found, 'false');
});

test('API errors never publish a misleading not-found result', async () => {
  const writes = [];
  await assert.rejects(runAction({
    env, read: async () => '{}',
    append: async (...args) => writes.push(args),
    fetchImpl: async () => new Response('', { status: 403 }),
  }), /HTTP 403/);
  assert.equal(writes.length, 0);
});

test('missing context and malformed event payloads fail before publishing outputs', async () => {
  for (const missing of [
    'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_SHA',
  ]) {
    await assert.rejects(runAction({
      env: { ...env, [missing]: '' }, read: async () => '{}',
    }), new RegExp('Missing ' + missing));
  }
  await assert.rejects(runAction({ env, read: async () => 'bad json' }), SyntaxError);
  await assert.rejects(runAction({
    env, read: async () => '{"pull_request":{"head":{}}}',
  }), /Missing sha/);
});

test('the distributed entrypoint exits unsuccessfully for invalid action context', () => {
  const result = spawnSync(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url), env: {}, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing GITHUB_EVENT_PATH/);
});

test('the distributed action runs end to end against an HTTP API and writes runner outputs', async t => {
  const { createServer } = await import('node:http');
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = new URL('..', import.meta.url);
  const work = new URL('../.codex/', import.meta.url);
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work.pathname, 'action-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const api = fetchFixture();
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, 'Bearer test-token');
      const result = await api.fetch(new URL(request.url, 'http://localhost'));
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output.txt');
  await writeFile(eventPath, JSON.stringify({ pull_request: { head: { sha: 'head-sha' } } }));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: root,
    env: {
      ...env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port,
    },
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, errors);
  const outputs = parseOutputs(await readFile(outputPath, 'utf8'));
  assert.equal(outputs.found, 'true');
  assert.equal(outputs.run_attempt, '2');
  assert.deepEqual(JSON.parse(outputs.jobs), { test: [job] });
});
