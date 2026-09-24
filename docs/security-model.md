# Security and Enforcement Model

## 1. Security objectives

The controller must ensure that a worker can use only the approved model routes, tools, files, network access, and source workspace. It must also retain enough evidence to detect policy drift and silent provider fallback.

Prompt instructions improve behavior but do not constitute enforcement.

## 2. Layered controls

```text
1. LiteLLM virtual key and budget
2. Controller role/model/harness policy
3. Harness tool filtering
4. Harness sandbox
5. Separate process and Git worktree
6. OS sandbox, container, remote worker, or microVM when required
```

Each layer addresses a different risk. A filesystem sandbox does not restrict the provider model. A model allowlist does not prevent source writes. Tool filtering does not prevent a permitted shell from accessing the operating system beyond its intended scope.

## 3. Model authorization

### 3.1 Portable aliases

Use stable lowercase slugs without spaces:

```text
minimax-m3
laguna-s-2-1
north-mini-code
nemotron-ultra
nemotron-lightning
glm-flash
kimi-code
lfm-2-5-2-6b
```

Each alias maps to policy metadata:

```yaml
models:
  north-mini-code:
    engine_id: north-mini
    litellm_model_group: north-mini-code
    permitted_fallback_engines: []
```

### 3.2 Enforcement points

Before launch, the controller checks `role x harness x model`. The worker receives a LiteLLM virtual key whose model allowlist is equal to or narrower than the controller decision.

After each model call or task, the controller records:

- requested alias;
- resolved model group;
- resolved deployment ID;
- fallback count;
- token usage and cost;
- role, task, project, harness, and attempt IDs.

If the resolved engine is outside policy, the attempt fails even when the model response appears successful.

### 3.3 Fallback policy

Testing found that a request for the `Kimi K2.7 Code` alias resolved to `Grok 4.6` after fallbacks. Therefore aliases cannot enforce engine diversity by themselves.

Default policy:

- disable cross-engine fallbacks for role aliases;
- permit multiple deployments only when they represent the same declared engine;
- fail visibly when the approved route is unavailable;
- allow cross-engine fallback only through an explicit policy entry and record it as a distinct engine for adjacency rules.

### 3.4 Adjacent-stage diversity

When enabled, sequential stages must use different `engine_id` values. Compare the resolved engine from the completed stage with the requested and permitted engine for the next stage. Do not compare display names or aliases.

## 4. Credentials

The controller injects credentials into the worker process environment. It stores credential references or key IDs, never the secret values.

Preferred model:

- one LiteLLM virtual key per role or task class;
- budgets and model allowlists applied to each key;
- metadata tags for project, task, attempt, role, and harness;
- short-lived credentials where supported;
- publication credentials provided only to the publication worker after authorization.

Native in-process children that inherit a parent key cannot receive a narrower key. Use a separate process when key isolation matters.

The first release uses one shared LiteLLM key in the supervisor. Each worker sees only a random per-attempt token for a loopback proxy. The proxy accepts the approved alias, forwards to LiteLLM, and records resolved group, deployment, fallback count, and usage when available. The shared key is removed from worker environments. Role-specific virtual keys remain a later hardening step.

## 5. Filesystem isolation

### 5.1 Read-only roles

Explorer, planner, and reviewer receive read-only source access and a writable task artifact directory. Their harness state and caches should live outside the source checkout.

### 5.2 Writable roles

Implementers receive a dedicated Git worktree. Policy records the allowed repository, base revision, branch, and optional path scopes. The controller snapshots the initial Git state and validates the final diff.

Documentation writers use a writable worktree with path policy focused on documentation and configuration files.

### 5.3 Verification

Verifiers receive a disposable writable worktree so builds and tests can create files. The controller compares source state before and after execution and rejects unapproved source changes.

### 5.4 Strong isolation

Use an OS sandbox, container, remote worker, or microVM for untrusted repositories, risky build scripts, network-sensitive tasks, or roles needing strict process boundaries. The policy chooses the isolation backend; adapters do not weaken it.

## 6. Network policy

Network access is denied by default for source exploration, planning, and review. Enable it for dependency installation, external research, or remote services through explicit task policy. Where possible, restrict destinations to the LiteLLM gateway and approved package registries.

The first release deliberately uses `network: allow` for its two supported roles. macOS sandbox profiles restrict filesystem writes, but worker network egress is unrestricted. The policy and request must declare this accurately; destination filtering is not part of this release.

The DeepSeek adapter enables its internal shell tools with a per-attempt `danger-full-access` SDK patch. The outer `sandbox-exec` profile remains the filesystem boundary: explorer shell writes to the source checkout fail, and implementer shell writes to the original checkout fail. This configuration does not restrict network egress.

## 7. Tool policy

Roles declare capabilities such as:

```text
file-read  file-write  search  shell-read  shell-write
test-run  network  git-read  git-write  publish
```

Adapters map portable capabilities to harness tools. Adapter conformance tests verify that denied capabilities are absent or rejected. A shell capability is treated as broad operating-system access unless an external sandbox narrows it.

## 8. One-writer rule

The controller grants an exclusive writer lease for each branch or worktree. Parallel writers must use different worktrees and declared integration boundaries. The lead cannot override this through prompt text.

## 9. Audit and privacy

Persist enough information to reconstruct delegation and authorization decisions:

- request and corrections;
- policy decision and version;
- workspace identity and Git state;
- harness, model route, tokens, and cost;
- steering and lifecycle events;
- result, review, and verification artifacts.

Redact secrets and avoid storing unrelated source content or raw environment dumps. Command logs should be size limited and rotated while preserving referenced evidence.

## 10. Threats and mitigations

| Threat | Control |
|---|---|
| Worker selects an unapproved model | Controller preflight plus LiteLLM key allowlist |
| Provider silently changes engine | Resolved route and fallback validation |
| Read-only worker edits source | Separate process plus read-only mount or OS sandbox |
| Two implementers overwrite work | Exclusive writer lease and separate worktrees |
| Crashed worker remains marked active | Heartbeat, process birth identity, and lease expiry |
| Steering is lost | Persist before delivery with idempotent sequence |
| New harness cannot resume old session | Portable checkpoint and new native session |
| Malicious repository instructions alter policy | Policy is outside repository and evaluated by controller |
| Secret appears in logs | Structured capture, redaction, and environment allowlist |
| Native child inherits excessive authority | Use external worker process |
