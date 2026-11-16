import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../src/github.js';

test('authenticated GET encodes query parameters and preserves enterprise API prefix', async () => {
  const calls = [];
  const api = new GitHub({
    token: 'secret', apiUrl: 'https://github.example/api/v3/',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ workflow_id: 42 });
    },
  });
  assert.deepEqual(await api.get('/repos/owner/repo/actions/runs', {
    event: 'push', head_sha: 'a+b',
  }), { workflow_id: 42 });
  assert.equal(calls[0].url.href,
    'https://github.example/api/v3/repos/owner/repo/actions/runs?event=push&head_sha=a%2Bb');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, undefined);
});

test('all pages are read even if an earlier page is shorter than per_page', async () => {
  const pages = [];
  const api = new GitHub({
    token: 'secret',
    fetchImpl: async url => {
      pages.push(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('per_page'), '100');
      return Response.json({
        total_count: 2, jobs: [{ id: Number(url.searchParams.get('page')) }],
      });
    },
  });
  assert.deepEqual(await api.list('/jobs', 'jobs'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(pages, ['1', '2']);
});

test('authentication, permission, not-found, rate-limit and server errors fail', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const api = new GitHub({
      token: 'secret', fetchImpl: async () => new Response('error', { status }),
    });
    await assert.rejects(api.get('/runs'), new RegExp('HTTP ' + status));
  }
});

test('network and JSON parsing errors propagate', async () => {
  const network = new GitHub({
    token: 'secret', fetchImpl: async () => { throw new Error('connection lost'); },
  });
  await assert.rejects(network.get('/runs'), /connection lost/);
  const json = new GitHub({
    token: 'secret', fetchImpl: async () => new Response('not json'),
  });
  await assert.rejects(json.get('/runs'), SyntaxError);
});

test('missing tokens, malformed pages, truncated pages and search limits fail', async () => {
  assert.throws(() => new GitHub({ token: '' }), /token is required/);
  for (const data of [
    {}, { total_count: -1, jobs: [] }, { total_count: 1, jobs: 'wrong' },
    { total_count: 1, jobs: [] },
  ]) {
    const api = new GitHub({
      token: 'secret', fetchImpl: async () => Response.json(data),
    });
    await assert.rejects(api.list('/jobs', 'jobs'));
  }
  const api = new GitHub({
    token: 'secret',
    fetchImpl: async () => Response.json({ total_count: 1001, workflow_runs: [] }),
  });
  await assert.rejects(api.list('/runs', 'workflow_runs', {}, 1000), /search limit/);
});
