/*
 * MIT License
 *
 * Copyright (c) 2026 Masatoshi Fukunaga
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid ' + label + ' in GitHub API response');
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid ' + label + ' in GitHub API response');
  }
  return value;
}

function conclusion(value) {
  if (value !== null && typeof value !== 'string') {
    throw new Error('Invalid conclusion in GitHub API response');
  }
  return value;
}

function startedAt(run) {
  // A queued attempt may not have started yet; use its creation timestamp.
  const timestamp = run.run_started_at ?? run.created_at;
  const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(parsed)) throw new Error('Invalid attempt start timestamp');
  return parsed;
}

export function groupJobs(jobs) {
  const grouped = Object.create(null);
  for (const job of jobs) {
    const name = text(job.name, 'job name');
    const value = {
      id: positiveInteger(job.id, 'job ID'),
      name,
      status: text(job.status, 'job status'),
      conclusion: conclusion(job.conclusion),
      state: job.status === 'completed' ? job.conclusion : job.status,
    };
    (grouped[name] ??= []).push(value);
  }
  return Object.fromEntries(Object.keys(grouped).sort().map(name => [
    name, grouped[name].sort((a, b) => a.id - b.id),
  ]));
}

export async function headChecksStatus(api, { repository, runId, sha }) {
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must contain owner/repository');
  }
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error('Invalid GITHUB_RUN_ID');
  text(sha, 'head SHA');
  const repoPath = '/repos/' + repository.split('/').map(encodeURIComponent).join('/');
  const current = await api.get(repoPath + '/actions/runs/' + runId);
  const workflowId = positiveInteger(current.workflow_id, 'workflow ID');
  const runs = await api.list(
    repoPath + '/actions/workflows/' + workflowId + '/runs',
    'workflow_runs', { event: 'push', head_sha: sha }, 1000);
  let selected;
  for (const run of runs) {
    const id = positiveInteger(run.id, 'run ID');
    // Do not report the caller itself as evidence of a previous execution.
    if (String(id) === String(runId)) continue;
    if (run.event !== 'push' || run.head_sha !== sha || run.workflow_id !== workflowId) {
      continue;
    }
    const attemptNumber = positiveInteger(run.run_attempt, 'attempt number');
    const attempt = await api.get(
      repoPath + '/actions/runs/' + id + '/attempts/' + attemptNumber);
    if (attempt.id !== id || attempt.run_attempt !== attemptNumber
        || attempt.workflow_id !== workflowId || attempt.head_sha !== sha
        || attempt.event !== 'push') {
      throw new Error('Workflow attempt does not match the requested run');
    }
    const started = startedAt(attempt);
    text(attempt.status, 'workflow status');
    conclusion(attempt.conclusion);
    if (!selected || started > selected.started
        || (started === selected.started && id > selected.run.id)) {
      selected = { started, run: attempt };
    }
  }
  if (!selected) {
    return {
      found: 'false', workflow_status: '', workflow_conclusion: '', workflow_state: '',
      run_id: '', run_attempt: '', jobs: '{}',
    };
  }
  const run = selected.run;
  // Pin jobs to the selected attempt so a concurrent rerun cannot mix attempts.
  const jobs = await api.list(
    repoPath + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs',
    'jobs');
  return {
    found: 'true',
    workflow_status: run.status,
    workflow_conclusion: run.status === 'completed' ? (run.conclusion ?? '') : '',
    workflow_state: run.status === 'completed' ? (run.conclusion ?? '') : run.status,
    run_id: String(run.id),
    run_attempt: String(run.run_attempt),
    jobs: JSON.stringify(groupJobs(jobs)),
  };
}
