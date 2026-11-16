# head-checks-status

Report existing push workflow and job states for the current head commit.

The action identifies the caller's workflow automatically and searches push runs
in the caller's repository. For a PR it uses the source head SHA, including PRs
from forks; for other events it uses the event's `GITHUB_SHA`. It does not query
a branch's moving head or search runs in the fork repository.

It returns state only. It does not wait, rerun jobs, copy checks, decide whether
to skip tests, or evaluate required checks.

## Usage

Run the action in a dedicated GitHub-hosted job without a job container.
Node.js 24 is provided by the Actions runner; consumers do not need to install
Node.js, Python, shell tools, or npm dependencies for this action.

```yaml
on:
  push:
  pull_request:

jobs:
  detect-head-checks:
    runs-on: ubuntu-latest
    permissions:
      actions: read
    outputs:
      found: ${{ steps.detect.outputs.found }}
      workflow_status: ${{ steps.detect.outputs.workflow_status }}
      workflow_conclusion: ${{ steps.detect.outputs.workflow_conclusion }}
      run_id: ${{ steps.detect.outputs.run_id }}
      run_attempt: ${{ steps.detect.outputs.run_attempt }}
      jobs: ${{ steps.detect.outputs.jobs }}
    steps:
      - id: detect
        uses: mah0x211/head-checks-status@v1

      # Within this job, read the action step's outputs directly.
      - name: Show detected workflow status
        if: steps.detect.outputs.found == 'true'
        env:
          STATUS: ${{ steps.detect.outputs.workflow_status }}
          CONCLUSION: ${{ steps.detect.outputs.workflow_conclusion }}
        run: |
          printf 'Status: %s\nConclusion: %s\n' "$STATUS" "$CONCLUSION"

  report-head-checks:
    runs-on: ubuntu-latest
    needs: detect-head-checks
    # Across jobs, read the outputs exported by the detection job.
    if: needs.detect-head-checks.outputs.found == 'true'
    steps:
      - name: Use workflow and job results
        env:
          RUN_ID: ${{ needs.detect-head-checks.outputs.run_id }}
          RUN_ATTEMPT: ${{ needs.detect-head-checks.outputs.run_attempt }}
          JOBS: ${{ needs.detect-head-checks.outputs.jobs }}
          TEST_FAILED: ${{ contains(fromJSON(needs.detect-head-checks.outputs.jobs).test.*.conclusion, 'failure') }}
        run: |
          printf 'Selected run: %s (attempt %s)\n' "$RUN_ID" "$RUN_ATTEMPT"
          printf 'Any failed job named test: %s\n' "$TEST_FAILED"
          printf 'Jobs JSON: %s\n' "$JOBS"
```

Use `steps.detect.outputs.<name>` in later steps of the same job. To use a
value in another job, first export it under the detection job's `outputs`,
declare that job in `needs`, and read `needs.detect-head-checks.outputs.<name>`.
The example also parses the `jobs` JSON to check whether any job named `test`
failed. Replace `test` with the exact job display name you want to inspect.

Both reporting steps are skipped when `found` is `'false'`. Conditions for
running or skipping your project's tests remain your choice; reporting a state
does not transfer the source workflow's check result.

The `v1` reference is the intended published version tag; use a published
commit SHA to pin an exact version. No consumer checkout is needed.

The optional `token` input defaults to `${{ github.token }}`. It must have
`actions: read` permission in the receiving repository. SHA, workflow, branch,
PR number, and job names are not inputs.

## Outputs

Every action output is a string.

| Output | Meaning | Not found |
| --- | --- | --- |
| `found` | `'true'` when an existing push run was found | `'false'` |
| `workflow_status` | Selected attempt's API status | Empty |
| `workflow_conclusion` | API conclusion when completed | Empty |
| `run_id` | Selected workflow run ID | Empty |
| `run_attempt` | Selected attempt number | Empty |
| `jobs` | Job names mapped to arrays, encoded as JSON | `'{}'` |

An unfinished workflow has an empty `workflow_conclusion`. A found workflow
with no jobs yet returns `found: 'true'` and `jobs: '{}'`.

For example:

```json
{
  "test": [
    {"id": 123, "name": "test", "status": "completed", "conclusion": "success"},
    {"id": 456, "name": "test", "status": "in_progress", "conclusion": null}
  ]
}
```

Each name always maps to an array, even for one job. Repeated names and matrix
jobs retain every returned job. Array entries are ordered by numeric job ID;
their positions are not stable job identifiers. API job IDs are execution IDs,
not the `jobs.<job_id>` keys from workflow YAML.

Names are exact API display names. Without a job `name`, this is normally the
YAML job ID, with matrix values appended when applicable. Names containing
spaces or punctuation can be accessed with bracket notation.

### Conditions

The detection job above exposes the action's JSON as its `jobs` output.
Consumers choose their own rules, for example:

```yaml
# At least one job named test failed.
if: contains(fromJSON(needs.detect-head-checks.outputs.jobs).test.*.conclusion, 'failure')
```

```yaml
# At least one job named test is still running.
if: contains(fromJSON(needs.detect-head-checks.outputs.jobs).test.*.status, 'in_progress')
```

For a single step's output use `fromJSON(steps.detect.outputs.jobs)` instead.
A missing name is not evidence of success. Configure any aggregate CI check and
Codecov checks separately in branch protection if they must block merging.

## Selection and errors

- Search the same repository, same workflow ID, same head SHA, and `push` event.
  Do not restrict the branch or PR origin.
- Exclude the caller's own run, including when invoked by `push`.
- Fetch each candidate's latest listed attempt and compare attempt start times,
  not run IDs or prior successes. A queued attempt without a start timestamp
  uses its creation timestamp. Equal timestamps are ordered by run ID.
- Fetch jobs using the selected attempt's endpoint so a concurrent rerun does
  not mix jobs from different attempts. Results describe observed API state.
- Read all pages of runs and jobs. GitHub's filtered workflow search is limited
  to 1,000 runs. If the reported total exceeds that limit, fail rather than
  silently select a possibly incorrect attempt.
- Authentication, permissions, networking, parsing, and incomplete API responses
  fail the action. Only a successful search with no match returns not found.

This action expects a current GitHub-hosted runner supporting Node.js 24.
Custom job containers and self-hosted runner compatibility are outside its
supported scope.

## Development

```sh
npm test
npm run test:coverage
```

Node.js 24 is required. There are no npm dependencies or build artifacts:
`action.yml` executes the checked-in JavaScript directly.

## License

[MIT](LICENSE).
