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

The first release uses the official `@deepseek-ai/dsh-sdk-client` and same-version `@deepseek-ai/dsh` packages, pinned together. It creates an isolated DSH home and per-attempt profile patch with a single `litellm` route using `openai-completions`. The SDK subprocess receives the task workspace and a proxy token, while the supervisor retains the shared LiteLLM key. The DeepSeek inner shell sandbox is set to `danger-full-access` because this macOS host reported no usable inner backend; the controller's outer macOS sandbox enforces the filesystem boundary for the entire subprocess tree.

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

The OpenCode adapter runs each worker as an external `opencode run` subprocess, similar to the Codex external-process adapter. The controller owns the LiteLLM proxy and writes an isolated `opencode.json` for each attempt that points at the per-attempt proxy URL and uses the proxy token for authentication. The worker reads the model alias from the attempt request and passes `--model provider/alias`; the proxy enforces ownership so an attempt cannot route to a different engine.

### 4.1 Launch contract

The adapter spawns:

```text
opencode run --pure --format json --model agent-harness/<alias> --dir <workspace> -
```

Verified against opencode 1.18.32:

- `--pure` disables external plugins so the worker's behavior depends only on the isolated config the controller writes.
- `--format json` emits one JSON event per line on stdout (`step_start`, `text`, `step_finish`, plus tool events the adapter ignores). The adapter concatenates `part.text` from each `text` event into the result. Every event carries a `sessionID` field; the worker captures the first one and persists it on the attempt record.
- The prompt is piped on stdin so the adapter can pass arbitrary-length prompts without argv length limits.
- `XDG_CONFIG_HOME` is redirected to a per-attempt directory. Opencode resolves `$XDG_CONFIG_HOME/opencode/opencode.json`; the adapter writes the isolated config at that exact path and uses `{env:AGENT_HARNESS_PROXY_TOKEN}` for the provider `apiKey`. The smoke test `OpenCode CLI loads an isolated provider config and emits JSON events through the per-attempt proxy token` proves both behaviours: the upstream receives `Authorization: Bearer <proxy-token>` (the env-expanded value), never the literal env-var name, and never the real gateway key.
- `XDG_DATA_HOME` and `XDG_CACHE_HOME` are also redirected under the worker's home so the run never touches the user's global opencode state. The real gateway key is scrubbed from the worker's environment; only the proxy token is exported as `AGENT_HARNESS_PROXY_TOKEN`.
- Two opencode-specific isolation knobs are set on the worker process: `OPENCODE_DISABLE_MODELS_FETCH=1` blocks the worker from hitting the configured `OPENCODE_MODELS_URL` at startup, and `OPENCODE_DISABLE_AUTOUPDATE=1` prevents the worker from triggering a self-upgrade mid-attempt. The `OPENCODE_DISABLE_MODELS_FETCH` behaviour was verified by the dedicated smoke test using a sentinel HTTP server: zero hits with the knob, one hit without it. Both names are present in opencode 1.18.32.
- Opencode calls the upstream via `/v1/chat/completions` (not `/v1/responses`) when configured with `@ai-sdk/openai-compatible`. The adapter is wire-protocol agnostic, but a future enhancement may want to negotiate the protocol.

### 4.2 Session and continuation

The OpenCode CLI exposes `--session <id>` and `--continue`. A live proof of resume across `--session` in this opencode version was not completed in the first release, so `continuation_supported` stays `false` for OpenCode attempts. The adapter still captures the `sessionID` from every JSON event and persists it on the attempt record for future resume, but a correction or handoff always starts a fresh attempt and replays the latest checkpoint plus any pending steering message. The OpenCode external-process column in the capability matrix reflects this conservative default.

### 4.3 Output and cancellation

The adapter writes:

- `opencode.jsonl` — every JSON line from stdout, with bearer tokens and the real gateway key redacted.
- `opencode.stderr.log` — the raw stderr stream, also redacted.

The `output` controller command maps `opencode` to those file names so a lead can inspect the raw adapter log with `agent-harness output --source harness` and `--source stderr`.

A `SIGTERM` to the supervisor reaches the OpenCode child through the existing `child?.kill('SIGTERM')` path in `worker.ts`. Cancellation then proceeds through the controller's grace window. If the `opencode` binary is missing from `PATH`, the worker observes a spawn error event, the attempt terminates, and the supervisor does not hang (covered by the `missing opencode CLI rejects without hanging the worker` smoke test). The redactor scrubs bearer tokens from the JSON event stream and stderr so neither leaks into the durable adapter log; the e2e controller-driven smoke test asserts this for every attempt.

### 4.4 Lead instructions and migration

The first release keeps the existing native lead instructions and does not migrate bundles from `~/.config/opencode/lead-context`. The external-process adapter is launched only when a lead delegates through the controller with `harness: opencode` and an approved role/model pair, so any future lead rewrite can target the same controller operations the Codex and DSH leads already use.

### 4.5 Live policy enablement

The example policy in `config/policy.example.yaml` lists `opencode` in `allowed_harnesses` for the first-release roles so a fresh install can delegate to OpenCode without further edits. The live policy at `~/.config/agent-harness/policy.yaml` is not modified by the harness; operators must add `opencode` to the role allowlists themselves when they want to enable it, matching the same opt-in model used for Codex and DSH.

## 5. Capability matrix

| Capability | Codex external process | Codex native child | DSH in-process | DSH SDK process | OpenCode external process | OpenCode native task |
|---|---:|---:|---:|---:|---:|---:|
| Select worker model | Yes | Catalog/fixed-role limits | Yes | Yes | Yes | Via role variants |
| Role-specific model set | Controller | No | Controller | Controller | Controller | Variants |
| Separate LiteLLM key | Yes | No | Usually shared | Yes | Yes | Depends on process setup |
| Separate sandbox | Yes | No within one tree | Inherits parent override | Yes | Yes (per-attempt `XDG_*` + isolated config) | Agent/tool policy; verify OS boundary |
| Native continuation | Yes | Yes | Yes | No one-shot continuation | Session ID captured; resume not yet proven | Yes |
| Durable steering | Controller | Native plus controller | Native plus controller | New run from checkpoint | Controller (checkpoint correction) | Native plus controller |
| Cross-harness handoff | Checkpoint | Checkpoint | Checkpoint | Checkpoint | Checkpoint | Checkpoint |

## 6. Adding another harness

A new adapter is accepted when it can:

1. launch a worker with an explicit model or fail before launch;
2. apply or accurately report its effective permission boundary;
3. capture a durable result and checkpoint;
4. report session and process identity;
5. expose model route evidence or run behind a provider that does;
6. implement cancellation and terminal status;
7. pass the common adapter conformance suite.
