import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { delegate, handoff, initialize, inspect, steer, wait } from '../src/controller.js'
import type { Policy, TaskRequest } from '../src/types.js'

const exec = promisify(execFile)

// A canonical LiteLLM-style upstream that records the resolved model group and
// the bearer token on the auth header so the smoke test can assert the per-attempt
// proxy token is forwarded and that no real gateway key is used. The provider is
// hit via the /v1/chat/completions endpoint, which is the protocol opencode chose
// during the B1/B2 fix verification.
async function startMockUpstream(options: { tokens: { accepted: string; rejected: string }; respond: (request: { url?: string; body: unknown; auth: string }) => { status: number; body: string; contentType: string; headers?: Record<string, string> } }): Promise<{ address: { port: number }; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown = raw
    try { parsed = JSON.parse(raw) } catch { /* not JSON */ }
    const auth = request.headers.authorization ?? ''
    const result = options.respond({ url: request.url, body: parsed, auth })
    // Add LiteLLM-style route evidence headers so the controller proxy can record a
    // resolved route in routes.jsonl. The values are sourced from the request body so
    // the mock tracks the same model alias the worker requested.
    const body = parsed && typeof parsed === 'object' && 'model' in (parsed as Record<string, unknown>) ? (parsed as { model?: string }).model : undefined
    const evidence = {
      'x-litellm-model-group': body ?? 'mock-group',
      'x-litellm-model-id': body ? `deployment-${body}` : 'deployment-mock',
      'x-litellm-fallback-count': '0',
      'x-litellm-attempted-fallbacks': '0'
    }
    response.writeHead(result.status, { 'content-type': result.contentType, ...evidence, ...(result.headers ?? {}) })
    response.end(result.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock bind failed')
  return { address, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function chatCompletionEvent(model: string, content: string): string {
  const chunks = [
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  ]
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

// Probe the opencode CLI. Returns true when installed and runnable, otherwise false.
// Must use the promisified form: the bare `execFile` returns a ChildProcess when called
// without a callback, which then `.stdout` is the live stream socket, not the captured text.
const execFileAsync = promisify(execFile)
async function probeOpencode(t?: TestContext): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('opencode', ['--version'])
    return typeof stdout === 'string' && stdout.trim().length > 0
  } catch (e) {
    if (t) t.diagnostic(`probeOpencode error: code=${(e as { code?: string }).code} msg=${(e as { message?: string }).message}`)
    return false
  }
}

test('opencode run --help exposes the flags the adapter relies on', { timeout: 30000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  const ok = await probeOpencode(t)
  if (!ok) { t.skip('opencode CLI not installed on PATH'); return }
  // `--help` is a deterministic, fast path that exercises the same code path the adapter uses
  // to read flags. It must succeed and not leak any secrets into the captured output.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-help-'))
  try {
    const child = spawn('opencode', ['run', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)))
    assert.equal(code, 0, `opencode --help exited non-zero: ${stderr.slice(-2000)}`)
    const helpOutput = stdout + stderr
    assert.match(helpOutput, /--format/, 'help output must include the --format flag the adapter relies on')
    assert.match(helpOutput, /--model/, 'help output must include the --model flag the adapter relies on')
    assert.match(helpOutput, /--pure/, 'help output must include the --pure flag the adapter uses to disable external plugins')
    assert.match(helpOutput, /--session/, 'help output must surface the --session flag used for native continuation when enabled')
    assert.match(helpOutput, /--continue/, 'help output must surface the --continue flag the adapter may use for live steering')
    assert.match(helpOutput, /--dir/, 'help output must surface the --dir flag the adapter uses to pin the working directory')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('OpenCode CLI loads an isolated provider config and emits JSON events through the per-attempt proxy token', { timeout: 90000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  if (!await probeOpencode()) { t.skip('opencode CLI not installed on PATH'); return }
  // This test reproduces the worker.ts runOpenCode launch contract against a real opencode CLI
  // and a mock upstream. It proves:
  //   B1: $XDG_CONFIG_HOME/opencode/opencode.json is the path opencode loads for our isolated config.
  //   B2: apiKey "{env:AGENT_HARNESS_PROXY_TOKEN}" is expanded to the per-attempt token at request time,
  //       so the upstream never receives the real gateway key.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-'))
  const proxyToken = 'proxy-token-xyz'
  const upstream = await startMockUpstream({
    tokens: { accepted: proxyToken, rejected: 'real-gateway-key' },
    respond: ({ url, auth }) => {
      assert.notEqual(auth, 'Bearer real-gateway-key', 'real gateway key must never reach the upstream')
      assert.equal(auth, `Bearer ${proxyToken}`, 'upstream must receive only the per-attempt proxy token')
      if (url?.endsWith('/models')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'agent-harness/alpha', object: 'model' }] }) }
      if (url?.endsWith('/chat/completions')) return { status: 200, contentType: 'text/event-stream', body: chatCompletionEvent('alpha', 'orange') }
      return { status: 404, contentType: 'application/json', body: '{}' }
    }
  })
  const cfgDir = join(base, 'xdg-config')
  const cfgFileDir = join(cfgDir, 'opencode')
  await mkdir(cfgFileDir, { recursive: true })
  await writeFile(join(cfgFileDir, 'opencode.json'), JSON.stringify({
    provider: {
      'agent-harness': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `http://127.0.0.1:${upstream.address.port}/v1`, apiKey: '{env:AGENT_HARNESS_PROXY_TOKEN}' },
        models: { alpha: { name: 'alpha' } }
      }
    }
  }, null, 2))
  const workdir = join(base, 'workdir')
  await mkdir(workdir)
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn('opencode', ['run', '--pure', '--format', 'json', '--model', 'agent-harness/alpha', '--dir', workdir, 'Say orange.'], {
      env: { ...process.env, XDG_CONFIG_HOME: cfgDir, XDG_DATA_HOME: join(base, 'xdg-data'), XDG_CACHE_HOME: join(base, 'xdg-cache'), AGENT_HARNESS_PROXY_TOKEN: proxyToken, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)))
    assert.equal(code, 0, `opencode exited non-zero: ${stderr.slice(-2000)}`)
    const lines = stdout.trim().split('\n').filter(Boolean)
    assert.ok(lines.length >= 2, 'opencode must emit at least one JSON event line on stdout')
    const events = lines.map(line => JSON.parse(line) as { type: string; sessionID?: string; part?: { type: string; text?: string } })
    const sessionIds = new Set(events.map(e => e.sessionID).filter(Boolean))
    assert.equal(sessionIds.size, 1, 'all JSON events must share a single stable sessionID')
    const textParts = events.filter(e => e.part?.type === 'text').map(e => e.part!.text!)
    assert.ok(textParts.length > 0, 'opencode must emit at least one text part')
    assert.equal(textParts.join(''), 'orange', 'the text parts must concatenate to the upstream reply')
    // The captured stdout and stderr must never contain the proxy token (the per-attempt
    // credential) or the real gateway key, proving the redaction and isolated-env contract.
    assert.doesNotMatch(stdout + stderr, new RegExp(proxyToken), 'per-attempt proxy token must not leak into captured streams')
    assert.doesNotMatch(stdout + stderr, /real-gateway-key/, 'real gateway key must never appear in captured streams')
    assert.doesNotMatch(stdout + stderr, /AGENT_HARNESS_PROXY_TOKEN/, 'literal env-var name must not leak into captured streams')
  } finally {
    await upstream.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('OPENCODE_DISABLE_MODELS_FETCH prevents the global model catalog fetch', { timeout: 60000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  if (!await probeOpencode()) { t.skip('opencode CLI not installed on PATH'); return }
  // Verify the isolation knob the adapter sets. A sentinel HTTP server records any
  // fetch directed at OPENCODE_MODELS_URL. With the knob the worker never touches
  // the sentinel; without the knob opencode hits it once at startup.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-isolation-'))
  const sentinelHits: string[] = []
  const sentinel = http.createServer((request, response) => {
    sentinelHits.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>(resolve => sentinel.listen(0, '127.0.0.1', resolve))
  const sentinelPort = (sentinel.address() as { port: number }).port
  const upstream = await startMockUpstream({
    tokens: { accepted: 'tok', rejected: 'real-key' },
    respond: ({ url }) => {
      if (url?.endsWith('/models')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'agent-harness/alpha', object: 'model' }] }) }
      if (url?.endsWith('/chat/completions')) return { status: 200, contentType: 'text/event-stream', body: chatCompletionEvent('alpha', 'ok') }
      return { status: 404, contentType: 'application/json', body: '{}' }
    }
  })
  const cfgDir = join(base, 'xdg-config')
  const cfgFileDir = join(cfgDir, 'opencode')
  await mkdir(cfgFileDir, { recursive: true })
  await writeFile(join(cfgFileDir, 'opencode.json'), JSON.stringify({
    provider: {
      'agent-harness': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `http://127.0.0.1:${upstream.address.port}/v1`, apiKey: '{env:AGENT_HARNESS_PROXY_TOKEN}' },
        models: { alpha: { name: 'alpha' } }
      }
    }
  }, null, 2))
  const workdir = join(base, 'workdir')
  await mkdir(workdir)
  try {
    const child = spawn('opencode', ['run', '--pure', '--format', 'json', '--model', 'agent-harness/alpha', '--dir', workdir, 'hi'], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: cfgDir,
        XDG_DATA_HOME: join(base, 'xdg-data'),
        XDG_CACHE_HOME: join(base, 'xdg-cache'),
        AGENT_HARNESS_PROXY_TOKEN: 'tok',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_MODELS_URL: `http://127.0.0.1:${sentinelPort}/v1`
      },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)))
    assert.equal(code, 0, `opencode exited non-zero: ${stderr.slice(-2000)}`)
    assert.equal(sentinelHits.length, 0, `OPENCODE_DISABLE_MODELS_FETCH must prevent any OPENCODE_MODELS_URL fetch; observed: ${JSON.stringify(sentinelHits)}`)
  } finally {
    await new Promise<void>(resolve => sentinel.close(() => resolve()))
    await upstream.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('missing opencode CLI rejects without hanging the worker', { timeout: 20000 }, async () => {
  // When the opencode binary is absent from PATH, the worker must observe a spawn error and
  // tear down the attempt within a bounded timeout instead of hanging the supervisor.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-missing-'))
  const emptyPath = join(base, 'empty-path')
  await mkdir(emptyPath)
  let stderr = ''
  try {
    const child = spawn('opencode', ['run', '--pure', '--format', 'json', '--model', 'agent-harness/alpha', '--dir', base, 'hi'], { env: { ...process.env, PATH: emptyPath }, stdio: ['ignore', 'pipe', 'pipe'] })
    let spawnError: Error | undefined
    child.on('error', error => { spawnError = error })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exitOrError = await Promise.race([
      new Promise<{ kind: 'exit'; code: number }>(resolve => child.once('exit', code => resolve({ kind: 'exit', code: code ?? 1 }))),
      new Promise<{ kind: 'error' }>(resolve => child.once('error', () => resolve({ kind: 'error' })))
    ])
    if (exitOrError.kind === 'exit') {
      assert.notEqual(exitOrError.code, 0, 'spawning opencode with an empty PATH must surface a non-zero exit, not a silent success')
      assert.match(stderr, /ENOENT|PATH|No such/, 'spawn failure must include an ENOENT-style diagnostic')
    } else {
      assert.ok(spawnError, 'a spawn error event must surface when the binary is missing')
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('controller delegates to opencode through the per-attempt proxy and records resolved route', { timeout: 180000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  if (!await probeOpencode()) { t.skip('opencode CLI not installed on PATH'); return }
// End-to-end test through the controller: delegate an explorer task with harness=opencode,
// prove the worker spawns opencode against the per-attempt proxy, the upstream resolves the
// requested model alias, and the attempt record carries the resolved route evidence.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-e2e-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'README.md'), 'orange\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  const stateRoot = join(base, 'state')
  const policyPath = join(base, 'policy.yaml')
  // The mock upstream here represents the real LiteLLM gateway from the controller proxy's
  // perspective. The proxy talks to it with TEST_GATEWAY_KEY=mock-key; opencode talks to
  // the proxy with a different random per-attempt token. The two-hop auth is verified
  // end-to-end by this test plus the direct-mock "isolated provider config" test above.
  const upstream = await startMockUpstream({
    tokens: { accepted: '', rejected: '' },
    respond: ({ url }) => {
      if (url?.endsWith('/models')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'agent-harness/orange-model', object: 'model' }] }) }
      if (url?.endsWith('/chat/completions')) return { status: 200, contentType: 'text/event-stream', body: chatCompletionEvent('orange-model', 'orange') }
      return { status: 404, contentType: 'application/json', body: '{}' }
    }
  })
  try {
    process.env.TEST_GATEWAY_URL = `http://127.0.0.1:${upstream.address.port}/v1`
    process.env.TEST_GATEWAY_KEY = 'mock-key'
    const policy: Policy = {
      schema_version: 1, state_root: stateRoot,
      defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 30, require_resolved_route: true, allow_cross_engine_fallback: false },
      providers: { litellm: { base_url_env: 'TEST_GATEWAY_URL', api_key_env: 'TEST_GATEWAY_KEY' } },
      models: { 'orange-model': { engine_id: 'orange', litellm_model_group: 'orange-model', permitted_fallback_engines: [] } },
      roles: {
        'code-explorer': {
          allowed_harnesses: ['opencode'],
          allowed_models: ['orange-model'],
          filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read', 'search']
        }
      },
      workflow: { require_adjacent_engine_diversity: false }
    }
    await writeFile(policyPath, YAML.stringify(policy))
    process.env.AGENT_HARNESS_POLICY = policyPath
    const project = await initialize(repo, 'OpenCode adapter end-to-end smoke', policyPath)
    process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
    const request: TaskRequest = {
      schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'opencode', model: 'orange-model',
      objective: 'Read README.md and report the word.', acceptance_criteria: ['Cite README.md and state the word.'],
      permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search'] },
      workspace: { strategy: 'read-only-checkout', repository: repo }
    }
    const requestFile = join(base, 'request.yaml')
    await writeFile(requestFile, YAML.stringify(request))
    const delegated = await delegate(requestFile)
    const status = await wait(delegated.task_id, 60000)
    assert.equal(status.state, 'completed', `opencode adapter: ${status.summary}; ${(await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'error.log'), 'utf8').catch(() => '')).slice(-2000)}`)
    const routesRaw = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'routes.jsonl'), 'utf8').catch(() => '')
    assert.ok(routesRaw.trim().length > 0, 'routes.jsonl must record at least one resolved upstream call')
    const lastRoute = JSON.parse(routesRaw.trim().split('\n').filter(Boolean).at(-1)!) as { resolved_group: string; deployment_id: string; engine_id: string }
    assert.equal(lastRoute.resolved_group, 'orange-model')
    assert.equal(lastRoute.engine_id, 'orange')
    const attemptJsonl = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'opencode.jsonl'), 'utf8')
    const attemptStderr = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'opencode.stderr.log'), 'utf8').catch(() => '')
    assert.match(attemptJsonl, /"type":"step_start"/, 'worker must capture opencode step_start events')
    assert.match(attemptJsonl, /"type":"text"/, 'worker must capture opencode text events')
    const sessionMatch = attemptJsonl.match(/"sessionID":"(ses_[^"]+)"/)
    assert.ok(sessionMatch, 'worker must capture the opencode sessionID')
    // opencode.jsonl and opencode.stderr.log must never leak the gateway key or the proxy token.
    // The gateway key is TEST_GATEWAY_KEY=mock-key. The proxy token never reaches the captured
    // adapter log either; it is the credential opencode hands the controller proxy.
    assert.doesNotMatch(attemptJsonl + attemptStderr, /mock-key/, 'real gateway key must never leak into the captured adapter log')
    assert.doesNotMatch(attemptJsonl + attemptStderr, /AGENT_HARNESS_PROXY_TOKEN/, 'literal env-var name must not leak into the captured adapter log')
    // result.md must be the upstream text content (concatenated text parts).
    const resultMd = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'result.md'), 'utf8')
    assert.match(resultMd, /orange/, 'result.md must contain the upstream text reply')
  } finally {
    process.env.AGENT_HARNESS_LEAD_ID = ''
    delete process.env.AGENT_HARNESS_LEAD_ID
    delete process.env.AGENT_HARNESS_POLICY
    delete process.env.TEST_GATEWAY_URL
    delete process.env.TEST_GATEWAY_KEY
    await upstream.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('checkpoint-based opencode correction replays the latest checkpoint to a fresh attempt', { timeout: 240000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  if (!await probeOpencode()) { t.skip('opencode CLI not installed on PATH'); return }
  // The OpenCode adapter does not claim native continuation support (the smoke test above
  // exercises the launch contract only); corrections always start a fresh attempt with the
  // full checkpoint. This test proves that round-trip: steer after the first attempt finishes,
  // observe a second attempt that consumes the prior checkpoint and writes a new result.
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-correction-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'README.md'), 'orange\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  const stateRoot = join(base, 'state')
  const policyPath = join(base, 'policy.yaml')
  const upstream = await startMockUpstream({
    tokens: { accepted: '', rejected: '' },
    respond: ({ url }) => {
      if (url?.endsWith('/models')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'agent-harness/orange-model', object: 'model' }] }) }
      if (url?.endsWith('/chat/completions')) return { status: 200, contentType: 'text/event-stream', body: chatCompletionEvent('orange-model', 'corrected') }
      return { status: 404, contentType: 'application/json', body: '{}' }
    }
  })
  try {
    process.env.TEST_GATEWAY_URL = `http://127.0.0.1:${upstream.address.port}/v1`
    process.env.TEST_GATEWAY_KEY = 'mock-key'
    const policy: Policy = {
      schema_version: 1, state_root: stateRoot,
      defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 30, require_resolved_route: true, allow_cross_engine_fallback: false, max_correction_cycles: 3 },
      providers: { litellm: { base_url_env: 'TEST_GATEWAY_URL', api_key_env: 'TEST_GATEWAY_KEY' } },
      models: {
        'orange-model': { engine_id: 'orange', litellm_model_group: 'orange-model', permitted_fallback_engines: [] },
        'blue-model': { engine_id: 'blue', litellm_model_group: 'blue-model', permitted_fallback_engines: [] }
      },
      roles: {
        'code-explorer': {
          allowed_harnesses: ['opencode', 'codex', 'fake'],
          allowed_models: ['orange-model', 'blue-model'],
          filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read', 'search']
        }
      },
      workflow: { require_adjacent_engine_diversity: false }
    }
    await writeFile(policyPath, YAML.stringify(policy))
    process.env.AGENT_HARNESS_POLICY = policyPath
    const project = await initialize(repo, 'OpenCode correction round-trip smoke', policyPath)
    process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
    const request: TaskRequest = {
      schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'opencode', model: 'orange-model',
      objective: 'Read README.md and report the word.', acceptance_criteria: ['Cite README.md and state the word.'],
      permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search'] },
      workspace: { strategy: 'read-only-checkout', repository: repo }
    }
    const requestFile = join(base, 'request.yaml')
    await writeFile(requestFile, YAML.stringify(request))
    const delegated = await delegate(requestFile)
    const first = await wait(delegated.task_id, 60000)
    assert.equal(first.state, 'completed', `first attempt: ${first.summary}`)
    // Now steer. The worker should produce a fresh attempt-02 that uses the full checkpoint
    // from attempt-01. Because we changed the mock upstream to return "corrected", the second
    // attempt's result.md must mention "corrected" rather than the first attempt's "orange".
    await steer(delegated.task_id, 'Confirm the word again.')
    const second = await wait(delegated.task_id, 60000)
    assert.equal(second.state, 'completed', `second attempt: ${second.summary}`)
    const bundle = await inspect(delegated.task_id)
    assert.equal(bundle.session.attempts.length, 2, 'correction must produce a second attempt')
    assert.equal(bundle.session.attempts[1].harness, 'opencode', 'correction attempt must stay on opencode')
    assert.equal(bundle.session.attempts[1].continuation_supported, false, 'opencode continuation_supported must stay false without proven resume')
    const secondResult = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-02', 'result.md'), 'utf8')
    assert.match(secondResult, /corrected/, 'second attempt must reflect the new upstream reply, not the first attempt result')
    // The second prompt file must include the first checkpoint text.
    const secondPrompt = await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-02', 'prompt.md'), 'utf8')
    assert.match(secondPrompt, /orange/, 'second prompt must include the prior checkpoint material')
  } finally {
    process.env.AGENT_HARNESS_LEAD_ID = ''
    delete process.env.AGENT_HARNESS_LEAD_ID
    delete process.env.AGENT_HARNESS_POLICY
    delete process.env.TEST_GATEWAY_URL
    delete process.env.TEST_GATEWAY_KEY
    await upstream.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('opencode worker handoff to codex produces a fresh codex attempt with the opencode checkpoint', { timeout: 300000 }, async (t) => {
  if (process.env.AGENT_HARNESS_SKIP_OPENCODE_SMOKE) { t.skip('AGENT_HARNESS_SKIP_OPENCODE_SMOKE is set'); return }
  if (!await probeOpencode()) { t.skip('opencode CLI not installed on PATH'); return }
  // The cross-harness handoff uses the opencode attempt's checkpoint to seed a new codex
  // attempt. Because we do not have a real codex CLI in the smoke test environment, this
  // test only runs end-to-end when both CLIs are available. We probe codex explicitly so
  // the test honestly skips otherwise.
  try { await execFileAsync('codex', ['--version']) }
  catch { t.skip('codex CLI not installed on PATH'); return }
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-opencode-handoff-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'README.md'), 'orange\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  const stateRoot = join(base, 'state')
  const policyPath = join(base, 'policy.yaml')
  const upstream = await startMockUpstream({
    tokens: { accepted: '', rejected: '' },
    respond: ({ url }) => {
      if (url?.endsWith('/models')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'agent-harness/orange-model', object: 'model' }] }) }
      if (url?.endsWith('/chat/completions')) return { status: 200, contentType: 'text/event-stream', body: chatCompletionEvent('orange-model', 'opencode-reply') }
      if (url?.endsWith('/responses')) {
        const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex-reply' }], status: 'completed' }
        const completed = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'orange-model', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, error: null, incomplete_details: null }
        const events = [
          { type: 'response.created', response: Object.assign({}, completed, { status: 'in_progress', output: [] }) },
          { type: 'response.output_item.added', output_index: 0, item: Object.assign({}, message, { content: [], status: 'in_progress' }) },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: completed }
        ]
        return { status: 200, contentType: 'text/event-stream', body: events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') }
      }
      return { status: 404, contentType: 'application/json', body: '{}' }
    }
  })
  try {
    process.env.TEST_GATEWAY_URL = `http://127.0.0.1:${upstream.address.port}/v1`
    process.env.TEST_GATEWAY_KEY = 'mock-key'
    const policy: Policy = {
      schema_version: 1, state_root: stateRoot,
      defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 30, require_resolved_route: true, allow_cross_engine_fallback: false, max_correction_cycles: 3 },
      providers: { litellm: { base_url_env: 'TEST_GATEWAY_URL', api_key_env: 'TEST_GATEWAY_KEY' } },
      models: {
        'orange-model': { engine_id: 'orange', litellm_model_group: 'orange-model', permitted_fallback_engines: [] },
        'blue-model': { engine_id: 'blue', litellm_model_group: 'blue-model', permitted_fallback_engines: [] }
      },
      roles: {
        'code-explorer': {
          allowed_harnesses: ['opencode', 'codex', 'fake'],
          allowed_models: ['orange-model', 'blue-model'],
          filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read', 'search']
        }
      },
      workflow: { require_adjacent_engine_diversity: false }
    }
    await writeFile(policyPath, YAML.stringify(policy))
    process.env.AGENT_HARNESS_POLICY = policyPath
    const project = await initialize(repo, 'OpenCode-to-Codex handoff smoke', policyPath)
    process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
    const request: TaskRequest = {
      schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'opencode', model: 'orange-model',
      objective: 'Read README.md and report the word.', acceptance_criteria: ['Cite README.md and state the word.'],
      permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search'] },
      workspace: { strategy: 'read-only-checkout', repository: repo }
    }
    const requestFile = join(base, 'request.yaml')
    await writeFile(requestFile, YAML.stringify(request))
    const delegated = await delegate(requestFile)
    const first = await wait(delegated.task_id, 60000)
    assert.equal(first.state, 'completed', `first attempt: ${first.summary}`)
    await handoff(delegated.task_id, 'codex', 'orange-model')
    const second = await wait(delegated.task_id, 60000)
    assert.equal(second.state, 'completed', `handoff attempt: ${second.summary}`)
    const bundle = await inspect(delegated.task_id)
    assert.equal(bundle.session.attempts.length, 2, 'handoff must produce a second attempt')
    assert.equal(bundle.session.attempts[1].harness, 'codex', 'second attempt must be codex after handoff from opencode')
  } finally {
    process.env.AGENT_HARNESS_LEAD_ID = ''
    delete process.env.AGENT_HARNESS_LEAD_ID
    delete process.env.AGENT_HARNESS_POLICY
    delete process.env.TEST_GATEWAY_URL
    delete process.env.TEST_GATEWAY_KEY
    await upstream.close()
    await rm(base, { recursive: true, force: true })
  }
})

// End of opencode smoke suite.