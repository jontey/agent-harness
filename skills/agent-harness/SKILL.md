---
name: agent-harness
description: Delegate and manage local code exploration or implementation through the Agent Harness CLI, including task status, steering, output, and cross-harness handoff. Use when the user asks to use this harness or to manage its existing tasks.
---

# Agent Harness

Use the TypeScript CLI in the repository two directories above this skill (`dist/src/cli.js`). Read that repository's `README.md` and `docs/protocol.md` when the request contract or command behavior is unclear. The current first release runs on macOS and supports `code-explorer` and `code-implementer` with `codex` or `deepseek`.

## Prepare

- Resolve the target repository to an absolute path. Read `~/.config/agent-harness/policy.yaml` (or the user-selected policy outside the target repository) for allowed roles, harnesses, model aliases, tools, and engine IDs. Pass `--policy <path>` on CLI calls when using a non-default policy. Do not infer allowed models from examples.
- Build the CLI with `npm run build` in the harness repository if `dist/src/cli.js` is missing or stale. Keep the gateway URL and key in environment variables named by policy; never put the key in a request, skill file, task artifact, command output, or commit.
- For read-only `list`, `inspect`, `wait`, and `output`, no lead lease is needed. For mutating operations, use the `lead_id` returned by `init` as `--lead-id` or `AGENT_HARNESS_LEAD_ID`. If another lead holds the lease, do not overwrite it.

## Delegate

1. Run `node <harness-repo>/dist/src/cli.js init --repo <absolute-target-repo> --objective <project-objective>` if a project/lead lease is needed. Keep its `project_id` and `lead_id` for subsequent commands. `init` may reuse an existing project after its prior lease expires.
2. Write a YAML request outside the target repository. Use the policy's exact lowercase model alias and tools. For an explorer use `read-only` with `read-only-checkout`; for an implementer use `workspace-write` with `git-worktree`. The first release requires `network: allow` and has unrestricted worker egress. Include concrete acceptance criteria and enough context for an independent worker; pass a context file with `--context` when useful.
3. Run `delegate --request <absolute-request-file> --lead-id <lead-id>`. The CLI returns JSON with `task_id`. The original request is immutable; corrections and handoffs create later attempts.

Minimal request shape:

```yaml
schema_version: 1
project_id: PROJECT_ID
role: code-explorer
harness: codex
model: APPROVED_ALIAS
objective: Examine a specific question in the repository.
acceptance_criteria:
  - Report findings with file and symbol references.
permissions:
  filesystem: read-only
  network: allow
  tools: [file-read, search]
workspace:
  strategy: read-only-checkout
  repository: /absolute/path/to/repository
```

## Monitor and continue

- `list --project <project-id>` shows state, current harness, selected model, and resolved model group when available.
- `wait --task <task-id> --timeout-ms <milliseconds>` waits for a terminal state or timeout and reports the current harness and model. `inspect --task <task-id>` gives the full attempt history and events.
- `output --task <task-id>` reads the latest captured harness log. Add `--source result` for the final answer, `--source stderr|error|supervisor|routes` for diagnostics, `--attempt attempt-01` for earlier work, or `--lines N` for the last 1–1000 log lines. Repeat while running to see new output.
- Use `steer --task <task-id> --message <correction> --lead-id <lead-id>` for a material correction. Codex resumes its native session; DeepSeek starts a new attempt from the checkpoint. Inspect the new attempt before treating steering as complete.
- Use `handoff --task <task-id> --harness <codex|deepseek> --model <approved-alias> --lead-id <lead-id>` after a terminal attempt with a checkpoint. The policy may require a different engine. `resume` starts a new attempt after a terminal one; `cancel` stops active work. Choose these operations to advance the user's task, not merely because they exist.

Review the worker's result, route evidence, and actual worktree diff before integrating implementation changes. Report the selected harness and model, the resolved group when recorded, the task ID, and the outcome to the user. If a route is missing or a fallback is rejected, treat the attempt as failed and inspect its error/output records.
