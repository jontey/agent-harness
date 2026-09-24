# Task and State Protocol

## 1. State layout

```text
~/workspace/lead-context/
├── index.json
├── projects/
│   └── <project-id>/
│       ├── project.json
│       ├── objective.md
│       ├── constraints.md
│       ├── decisions.md
│       ├── current-state.md
│       ├── task-index.json
│       └── artifacts/
├── tasks/
│   └── <task-id>/
│       ├── request.yaml
│       ├── context.md
│       ├── status.json
│       ├── events.jsonl
│       ├── session.json
│       ├── workspace.txt
│       ├── sandbox.sb
│       ├── route-summary.json
│       ├── checkpoint.md
│       ├── result.md
│       ├── attempts/
│       │   └── <attempt-id>/
│       │       ├── request.yaml
│       │       ├── prompt.md
│       │       ├── result.md
│       │       ├── checkpoint.md
│       │       └── launch.ready
│       ├── steering/
│       ├── artifacts/
│       └── logs/
└── orchestrator/
    ├── workers.json
    └── locks/
```

The controller also keeps per-task Git worktrees under `workspaces/<task-id>/`. Attempt homes and logs live under each attempt directory. Task bundles and worktrees are retained until explicitly cleaned up.

Task directories are never reused for a different objective. Retries and replacement sessions remain within the same task directory and are represented in the event stream and session history.

## 2. Identifiers

- `project_id`: stable slug plus short digest of the canonical repository path.
- `task_id`: sortable unique identifier, such as UUIDv7, with an optional readable slug.
- `session_id`: opaque harness identifier.
- `attempt_id`: one process or native-session attempt within a task.
- `steering_id`: monotonic sequence within a task.
- `event.seq`: monotonic integer allocated under the task lock.

Identifiers must not contain secrets or raw prompts.

## 3. Request contract

`request.yaml` is immutable after the worker starts. It describes the initial delegation. Each `attempts/<attempt-id>/request.yaml` is an immutable effective launch record containing the harness, model, workspace, kind (`initial`, `resume`, `correction`, or `handoff`), optional steering ID, and prompt path. Handoff and correction keep the task ID and create a new attempt. A materially different objective creates a new task linked through `supersedes`.

Required fields:

```yaml
schema_version: 1
task_id: task-0007
project_id: example-a1b2c3
role: code-explorer
harness: codex
model: north-mini-code
reasoning_effort: high
objective: Trace how authentication state reaches the API client.
scope:
  include: [src/auth, src/api]
  exclude: [vendor, generated]
acceptance_criteria:
  - Identify the state owner and all transformation boundaries.
  - Cite relevant files and symbols.
permissions:
  filesystem: read-only
  network: allow
  tools: [file-read, search, shell-read]
workspace:
  strategy: read-only-checkout
  repository: /absolute/path/to/repository
  git_ref: abc123
parent:
  task_id: lead-0001
output_contract:
  result: result.md
  checkpoint: checkpoint.md
  events: events.jsonl
```

The original user requirement and material corrections are included verbatim in `context.md` or referenced project artifacts.

## 4. Status contract

`status.json` is a current snapshot written atomically. The writer creates a temporary file in the same directory, flushes it, and renames it over the previous snapshot.

```json
{
  "schema_version": 1,
  "task_id": "task-0007",
  "state": "running",
  "attempt_id": "attempt-01",
  "revision": 8,
  "updated_at": "2026-09-24T10:31:00Z",
  "heartbeat_at": "2026-09-24T10:31:00Z",
  "summary": "Tracing token refresh callers",
  "needs_input": false,
  "terminal": false
}
```

States:

```text
queued -> starting -> running -> waiting_for_input -> running
running -> completed | failed | cancelled
completed | failed | cancelled -> starting  (explicit new attempt)
```

`completed`, `failed`, and `cancelled` are terminal for an attempt. The task status reflects the current attempt, so an explicit correction, resume, or handoff can advance it to `starting` again.

## 5. Event contract

`events.jsonl` is append-only. Each line contains one JSON object:

```json
{"seq":1,"at":"2026-09-24T10:30:00Z","type":"worker.started","attempt_id":"attempt-01"}
{"seq":2,"at":"2026-09-24T10:30:20Z","type":"progress","summary":"Located authentication entry point"}
{"seq":3,"at":"2026-09-24T10:30:50Z","type":"provider.route","requested":"north-mini-code","resolved_group":"north-mini-code","deployment_id":"deployment-17","fallback_count":0}
{"seq":4,"at":"2026-09-24T10:31:10Z","type":"worker.completed","result":"result.md"}
```

Core event types:

