# Validation Plan and Evidence

## 1. User requirements traceability

| Requirement | Architecture mechanism | Acceptance evidence |
|---|---|---|
| Lead remains accountable | Lead contract, project state, lead lease | Replacement lead reconstructs work and makes the next correct delegation |
| Delegate code exploration | `code-explorer` role | Explorer returns cited source findings without writing source |
| Choose worker harness | Adapter selected in `request.yaml` | Same task can launch under Codex or DeepSeek Harness |
| Choose worker model | Model selected in request | Provider evidence matches the requested permitted route |
| Enforce role model choices | Controller policy plus LiteLLM key | Disallowed request fails before model execution |
| Use LiteLLM upstream | Adapter provider configuration | Usage record contains task metadata, tokens, and cost |
| Different models for adjacent stages | Resolved `engine_id` comparison | Same-engine next stage is rejected when the rule is enabled |
| Resume worker context | Native session adapter | Same worker answers a correction using earlier context |
| Steer active work | Durable steering queue | Message is delivered once and acknowledged |
| Monitor progress | Status, heartbeat, and events | Lead observes progress without reading raw terminal state |
| Change harness during a task | Portable checkpoint | Destination harness continues from checkpoint and artifacts |
| Change lead harness | Project state plus lead lease | New lead resumes without prior native lead session |
| Role-specific sandbox | Separate process/worktree/isolation profile | Read-only writes fail; implementer writes only its worktree |
| Review and verification loops | Persistent task lineage and steering | Findings return to implementer and are independently rechecked |
| Recover from crashes | Atomic files, events, leases, checkpoint | Forced restart results in correct resumed or failed state |

## 2. Common conformance suite

Every harness adapter must pass:

1. Start a task with a permitted role and model.
2. Reject or visibly fail an unknown model.
3. Produce a native session record and process identity.
4. Write progress and terminal events in order.
5. Produce `result.md` and `checkpoint.md`.
6. Cancel a running worker and reach a terminal attempt state.
7. Resume when declared supported.
8. Deliver steering exactly once when declared supported.
9. Preserve output after controller restart.
10. Report effective sandbox and provider route.

## 3. Policy tests

- Reject an undefined role.
- Reject a model outside the role allowlist.
- Reject a harness outside the role allowlist.
- Reject permissions broader than the role maximum.
- Reject a second writer for the same branch or worktree.
- Reject an adjacent stage that resolves to the same engine when diversity is required.
- Reject a cross-engine fallback.
- Permit same-engine redundant deployment fallback when configured.
- Expire and safely reclaim a stale lease.
- Prevent repository content from modifying controller policy.

## 4. Sandbox tests

For each read-only adapter profile:

- attempt to create, edit, rename, and delete a source file;
- attempt to write build output inside the source tree;
- verify task artifact writes remain possible;
- verify network policy;
- verify shell escape paths do not bypass the boundary.

For writable roles:

- verify writes land only in the allocated worktree;
- verify the original checkout remains unchanged;
- verify unexpected source changes by a verifier are detected;
- verify concurrent worktrees cannot share a writer lease accidentally.

## 5. Model route tests

For every approved alias and role:

- simple completion;
- structured output compliance;
- tool call fidelity;
- long-context task artifact reading;
- requested versus resolved route match;
- fallback count and deployment identity capture;
- token and cost reporting;
- timeout, overload, and unavailable-route behavior.

Models intended for the lead role additionally must correctly form delegation calls, interpret task statuses, and avoid bypassing policy after a rejected request.

## 6. Lifecycle tests

- Controller dies after request creation but before process launch.
- Controller dies after launch but before recording the session ID.
- Worker dies without writing a final status.
- Worker writes a result immediately before controller failure.
- PID is reused by an unrelated process.
- Steering is queued during a controller restart.
- Two leads attempt to acquire the same lease.
- A resumed native session is unavailable.
- A handoff destination fails after the source checkpoint is written.

Each case must end in a deterministic recoverable state with no silent task loss.

## 7. Cross-harness scenarios

### Scenario A: Codex to DeepSeek Harness

1. Codex explores a repository through LiteLLM.
2. The lead steers it once.
3. Codex writes a checkpoint.
4. DeepSeek Harness continues using a different approved engine.
5. The result cites earlier evidence and records its new native session.

### Scenario B: DeepSeek Harness to Codex

1. A DSH planner creates a bounded plan.
2. A one-shot isolated DSH process completes and exits.
3. Codex implements from the plan and checkpoint in a new worktree.
4. Review findings return to the same Codex session.

### Scenario C: lead replacement

1. An OpenCode lead starts an implementation pipeline.
2. The lead releases or loses its lease.
3. A Codex lead reads durable state and acquires the lease.
4. It identifies the correct active task and next action.
5. No duplicate implementation worker is launched.

## 8. Evidence already obtained

The design is based on direct tests performed before this plan was written.

### Codex

- Codex CLI 0.156.0 and the Codex Desktop bundled CLI were inspected.
- A Codex parent routed through LiteLLM and spawned a fixed-model custom child using `LFM 2.5 2.6b` successfully.
- Native explicit selection of an arbitrary alias absent from the Codex model catalog failed before spawn.
- A native child declared read-only wrote a marker file when the parent used workspace-write, confirming shared effective sandbox behavior.
- Fixed custom roles provide a single-model lock; native role-specific model sets require variants or an external controller.

### DeepSeek Harness

- Focused upstream tests covering model selection, subagents, sandbox inheritance, continuation, SDK execution, personas, tool filters, and custom providers passed.
- An end-to-end child ran through the user's LiteLLM gateway and returned successfully using `LFM 2.5 2.6b`.
- In-process children support continuation while inheriting the parent sandbox override.
- SDK subprocesses support distinct profiles and environments but use one-shot correction through a new run.

### LiteLLM

- The gateway exposed the current OpenCode aliases.
- Direct Responses calls and a Codex CLI call succeeded through the gateway.
- A requested Kimi alias resolved to a different engine after fallback, demonstrating the need to validate resolved routes.
- LiteLLM response headers exposed call ID, resolved group, deployment ID, and fallback count.
- The tested LFM route reported zero cost, so pricing metadata needs review before relying on spend totals.

## 9. Release gates

The first usable release requires:

- all common protocol and recovery tests;
- Codex and DeepSeek adapter conformance;
- read-only and writable workspace enforcement;
- model allowlist and resolved-route validation;
- durable steering and at least one native continuation path;
- cross-harness checkpoint handoff;
- LiteLLM usage attribution;
- lead takeover without duplicate work.

OpenCode migration and stronger container isolation may follow as separate milestones, but their protocol requirements should remain stable from the first release.

## 10. First-release checks

`npm test` exercises policy rejection, concurrent event ordering, atomic status files, conflicting leases, fake-worker correction and handoff, recovery after supervisor loss, a mock LiteLLM proxy, macOS sandbox write denials, isolated Codex and DeepSeek smoke tests, and a complete Codex correction to DeepSeek handoff through the controller and mock gateway. The optional live test is gated by `AGENT_HARNESS_LIVE=1`, LiteLLM credentials and URL, and two approved model groups. On 2026-09-24 the full suite passed 12/12, including live Codex correction and DeepSeek Harness handoff. A separate self-delegation ran a Codex source review and a DeepSeek Harness implementer in a dedicated worktree; the proxy also rejected a real cross-engine LiteLLM fallback.
