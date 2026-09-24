# Live LiteLLM Gateway Testing

The repository's `npm test` suite is deterministic and runs against an in-process
mock proxy. The optional live test in `test/live.test.ts` exercises the same
Codex correction + DeepSeek handoff flow against a real LiteLLM gateway. It is
skipped by default and only runs when all of the gating environment variables
below are present.

## 1. When to run it

Run the live test before declaring a release operational for model work, after
changing the proxy, the model-policy format, or the cross-harness handoff path.
It is the only check that proves the controller and both adapters cooperate
with the real gateway headers and the real upstream model surface.

## 2. Prerequisites

- Node.js 24, Git, macOS `sandbox-exec`, and the Codex CLI on `PATH`.
- A running LiteLLM gateway reachable from the worker host.
- A shared LiteLLM API key with access to two approved model groups, one for
  Codex and one for DeepSeek Harness. The two groups must resolve to different
  `engine_id` values so the adjacent-stage diversity rule is meaningful.
- The shared key and base URL **must never be committed to the repository**.
  Provide them through environment variables or your shell's secret manager.
  The supervisor keeps the key; each worker only sees a per-attempt random
  token for the loopback proxy, and the key is removed from worker
  environments. See [security-model.md](security-model.md) §4 for details.

## 3. Required environment variables

| Variable | Purpose |
|---|---|
| `AGENT_HARNESS_LIVE` | Set to `1` to opt in. The test is skipped otherwise. |
| `LITELLM_BASE_URL` | Gateway base URL, including the `/v1` suffix used by the proxy. |
| `LITELLM_API_KEY` | Shared LiteLLM key, supplied out-of-band. |
| `AGENT_HARNESS_TEST_CODEX_MODEL` | Gateway model-group name (the value the gateway displays, may contain spaces) that the Codex worker will use. |
| `AGENT_HARNESS_TEST_DSH_MODEL` | Gateway model-group name for the DeepSeek Harness handoff target. |

The test writes a temporary policy that uses local slug aliases
`live-codex` and `live-deepseek`. The supervisor maps those slugs to the
gateway model-group names above through the policy's `models:` block, so the
local slug stays stable while the gateway group can change between
environments.

Example:

```sh
export AGENT_HARNESS_LIVE=1
export LITELLM_BASE_URL='https://gateway.example.internal/v1'
export LITELLM_API_KEY='<shared key from secret manager>'
export AGENT_HARNESS_TEST_CODEX_MODEL='Codex Production Group'
export AGENT_HARNESS_TEST_DSH_MODEL='DeepSeek Production Group'
```

The proxy adds the following request headers to every forwarded call so the
gateway can attribute usage to a task and attempt:

- `x-agent-harness-task-id`
- `x-agent-harness-attempt-id`

## 4. Required gateway response headers

The supervisor's local proxy validates and records route evidence from the
gateway response. A response that omits any of the first three headers causes
the worker to fail with `resolved model route unavailable or disallowed`.

| Header (preferred) | Alternate | What the supervisor records |
|---|---|---|
| `x-litellm-model-group` | `x-litellm-model-group-name` | Resolved model group displayed by the gateway. |
| `x-litellm-model-id` | `x-litellm-deployment-id` | Resolved deployment ID. |
| `x-litellm-attempted-fallbacks` | `x-litellm-fallback-count` | Integer fallback count, `0` or greater. |
| `x-litellm-call-id` | — | Optional. Recorded as `call_id`. |
| `x-litellm-response-cost` | — | Optional. Recorded as `cost_usd` when numeric. |

Cross-engine fallbacks are rejected by default (`allow_cross_engine_fallback:
false`). The resolved group's `engine_id` must match the requested alias's
`engine_id`, or the request fails even when the upstream call succeeded. This
is how the harness defends against a silent engine change after fallback.

## 5. Local alias to gateway model-group mapping

Policy entries keep the local slug and the gateway group separate:

```yaml
models:
  live-codex:
    engine_id: live-codex
    litellm_model_group: 'Codex Production Group'
    permitted_fallback_engines: []
  live-deepseek:
    engine_id: live-deepseek
    litellm_model_group: 'DeepSeek Production Group'
    permitted_fallback_engines: []
```

Local aliases are lowercase slugs without spaces. `litellm_model_group` is the
gateway's display name, which may contain spaces. The proxy replaces the local
slug with `litellm_model_group` on the upstream request and then maps the
resolved group back to a declared model to confirm the engine.

## 6. Running the test

Build and run only the live suite:

```sh
npm run build
node --test --test-name-pattern='live Codex correction' dist/test/live.test.js
```

Or run the whole suite; the deterministic tests still execute and the live
test is skipped when any required variable is missing:

```sh
npm test
```

The live test has a ten-minute timeout because two real model round trips and
a handoff are involved.

## 7. What the test validates

`test/live.test.ts` exercises the full Code-to-DeepSeek integration against a
configured gateway:

1. Bootstraps a tiny Git repository whose `README.md` contains a target string.
2. Builds a temporary policy that maps local slugs `live-codex` and
   `live-deepseek` to the gateway model groups in the environment variables.
3. Delegates a read-only `code-explorer` task to Codex CLI through the proxy.
4. Waits for the Codex attempt to complete.
5. Steers the completed task with a correction message and waits for the
   resumed Codex attempt to complete, asserting the attempt ID changed.
6. Hands the same task off to DeepSeek Harness using a different approved
   model group, validating engine diversity across the handoff.
7. Waits for the DeepSeek attempt to complete, asserts the session recorded
   three attempts in order, and confirms the final `result.md` contains the
   target string.
8. Captures resolved route evidence (`resolved_group`, `deployment_id`,
   `fallback_count`, `engine_id`) for every upstream call through the proxy.

Cleanup runs even on failure: the live test cancels the active task and
removes its temporary directory in a `finally` block.

## 8. Troubleshooting

- **`resolved model route unavailable or disallowed`** — the gateway
  response is missing one of the required headers or the resolved engine
  differs from the requested one. Confirm the gateway is configured to
  emit the headers in §4 and that the local policy's `engine_id` matches
  the engine behind the chosen model group.
- **`LiteLLM base URL and API key are required`** — the supervisor did not
  see `LITELLM_BASE_URL` or `LITELLM_API_KEY`. The test is skipped when
  either is missing, so this only appears during direct use.
- **Cross-engine fallback** — choose an approved model group that resolves to
  the intended engine. A successful upstream response can still be rejected
  when LiteLLM falls back to a different group. The proxy records rejected
  route fields in the attempt's `routes.jsonl.rejected` file.
- **Test is skipped** — confirm `AGENT_HARNESS_LIVE=1` and that all four
  required variables are exported in the same shell that runs `npm test`.

## 9. Related references

- [architecture.md](architecture.md) §2.7 — LiteLLM role in routing and accounting.
- [security-model.md](security-model.md) §3, §4 — model authorization and credential handling.
- [harness-adapters.md](harness-adapters.md) §2, §3 — Codex and DeepSeek adapter details.
- [validation.md](validation.md) §8, §10 — evidence already collected and release-gate criteria.
- [implementation-plan.md](implementation-plan.md) — current release scope.