- `task.created`
- `policy.approved` and `policy.rejected`
- `workspace.created`
- `worker.started`, `worker.heartbeat`, `worker.completed`, `worker.failed`, `worker.cancelled`
- `progress`
- `input.requested`
- `steering.queued`, `steering.delivered`, `steering.acknowledged`, `steering.failed`
- `session.resumed`
- `provider.route`
- `checkpoint.created`
- `handoff.started`, `handoff.completed`, `handoff.failed`
- `lease.acquired`, `lease.renewed`, `lease.released`, `lease.expired`
- `policy.violation`

Events may reference a log or artifact path. They should not embed large command output, source files, prompts, credentials, or environment dumps.

## 6. Session contract

`session.json` contains current and previous attempts:

```json
{
  "schema_version": 1,
  "current_attempt_id": "attempt-01",
  "attempts": [
    {
      "attempt_id": "attempt-01",
      "harness": "codex",
      "native_session_id": "opaque-value",
      "pid": 12345,
      "process_started_at": "2026-09-24T10:30:00Z",
      "requested_model": "north-mini-code",
      "resolved_model_group": "north-mini-code",
      "resolved_deployment_id": "deployment-17",
      "fallback_count": 0,
      "continuation_supported": true,
      "state": "running"
    }
  ]
}
```

Process identity should include a start time or platform-specific birth identifier so PID reuse cannot make a stale worker appear active.

The first release records the detached supervisor PID and macOS process birth value. The supervisor writes status and heartbeat records while the initiating CLI is gone. A later CLI call reconciles a missing or reused supervisor PID to a failed attempt. The worker waits for `launch.ready` before touching session state, closing the launch-record race.

## 7. Context contract

`context.md` should be concise and evidence based:

1. Original requirement and corrections
2. Scope and explicit exclusions
3. Current repository state
4. Known architecture and relevant symbols
5. Evidence and source references
6. Constraints and policy requirements
7. Acceptance criteria
8. Unknowns
9. Prior related decisions or task results

A path alone is insufficient. Delegations must include or explicitly load the relevant content.

## 8. Result contract

`result.md` contains:

1. Outcome summary
2. Work performed
3. Files, symbols, or artifacts affected
4. Evidence and commands
5. Acceptance-criterion results
6. Deviations from request or plan
7. Remaining risks and unknowns
8. Recommended next action

Implementers additionally report the Git diff and commit state. Reviewers use severity-tiered findings with file and line references. Verifiers distinguish observed evidence from inherited claims.

## 9. Checkpoint contract

`checkpoint.md` is mandatory before a planned cross-harness handoff and should be updated at useful milestones for long-running tasks.

It contains:

- objective and success conditions;
- present state and completed steps;
- decisions and reasons;
- evidence and artifact references;
- failed approaches;
- unresolved questions;
- repository and worktree state;
- pending messages;
- next recommended action.

## 10. Steering

The lead writes steering messages under `steering/` before asking the adapter to deliver them:

```yaml
schema_version: 1
steering_id: 3
created_at: 2026-09-24T10:40:00Z
author: lead-session-id
message: Also inspect refresh-token handling.
```

Delivery is idempotent by `steering_id`. The adapter records its native delivery reference when available. A restarted controller retries queued messages that lack a delivery receipt.

For the first release, steering queued during a running turn starts a correction attempt after that turn finishes. Codex resumes its native session; DeepSeek Harness starts a new SDK subprocess with the checkpoint. Recovery compares steering IDs to immutable attempt requests so a delivered message is not replayed even if its delivery event was lost.

## 11. Leases and locks

Use short-lived renewable leases for:

- project lead ownership;
- branch or worktree writer ownership;
- task event sequence allocation;
- session resume ownership.

`init` returns a `lead_id` and acquires the project lead lease. Mutating CLI commands require that ID through `AGENT_HARNESS_LEAD_ID` or `--lead-id` and renew its lease. A new lead may acquire the project after expiry by running `init` again.

Lease files include owner, host, PID identity, acquisition time, heartbeat, expiry, and resource. All changes occur under an atomic filesystem lock. Stale leases can be reclaimed after expiry and process validation.

## 12. Failure recovery

On controller restart:

1. scan nonterminal task statuses;
2. validate process identities and native sessions;
3. mark missing workers stale;
4. collect any completed result that was not indexed;
5. retry undelivered steering messages only when idempotency is known;
6. resume supported native sessions or create a checkpoint-based replacement;
7. release expired leases after validation.

Every adapter failure must produce a terminal attempt event. Silent fallback to another harness or model is forbidden.

## 13. Retention and redaction

Completed task bundles are retained for audit and resumption. Cleanup requires an explicit retention command or user request.

Never persist:

- API keys or authorization headers;
- complete environment dumps;
- unrelated user files;
- full provider responses when a concise structured record is sufficient;
- secrets found in source or command output.
