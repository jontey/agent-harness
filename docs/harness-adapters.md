# Harness Adapters

## 1. Common adapter behavior

Every adapter must:

- accept a validated portable task request;
- run in a controller-prepared workspace and environment;
- route through the configured LiteLLM endpoint when supported;
- capture the native session ID without exposing credentials;
- produce structured progress and terminal status;
- write or collect `result.md` and `checkpoint.md`;
- support cancellation;
- report whether live steering, resume, and native continuation are supported;
- preserve raw harness logs under the task log directory with redaction;
- fail visibly when the requested model or permission profile cannot be applied.

Adapters must never silently broaden permissions or replace the requested model.

The first release runs each adapter inside a detached, macOS-sandboxed supervisor. It supports `code-explorer` and `code-implementer` only. The supervisor owns a local per-attempt LiteLLM proxy and writes portable results from the harness's final response.

## 2. Codex CLI adapter

### 2.1 Recommended mode

Launch a separate Codex CLI process for each worker. Generate an isolated Codex home or explicit configuration for the process. Configure:

- the LiteLLM-compatible provider;
- the requested model alias;
- reasoning effort;
- sandbox mode;
- working directory;
- task-specific instructions and output contract.

The adapter captures the Codex thread or session ID and stores it as an opaque native session ID.

### 2.2 Continuation and steering

Use native resume when available. The steering prompt should point to the persisted steering file and repeat its material contents. The adapter records successful delivery before advancing the steering cursor.

A long-lived PTY can provide lower-latency interaction. Session resume is the simpler default because it survives controller restarts and does not require an attached terminal.

The implemented adapter uses `codex exec --json` and stores the thread ID from `thread.started`. Correction attempts use `codex exec resume` and share a task-level isolated `CODEX_HOME`; the proxy endpoint in that home is updated for each attempt.

### 2.3 Model selection

Tests against Codex CLI 0.156.0 established:

- a fixed custom-agent model can call an arbitrary LiteLLM alias;
- an explicit model passed to native `spawn_agent` must appear in Codex's available model catalog;
- a custom role with a fixed model acts as a hard single-model binding;
- native children inherit the parent provider configuration;
- native role configuration does not provide a role-specific set of allowed models.

The external-process adapter avoids these native-child limits. It supplies the requested model in the worker process configuration and enforces the allowed set before launch. If Codex still requires a catalog entry, the adapter supplies a curated `model_catalog_json` generated from controller policy.

Use stable slug aliases such as `north-mini-code`; aliases containing spaces can produce unknown-model metadata warnings.

### 2.4 Sandbox limitation

Tests showed that a native Codex child declared read-only could write when its parent ran with workspace-write. Installed source confirmed that the effective parent permission profile is reapplied to native children.

Consequently, workers needing different filesystem permissions must use separate Codex processes, worktrees, or external sandboxes. Native children are suitable only when sharing the parent permission profile is acceptable.

### 2.5 Desktop use

Codex Desktop uses the same task state and core CLI behavior for these purposes. The controller remains an external service or CLI. A Desktop lead invokes it through an MCP tool or shell-backed skill. Worker progress appears through controller artifacts unless a future Desktop API exposes attachable worker sessions.

## 3. DeepSeek Harness adapter

### 3.1 In-process option

DeepSeek Harness supports in-process child spawning with provider, model, and reasoning selection when model selection is enabled. Continuable children can receive later messages and can cold-resume.

Use this mode when:

- parent and child may share the same sandbox and provider environment;
- native continuation is valuable;
- the task does not require a role-specific process boundary.

The model allowlist is session-wide. Pure inheritance and fixed tool defaults can bypass the selectable route list by design, so the controller still validates the resolved route.

### 3.2 SDK subprocess option

The DSH SDK can start a fresh subprocess with its own profile, provider, model, tools, environment, and sandbox. This is the preferred option for role isolation.

Current limitation: SDK subprocess runs are one-shot and do not provide the same continuable child messaging interface. Corrections start a new run with the full artifact bundle and latest checkpoint.

The first release uses the official `@deepseek-ai/dsh-sdk-client` and same-version `@deepseek-ai/dsh` packages, pinned together. It creates an isolated DSH home and per-attempt profile patch with a single `litellm` route using `openai-completions`. The SDK subprocess receives the task workspace and a proxy token, while the supervisor retains the shared LiteLLM key. Live gateway conformance remains an environment-dependent release check.

### 3.3 Role configuration

Multiple fixed-model tools may represent distinct roles. A dynamic role-specific set of models still belongs in the controller because the in-process allowlist applies to the whole session rather than one role.

`toolFilter` reduces the available tool surface and rejects denied calls. It does not provide OS-level isolation.

### 3.4 LiteLLM

An end-to-end test verified:

```text
DeepSeek Harness -> native spawned child -> LiteLLM -> LFM 2.5 2.6b
```

The test used a custom `litellm` provider with the `openai-completions` protocol. Both parent and child completed successfully. Start with this protocol for the current gateway, then smoke-test every approved alias and tool-calling role.

## 4. OpenCode adapter

The first OpenCode adapter can preserve the existing agent definitions while moving durable context to `~/workspace/lead-context`.

Two execution modes are possible:

1. Existing native task agents for compatibility.
2. External worker processes launched by the controller for consistent cross-harness behavior.

The lead instructions should change in these ways:

- allow `code-explorer-*` delegation;
- replace the fixed `~/.config/opencode/lead-context` path with `~/workspace/lead-context` or a configured absolute path;
- call controller operations for model and sandbox enforcement;
- record native task IDs inside the portable session contract;
- preserve the current artifact bundle and correction-loop behavior.

Agent files can remain as role prompt sources. The controller may import and normalize them into role templates rather than duplicating their instructions.

## 5. Capability matrix

| Capability | Codex external process | Codex native child | DSH in-process | DSH SDK process | OpenCode native task |
|---|---:|---:|---:|---:|---:|
| Select worker model | Yes | Catalog/fixed-role limits | Yes | Yes | Via role variants |
| Role-specific model set | Controller | No | Controller | Controller | Variants |
| Separate LiteLLM key | Yes | No | Usually shared | Yes | Depends on process setup |
| Separate sandbox | Yes | No within one tree | Inherits parent override | Yes | Agent/tool policy; verify OS boundary |
| Native continuation | Yes | Yes | Yes | No one-shot continuation | Yes |
| Durable steering | Controller | Native plus controller | Native plus controller | New run from checkpoint | Native plus controller |
| Cross-harness handoff | Checkpoint | Checkpoint | Checkpoint | Checkpoint | Checkpoint |

## 6. Adding another harness

A new adapter is accepted when it can:

1. launch a worker with an explicit model or fail before launch;
2. apply or accurately report its effective permission boundary;
3. capture a durable result and checkpoint;
4. report session and process identity;
5. expose model route evidence or run behind a provider that does;
6. implement cancellation and terminal status;
7. pass the common adapter conformance suite.
