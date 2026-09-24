import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import YAML from 'yaml'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { appendEvent, atomicJson, atomicWrite, exists, json, now, sleep } from './store.js'
import { completeAttempt, recoverQueuedSteering, setStatus } from './controller.js'
import { loadPolicy } from './policy.js'
import { acquireLease } from './leases.js'
import { startProxy, type ProxyHandle } from './proxy.js'
import { validateRequest, type AttemptRequest, type Session, type TaskRequest } from './types.js'

const [dir, attemptId] = process.argv.slice(2)
if (!dir || !attemptId) throw new Error('worker requires task directory and attempt ID')
const aDir = join(dir, 'attempts', attemptId)
let cancelled = false
let child: ChildProcessWithoutNullStreams | undefined
let dsh: DeepSeekHarness | undefined
let proxy: ProxyHandle | undefined

function redact(value: string, secrets: Array<string | undefined>): string {
  let result = value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]')
  return result
}

async function updateSession(change: (session: Session) => void): Promise<void> {
  const session = await json<Session>(join(dir, 'session.json'))
  change(session)
  await atomicJson(join(dir, 'session.json'), session)
}

function scrubbedEnv(extra: Record<string, string>, gatewayKeyName: string): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  delete env[gatewayKeyName]
  delete env.LITELLM_API_KEY
  delete env.OPENAI_API_KEY
  delete env.DEEPSEEK_API_KEY
  return env
}

async function runCodex(request: TaskRequest, effective: AttemptRequest, home: string, proxyHandle: ProxyHandle, gatewayKeyName: string): Promise<{ text: string; nativeSessionId?: string }> {
  const codexHome = join(dir, 'codex-home')
  await mkdir(codexHome, { recursive: true })
  const config = `model = ${JSON.stringify(effective.model)}\nmodel_provider = "litellm"\napproval_policy = "never"\n[model_providers.litellm]\nname = "LiteLLM"\nbase_url = ${JSON.stringify(proxyHandle.baseUrl)}\nenv_key = "AGENT_HARNESS_PROXY_TOKEN"\nwire_api = "responses"\n`
  await atomicWrite(join(codexHome, 'config.toml'), config)
  const output = join(aDir, 'codex-final.txt')
  const session = await json<Session>(join(dir, 'session.json'))
  const earlier = session.attempts.slice(0, -1).reverse().find(x => x.harness === 'codex' && x.native_session_id)
  const useResume = effective.kind !== 'initial' && effective.kind !== 'handoff' && earlier?.native_session_id
  const args = useResume
    ? ['exec', 'resume', earlier!.native_session_id!, '-', '--json', '-o', output, '--dangerously-bypass-approvals-and-sandbox']
    : ['exec', '--json', '-m', effective.model, '-C', effective.workspace_path, '-s', 'danger-full-access', '-o', output, '-']
  const env = scrubbedEnv({ CODEX_HOME: codexHome, HOME: home, TMPDIR: join(home, 'tmp'), AGENT_HARNESS_PROXY_TOKEN: proxyHandle.token }, gatewayKeyName)
  const secrets = [process.env[gatewayKeyName], proxyHandle.token]
  child = spawn('codex', args, { cwd: effective.workspace_path, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(await readFile(effective.prompt_file))
  let nativeSessionId = useResume ? earlier!.native_session_id : undefined
  let stdoutBuffer = ''
  child.stdout.on('data', chunk => {
    const data = String(chunk)
    void appendFile(join(aDir, 'codex.jsonl'), redact(data, secrets))
    stdoutBuffer += data
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: string; message?: string }
        if (event.type === 'thread.started' && event.thread_id) {
          nativeSessionId = event.thread_id
          void updateSession(session => { session.attempts.find(x => x.attempt_id === attemptId)!.native_session_id = event.thread_id })
        }
        if (event.type === 'turn.started') void appendEvent(dir, 'progress', { attempt_id: attemptId, summary: 'Codex turn started' })
      } catch { /* retain raw log */ }
    }
  })
  child.stderr.on('data', chunk => { void appendFile(join(aDir, 'codex.stderr.log'), redact(String(chunk), secrets)) })
  const exit = await new Promise<number>((resolve, reject) => child!.once('error', reject).once('exit', code => resolve(code ?? 1)))
  child = undefined
  if (exit !== 0) throw new Error(`Codex exited ${exit}; inspect ${join(aDir, 'codex.stderr.log')}`)
  const text = await readFile(output, 'utf8')
  if (!text.trim()) throw new Error('Codex produced an empty result')
  return { text, nativeSessionId }
}

