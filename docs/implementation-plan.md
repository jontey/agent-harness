# Implementation Plan

The first CLI release implements the local controller, Codex external-process adapter, and DeepSeek SDK subprocess adapter for exploration and implementation roles. In-process DeepSeek continuation, MCP, OpenCode migration, role-specific LiteLLM keys, and network filtering remain future phases. The live gateway validation gate passed on 2026-09-24 with approved Codex and DeepSeek Harness routes.

## 1. Delivery strategy

Build the smallest end-to-end portable path first: a file-backed controller that launches one Codex worker and one DeepSeek Harness worker through LiteLLM. Add richer isolation, MCP integration, and OpenCode migration after lifecycle and recovery behavior are stable.

The suggested implementation language is TypeScript for broad CLI and MCP support. Python is also viable if the implementation team prefers its process and schema ecosystem. The on-disk protocol must remain language independent.

## 2. Phase 0: provider and policy normalization

### Deliverables

- Stable slug aliases for every approved LiteLLM route.
- `engine_id` assigned to every route.
- Same-engine fallback groups with cross-engine fallback disabled by default.
- Pricing metadata for meaningful cost reports.
- Role-specific virtual keys or a documented key-isolation strategy.
- Initial `policy.yaml` based on `config/policy.example.yaml`.

### Exit criteria

- Every approved alias completes a minimal Responses or Chat Completions call through LiteLLM.
- Requested and resolved route metadata can be collected.
- Disallowed aliases are rejected by the relevant virtual key.
- Cost is nonzero or explicitly marked unavailable for each priced route.

## 3. Phase 1: protocol and local controller

### Deliverables

- Configuration loader and schema validation.
- Project and task ID allocation.
- Task directory creation under `~/workspace/lead-context`.
- Atomic `status.json` writes.
- Locked append-only `events.jsonl` writes.
- Lead, writer, and resume leases.
- CLI commands:

```text
agent-harness init
agent-harness delegate
agent-harness list
agent-harness inspect
agent-harness wait
agent-harness steer
agent-harness cancel
agent-harness resume
agent-harness handoff
```

- Adapter interface and a deterministic fake adapter for lifecycle tests.

### Exit criteria

- Controller restart recovers queued and running task records.
- Concurrent readers do not corrupt status or events.
- A conflicting writer request is rejected.
- Steering delivery is idempotent.

## 4. Phase 2: Codex adapter

### Deliverables

- Isolated per-worker Codex configuration.
- LiteLLM provider and curated model catalog generation.
- Read-only and workspace-write process profiles.
- Native session ID capture.
- Resume, steer, cancel, and result collection.
- Provider route evidence collection.
- Git worktree integration.

### Exit criteria

- A lead can launch a Codex explorer using an approved model.
- A Codex implementer edits only its worktree.
- A read-only Codex worker cannot modify source.
- The same Codex session accepts a correction after resume.
- An unapproved model fails before the worker starts.
- A cross-engine fallback produces a policy failure.

## 5. Phase 3: DeepSeek Harness adapter

### Deliverables

- Custom LiteLLM provider generation.
- In-process continuable execution mode.
- SDK subprocess isolation mode.
- Explicit capability flags describing continuation differences.
- Checkpoint-based correction flow for one-shot SDK workers.

### Exit criteria

- An in-process worker can be steered and resumed.
- An SDK worker runs with a role-specific profile and environment.
- A one-shot SDK correction receives the complete prior checkpoint and artifacts.
- Both modes report the requested and resolved model route.

## 6. Phase 4: portable lead integration

### Deliverables

- MCP server exposing the controller operations.
- Thin skills/instructions for Codex, DeepSeek Harness, and OpenCode leads.
- Project bootstrap command that writes objective, constraints, and current state.
- Lead lease acquisition and takeover flow.
- Summarized task index for efficient context restoration.

### Exit criteria

- A Codex lead delegates to a DeepSeek Harness worker.
- A DeepSeek Harness lead inspects and steers a Codex worker.
- A replacement lead reconstructs current work from files and continues without the previous native lead session.

## 7. Phase 5: OpenCode migration

### Deliverables

- Update the OpenCode lead to use `~/workspace/lead-context`.
- Permit delegation to `code-explorer-*`.
- Add controller tool access.
- Import existing role prompts as templates.
- Optional migration tool for active bundles from `~/.config/opencode/lead-context`.

### Migration behavior

Do not move or delete the existing directory automatically. The migration command should copy selected active bundles, verify checksums, record their origin, and leave the source intact until the user explicitly requests cleanup.

### Exit criteria

- Existing OpenCode workflows can use the new context root.
- Old bundles remain readable.
- A task begun in OpenCode can be handed to a Codex or DeepSeek Harness worker through a checkpoint.

## 8. Phase 6: stronger isolation and operations

### Deliverables

- macOS sandbox profile or container backend.
- Network destination policy.
- Log redaction and rotation.
- Metrics for task duration, model use, cost, failures, retries, and fallback violations.
- Garbage collection command with dry-run and explicit retention policy.
- Diagnostic command for stale sessions and leases.

### Exit criteria

- Isolation tests demonstrate denied writes and network access.
- Crash recovery works after forced controller and worker termination.
- Audit records identify every model route and permission decision.

## 9. Suggested module structure

```text
src/
├── cli/
├── controller/
│   ├── lifecycle
│   ├── policy
│   ├── events
│   ├── leases
│   └── recovery
├── adapters/
│   ├── codex
│   ├── deepseek
│   ├── opencode
│   └── fake
├── workspace/
│   ├── git-worktree
│   ├── readonly
│   └── sandbox
├── provider/
│   └── litellm
├── protocol/
│   ├── schemas
│   └── migrations
└── mcp/
```

## 10. Initial vertical slice

The first demonstrable workflow should be:

1. Initialize a project under `~/workspace/lead-context`.
2. Delegate a read-only exploration task to Codex using a chosen LiteLLM alias.
3. Observe progress and route metadata.
4. Steer and resume the Codex session.
5. Create a checkpoint.
6. Hand the same task to DeepSeek Harness using another approved model.
7. Complete the task and integrate its result into project state.
8. Restart the controller and show that the completed lineage remains inspectable.

This slice tests the central value of the design before adding every role.

## 11. Implementation risks

| Risk | Response |
|---|---|
| Harness output format changes | Keep parsing in versioned adapters and prefer structured output modes |
| Native session IDs are hard to capture | Persist process logs and support checkpoint replacement |
| Provider headers are unavailable to the harness | Add LiteLLM-side audit lookup keyed by request metadata |
| Model performs poorly as an orchestrator | Qualify models per role with delegation fidelity tests |
| Worktree cleanup removes useful evidence | Retain task metadata and require explicit cleanup policy |
| File protocol evolves | Version every contract and add forward migrations |
| Shared filesystem races | Per-task locks, atomic rename, append discipline, and lease tests |

## 12. Definition of done

The initial product is complete when the acceptance matrix in `validation.md` passes for Codex CLI, Codex Desktop as a lead, DeepSeek Harness as a lead and worker, and OpenCode compatibility mode; all model calls route through LiteLLM; and a task can survive process restart and cross-harness handoff without losing its durable context.
