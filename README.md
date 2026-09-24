# Agent Harness

Agent Harness is a portable orchestration layer for lead agents and delegated workers. It preserves the useful parts of the existing OpenCode lead workflow while allowing the lead and workers to run under different agent harnesses.

The controller launches each worker as an independent process. Every worker receives a declared role, model, harness, context bundle, filesystem policy, and output contract. Durable files under `~/workspace/lead-context` carry state between processes, sessions, and harnesses.

## Goals

- Keep one accountable lead responsible for planning, delegation, integration, and completion.
- Let the lead delegate exploration, planning, implementation, review, verification, documentation, and publication tasks.
- Select and enforce the harness and model for every worker.
- Route model traffic through LiteLLM for access control, accounting, and cost visibility.
- Resume or steer a worker when its harness supports native continuation.
- Transfer work between harnesses through a normalized checkpoint.
- Give each worker a role-appropriate sandbox, working directory, and tool set.
- Preserve an auditable record of requests, decisions, model routes, results, and corrections.
- Allow a lead session to be replaced by a lead running in another harness.

## Non-goals

- Translating private conversation state from one harness into another.
- Treating a model alias as proof of the underlying model engine.
- Depending on a harness's native subagent tree for security or portability.
- Allowing more than one writer to change the same working tree concurrently.

## Repository guide

- [Architecture](docs/architecture.md): components, control flow, state ownership, and lead behavior.
- [Task protocol](docs/protocol.md): directory layout, contracts, events, steering, continuation, and recovery.
- [Harness adapters](docs/harness-adapters.md): Codex, DeepSeek Harness, and OpenCode integration.
- [Security model](docs/security-model.md): model authorization, LiteLLM, filesystem isolation, and trust boundaries.
- [Implementation plan](docs/implementation-plan.md): phased build sequence and deliverables.
- [Validation plan](docs/validation.md): acceptance matrix and tested assumptions.
- [Live gateway testing](docs/live-testing.md): running the optional Codex-to-DeepSeek integration test.
- [Example policy](config/policy.example.yaml): portable role and model policy.
- [Example task](examples/task-0007): example request, context, status, and session files.

## Runtime roots

The implementation should use these defaults:

```text
~/workspace/agent-harness/       implementation, configuration, and documentation
~/workspace/lead-context/       durable runtime context and task records
```

The state root is configurable, but its layout and file formats remain harness independent.

## Primary interface

The controller should provide these operations to a lead through a CLI, MCP server, or thin harness skill:

```text
delegate  inspect  list  wait  steer  cancel  resume  handoff
```

Native harness subagents remain an optional execution strategy. Independent worker processes are the default because they support separate models, credentials, sandboxes, worktrees, and harnesses.

## Status

The first macOS CLI release is implemented in TypeScript. It supports `code-explorer` and `code-implementer` workers under Codex CLI and the DeepSeek Harness SDK subprocess mode. The CLI, local controller, file protocol, LiteLLM proxy, and macOS filesystem sandbox are covered by deterministic tests. Live model tests require a configured LiteLLM gateway and approved aliases.

## Quick start

Requires Node.js 24, Git, macOS `sandbox-exec`, Codex CLI, and a LiteLLM gateway whose successful responses include resolved model group, deployment ID, and attempted-fallbacks (or fallback-count) headers. Policy model keys are lowercase local aliases; `litellm_model_group` can use the gateway's display name, including spaces.

```sh
npm ci
npm run build
node dist/src/cli.js init --repo /absolute/path/to/repository --objective 'Project objective'
```

`init` creates `~/.config/agent-harness/policy.yaml` from the example if necessary. Review its allowed model aliases and set `LITELLM_BASE_URL` (including `/v1`) and `LITELLM_API_KEY`. Keep the returned `lead_id` for subsequent mutating commands, either as `AGENT_HARNESS_LEAD_ID` or `--lead-id`.

Create a YAML delegation using the [request contract](docs/protocol.md), with the returned `project_id`, `network: allow`, and an absolute repository path. Then run:

```sh
node dist/src/cli.js delegate --request /absolute/path/to/request.yaml
node dist/src/cli.js wait --task TASK_ID --timeout-ms 180000
node dist/src/cli.js inspect --task TASK_ID
node dist/src/cli.js steer --task TASK_ID --message 'Check another case'
node dist/src/cli.js handoff --task TASK_ID --harness deepseek --model APPROVED_DIFFERENT_ENGINE
```

All CLI commands return JSON on stdout and errors on stderr. `list`, `inspect`, and `wait` are read-only; `delegate`, `steer`, `cancel`, `resume`, and `handoff` require the active lead ID. Completed worktrees and task bundles remain for inspection. The first release allows worker network egress; the proxy controls access to the shared LiteLLM credential and allowed model alias. Codex and DeepSeek use the controller's outer macOS sandbox for filesystem enforcement so their shell tools can run inside their allocated checkouts.

Run `lead-release --project PROJECT_ID` with the active lead ID to release ownership immediately; otherwise another lead may acquire it after the lease expires.

Run deterministic checks with `npm test`. The optional live flow runs with `AGENT_HARNESS_LIVE=1`, `AGENT_HARNESS_TEST_CODEX_MODEL`, and `AGENT_HARNESS_TEST_DSH_MODEL` set alongside the LiteLLM environment variables.