async function runDeepSeek(_request: TaskRequest, effective: AttemptRequest, home: string, proxyHandle: ProxyHandle, gatewayKeyName: string): Promise<{ text: string; nativeSessionId?: string }> {
  const dshHome = join(home, 'dsh')
  await mkdir(dshHome, { recursive: true })
  const patch = [{ id: 'llm-pi-ai', config: { providers: { litellm: { apiKeyEnv: 'AGENT_HARNESS_PROXY_TOKEN', api: 'openai-completions', baseURL: proxyHandle.baseUrl, models: [{ id: effective.model }] } } } }, { id: 'tool-web', disabled: true }, { id: 'tool-subagent', disabled: true }, { id: 'tool-subagent-fork', disabled: true }]
  const patchPath = join(aDir, 'dsh-provider.patch.yml')
  await atomicWrite(patchPath, YAML.stringify(patch))
  const env = scrubbedEnv({ HOME: home, TMPDIR: join(home, 'tmp'), DSH_HOME: dshHome, DSH_PERMISSION_MODE: _request.role === 'code-explorer' ? 'read-only' : 'workspace-write', DSH_TELEMETRY_MODE: 'OFF', AGENT_HARNESS_PROXY_TOKEN: proxyHandle.token }, gatewayKeyName)
  const secrets = [process.env[gatewayKeyName], proxyHandle.token]
  dsh = new DeepSeekHarness({ dshHome, patches: [patchPath], processCwd: effective.workspace_path, cwd: effective.workspace_path, provider: 'litellm', model: effective.model, env })
  let lastError: string | undefined
  const result = await dsh.run(await readFile(effective.prompt_file, 'utf8'), {
    onNotification: event => {
      void appendFile(join(aDir, 'deepseek.jsonl'), redact(JSON.stringify(event), secrets) + '\n')
      const detail = event as { method?: string; params?: { event?: { type?: string; data?: { reason?: { error?: { message?: string } } } } } }
      if (detail.method === 'session.event' && detail.params?.event?.type === 'turn/end') lastError = detail.params.event.data?.reason?.error?.message
    }
  })
  const nativeSessionId = result.sessionId
  await updateSession(session => { session.attempts.find(x => x.attempt_id === attemptId)!.native_session_id = nativeSessionId })
  await dsh.close()
  dsh = undefined
  if (!result.finalResponse.trim()) throw new Error(`DeepSeek produced an empty result${lastError ? `: ${redact(lastError, secrets)}` : ''}`)
  return { text: result.finalResponse, nativeSessionId }
}

async function run(): Promise<void> {
  for (let i = 0; i < 100 && !await exists(join(aDir, 'launch.ready')); i++) await sleep(100)
  if (!await exists(join(aDir, 'launch.ready'))) throw new Error('launch handshake timed out')
  const policy = await loadPolicy()
  const request = validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8')))
  const effective = YAML.parse(await readFile(join(aDir, 'request.yaml'), 'utf8')) as AttemptRequest
  const home = join(aDir, 'home')
  await mkdir(home, { recursive: true })
  await mkdir(join(home, 'tmp'), { recursive: true })
  const heartbeat = setInterval(() => {
    if (!cancelled) {
      void setStatus(dir, request.task_id!, attemptId, 'running', 'worker active')
      void appendEvent(dir, 'worker.heartbeat', { attempt_id: attemptId })
      void acquireLease(policy.state_root, `resume:${request.task_id!}`, attemptId).catch(error => appendEvent(dir, 'policy.violation', { attempt_id: attemptId, reason: String(error) }))
      if (request.role === 'code-implementer') void acquireLease(policy.state_root, `writer:${request.workspace.repository}`, request.task_id!).catch(error => appendEvent(dir, 'policy.violation', { attempt_id: attemptId, reason: String(error) }))
    }
  }, policy.defaults.heartbeat_interval_seconds * 1000)
  heartbeat.unref()
  try {
    await updateSession(session => { session.attempts.find(x => x.attempt_id === attemptId)!.state = 'running' })
    await setStatus(dir, request.task_id!, attemptId, 'running', 'worker started')
    await appendEvent(dir, 'worker.started', { attempt_id: attemptId, harness: effective.harness })
    let result: { text: string; nativeSessionId?: string }
    if (effective.harness === 'fake') {
      result = { text: `Fake result for ${request.objective}\n\nAcceptance criteria: ${request.acceptance_criteria.join('; ')}` }
    } else {
      proxy = await startProxy({ policy, alias: effective.model, taskId: request.task_id!, attemptId, logPath: join(aDir, 'routes.jsonl'), onRoute: route => appendEvent(dir, 'provider.route', { attempt_id: attemptId, requested: effective.model, ...route }) })
      result = effective.harness === 'codex' ? await runCodex(request, effective, home, proxy, policy.providers.litellm.api_key_env) : await runDeepSeek(request, effective, home, proxy, policy.providers.litellm.api_key_env)
      if (!proxy.routes.length) throw new Error('no resolved LiteLLM route evidence')
    }
    if (cancelled) return
    const resultText = result.text.trim() + '\n'
    const checkpointText = `# Checkpoint\n\nObjective: ${request.objective}\n\nAttempt: ${attemptId} (${effective.harness}, ${effective.model})\n\nResult:\n\n${result.text.trim()}\n\nWorkspace: ${effective.workspace_path}\n`
    await atomicWrite(join(aDir, 'result.md'), resultText)
    await atomicWrite(join(aDir, 'checkpoint.md'), checkpointText)
    await atomicWrite(join(dir, 'result.md'), resultText)
    await atomicWrite(join(dir, 'checkpoint.md'), checkpointText)
    await appendEvent(dir, 'checkpoint.created', { attempt_id: attemptId })
    const route = proxy?.routes.at(-1)
    await completeAttempt(dir, attemptId, 'completed', 'worker completed', route)
    clearInterval(heartbeat)
    await recoverQueuedSteering(dir, policy)
  } catch (error) {
    if (!cancelled) {
      await appendFile(join(aDir, 'error.log'), `${now()} ${String(error)}\n`)
      await completeAttempt(dir, attemptId, 'failed', String(error))
    }
  } finally {
    clearInterval(heartbeat)
    await dsh?.close().catch(() => undefined)
    await proxy?.close().catch(() => undefined)
  }
}

process.on('SIGTERM', () => {
  cancelled = true
  child?.kill('SIGTERM')
  void dsh?.close()
})

await run()
