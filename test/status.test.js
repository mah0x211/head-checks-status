import assert from 'node:assert/strict';
import test from 'node:test';
import { groupJobs, headChecksStatus } from '../src/status.js';

const context = { repository: 'owner/repo', runId: '99', sha: 'head-sha' };
const root = '/repos/owner/repo/actions';

function run(overrides = {}) {
  return {
    id: 100, workflow_id: 42, head_sha: 'head-sha', event: 'push',
    run_attempt: 1, status: 'completed', conclusion: 'success',
    head_branch: 'some-other-branch',
    created_at: '2026-01-01T10:00:00Z',
    run_started_at: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

function fixture(runs, { jobs = [], attempts = runs } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path === root + '/runs/99') return { workflow_id: 42 };
      const attempt = attempts.find(item =>
        path === root + '/runs/' + item.id + '/attempts/' + item.run_attempt);
      assert.ok(attempt, 'Unexpected API path: ' + path);
      return attempt;
    },
    async list(path, key, query, limit) {
      calls.push(path);
      if (key === 'workflow_runs') {
        assert.equal(path, root + '/workflows/42/runs');
        assert.deepEqual(query, { event: 'push', head_sha: 'head-sha' });
        assert.equal(limit, 1000);
        return runs;
      }
      assert.ok(attempts.some(item =>
        path === root + '/runs/' + item.id + '/attempts/' + item.run_attempt + '/jobs'));
      assert.equal(key, 'jobs');
      return jobs;
    },
  };
}

test('not found has explicit empty outputs and no job request', async () => {
  const api = fixture([]);
  assert.deepEqual(await headChecksStatus(api, context), {
    found: 'false', workflow_status: '', workflow_conclusion: '',
    run_id: '', run_attempt: '', jobs: '{}',
  });
  assert.equal(api.calls.length, 2);
});

test('selects a later rerun of an older run over a newer run ID', async () => {
  const oldRerun = run({
    id: 100, run_attempt: 2, run_started_at: '2026-01-01T12:00:00Z',
    status: 'in_progress', conclusion: null,
  });
  const newerRun = run({ id: 101, run_started_at: '2026-01-01T11:00:00Z' });
  const api = fixture([newerRun, oldRerun]);
  const outputs = await headChecksStatus(api, context);
  assert.equal(outputs.run_id, '100');
  assert.equal(outputs.run_attempt, '2');
  assert.equal(outputs.workflow_status, 'in_progress');
  assert.equal(outputs.workflow_conclusion, '');
  assert.equal(api.calls.at(-1), root + '/runs/100/attempts/2/jobs');
});

test('uses attempt-specific timestamps rather than stale list timestamps', async () => {
  const api = fixture([run(), run({ id: 101 })], {
    attempts: [
      run({ run_started_at: '2026-01-01T13:00:00Z' }),
      run({ id: 101, run_started_at: '2026-01-01T12:00:00Z' }),
    ],
  });
  assert.equal((await headChecksStatus(api, context)).run_id, '100');
});

test('keeps workflow failure and job conclusions without deciding to rerun', async () => {
  const api = fixture([run({ conclusion: 'failure' })], {
    jobs: [
      { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'test (24)', status: 'queued', conclusion: null },
    ],
  });
  const outputs = await headChecksStatus(api, context);
  assert.equal(outputs.workflow_conclusion, 'failure');
  assert.deepEqual(JSON.parse(outputs.jobs), {
    test: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
    ],
    'test (24)': [{ id: 3, name: 'test (24)', status: 'queued', conclusion: null }],
  });
});

test('excludes the caller and unrelated workflows, events and SHAs', async () => {
  const api = fixture([
    run({ id: 99 }), run({ id: 102, workflow_id: 43 }),
    run({ id: 103, event: 'pull_request' }), run({ id: 104, head_sha: 'other' }),
  ]);
  assert.equal((await headChecksStatus(api, context)).found, 'false');
  assert.equal(api.calls.length, 2);
});

test('does not restrict source branches or fork origin', async () => {
  const api = fixture([run({
    head_branch: 'another-branch', head_repository: { full_name: 'fork/repo' },
  })]);
  assert.equal((await headChecksStatus(api, context)).found, 'true');
});

test('a detected queued workflow with no jobs is different from not found', async () => {
  const outputs = await headChecksStatus(fixture([run({
    status: 'queued', conclusion: null, run_started_at: null,
  })]), context);
  assert.equal(outputs.found, 'true');
  assert.equal(outputs.workflow_status, 'queued');
  assert.equal(outputs.jobs, '{}');
});

test('equal start timestamps select deterministically by run ID', async () => {
  const outputs = await headChecksStatus(fixture([run({ id: 101 }), run()]), context);
  assert.equal(outputs.run_id, '101');
});

test('job names cannot overwrite reserved keys or object prototypes', () => {
  const names = ['__proto__', 'constructor', 'jobs', 'workflow_status'];
  const jobs = names.map((name, i) =>
    ({ id: i + 1, name, status: 'in_progress', conclusion: null }));
  const grouped = JSON.parse(JSON.stringify(groupJobs(jobs)));
  assert.equal(Object.keys(grouped).length, 4);
  for (const name of names) {
    assert.equal(grouped[name].length, 1);
    assert.equal(grouped[name][0].name, name);
  }
  assert.equal({}.status, undefined);
});

test('rejects an attempt response from another commit', async () => {
  const api = fixture([run()], { attempts: [run({ head_sha: 'wrong' })] });
  await assert.rejects(headChecksStatus(api, context), /does not match/);
});

test('invalid timestamps and response fields fail instead of claiming not found', async () => {
  for (const changes of [
    { run_started_at: 'bad' }, { status: null }, { conclusion: undefined },
    { run_attempt: 0 }, { id: -1 },
  ]) {
    await assert.rejects(headChecksStatus(fixture([run(changes)]), context));
  }
  for (const changes of [{ id: 0 }, { name: '' }, { status: null }, { conclusion: 0 }]) {
    assert.throws(() => groupJobs([{
      id: 1, name: 'test', status: 'completed', conclusion: 'success', ...changes,
    }]));
  }
});

test('invalid context is rejected before any request', async () => {
  for (const changes of [{ repository: '' }, { runId: 'x' }, { sha: '' }]) {
    await assert.rejects(headChecksStatus(fixture([]), { ...context, ...changes }));
  }
});

test('API failures propagate', async () => {
  const api = { get: async () => { throw new Error('API unavailable'); } };
  await assert.rejects(headChecksStatus(api, context), /API unavailable/);
});
