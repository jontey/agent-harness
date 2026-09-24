import { readFile, mkdir, realpath, writeFile, open } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import YAML from 'yaml'
import { fileURLToPath } from 'node:url'
import { acquireLease, releaseLease, requireLease } from './leases.js'
import { checkAdjacentEngine, checkPolicy, defaultPolicyPath, loadPolicy } from './policy.js'
import { appendEvent, atomicJson, atomicWrite, directories, exists, json, now, sleep, withLock, writeExclusive } from './store.js'
import { validateRequest, type Attempt, type AttemptRequest, type Harness, type Policy, type Session, type Status, type TaskRequest } from './types.js'

const exec = promisify(execFile)
const POLL_INTERVAL_MS = 100
const DEFAULT_CANCEL_GRACE_SECONDS = 30
const moduleDir = dirname(fileURLToPath(import.meta.url))

export async function processBirth(pid: number): Promise<string> {
  const result = await exec('ps', ['-p', String(pid), '-o', 'lstart='])
  return result.stdout.trim()
}

export async function isProcessAlive(pid: number | undefined, expectedBirth: string | undefined): Promise<boolean> {
  if (!pid) return false
  const birth = await processBirth(pid).catch(() => '')
  if (!birth || (expectedBirth && birth !== expectedBirth)) return false
  // Defensively treat zombies as no longer alive so a reaped supervisor does not indefinitely
  // block the writer lease release after a cancel or reconciliation.
  const state = await exec('ps', ['-p', String(pid), '-o', 'stat=']).then(x => x.stdout.trim()).catch(() => '')
  if (state.startsWith('Z')) return false
  return true
}

export async function awaitSupervisorExit(pid: number | undefined, expectedBirth: string | undefined, graceMs: number): Promise<{ exited: boolean; observedBirth: string }> {
  if (!pid) return { exited: true, observedBirth: '' }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    const observed = await processBirth(pid).catch(() => '')
    if (!observed || (expectedBirth && observed !== expectedBirth)) return { exited: true, observedBirth: observed }
    const state = await exec('ps', ['-p', String(pid), '-o', 'stat=']).then(x => x.stdout.trim()).catch(() => '')
    if (state.startsWith('Z')) return { exited: true, observedBirth: observed }
    await sleep(POLL_INTERVAL_MS)
  }
  const observed = await processBirth(pid).catch(() => '')
  const state = await exec('ps', ['-p', String(pid), '-o', 'stat=']).then(x => x.stdout.trim()).catch(() => '')
  return { exited: !observed || state.startsWith('Z') || (!!expectedBirth && observed !== expectedBirth), observedBirth: observed }
}

function writerLeasePath(root: string, repository: string): string {
  return join(root, 'orchestrator', 'locks', `${createHash('sha256').update(`writer:${repository}`).digest('hex')}.json`)
}

async function writerLeaseHeld(root: string, repository: string, owner: string): Promise<boolean> {
  const path = writerLeasePath(root, repository)
  if (!await exists(path)) return false
  const current = await json<{ owner?: string }>(path).catch(() => null)
  return current?.owner === owner
}

async function maybeReleaseWriterLease(dir: string, policy: Policy, owner: string, status: Status): Promise<{ released: boolean; reason: string }> {
  const request = await readRequest(dir)
  if (request.role !== 'code-implementer') return { released: false, reason: 'role does not hold a writer lease' }
  if (!status.attempt_id) return { released: false, reason: 'attempt not recorded' }
  const session = await json<Session>(join(dir, 'session.json')).catch(() => null)
  const attempt = session?.attempts.find(x => x.attempt_id === status.attempt_id)
  if (attempt?.supervisor_pid) {
    const alive = await isProcessAlive(attempt.supervisor_pid, attempt.supervisor_started_at)
    if (alive) return { released: false, reason: 'supervisor still alive' }
  }
  if (!await writerLeaseHeld(policy.state_root, request.workspace.repository, owner)) return { released: false, reason: 'lease not held by this task' }
  await releaseLease(policy.state_root, `writer:${request.workspace.repository}`, owner)
  await appendEvent(dir, 'lease.released', { resource: `writer:${request.workspace.repository}`, owner, after: 'supervisor exit' })
  return { released: true, reason: 'supervisor exited' }
}

export const taskDir = (root: string, taskId: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(taskId)) throw new Error('invalid task ID')
  return join(root, 'tasks', taskId)
}
const projectDir = (root: string, projectId: string) => join(root, 'projects', projectId)
const attemptDir = (dir: string, attemptId: string) => join(dir, 'attempts', attemptId)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd })
  return result.stdout.trim()
}

export async function initialize(repository: string, objective: string, policyPath = defaultPolicyPath): Promise<{ project_id: string; state_root: string; policy_path: string; lead_id: string }> {
  const repo = await realpath(repository)
  if (resolve(policyPath).startsWith(repo + '/')) throw new Error('policy must live outside target repository')
  if (!await exists(policyPath)) {
    await mkdir(dirname(policyPath), { recursive: true })
    const example = join(moduleDir, '..', '..', 'config', 'policy.example.yaml')
    await writeExclusive(policyPath, await readFile(example, 'utf8'))
  }
  const policy = await loadPolicy(policyPath)
  await git(repo, 'rev-parse', '--show-toplevel')
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)
  const projectId = `${slug}-${createHash('sha256').update(repo).digest('hex').slice(0, 8)}`
  const root = policy.state_root
  const dir = projectDir(root, projectId)
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await mkdir(join(root, 'tasks'), { recursive: true })
  await mkdir(join(root, 'orchestrator', 'locks'), { recursive: true })
  if (!await exists(join(dir, 'project.json'))) {
    await atomicJson(join(dir, 'project.json'), { schema_version: 1, project_id: projectId, repository: repo, created_at: now() })
    await atomicWrite(join(dir, 'objective.md'), objective.trim() + '\n')
    await atomicWrite(join(dir, 'constraints.md'), '')
    await atomicWrite(join(dir, 'decisions.md'), '')
    await atomicWrite(join(dir, 'current-state.md'), '')
    await atomicJson(join(dir, 'task-index.json'), { schema_version: 1, tasks: [] })
  }
  await withLock(join(root, 'index.json'), async () => {
    const index = await json<{ schema_version: 1; projects: string[] }>(join(root, 'index.json')).catch(() => ({ schema_version: 1 as const, projects: [] as string[] }))
    if (!index.projects.includes(projectId)) index.projects.push(projectId)
    await atomicJson(join(root, 'index.json'), index)
  })
  const leadId = randomUUID()
  await acquireLease(root, `lead:${projectId}`, leadId)
  return { project_id: projectId, state_root: root, policy_path: policyPath, lead_id: leadId }
}

async function requireLead(policy: Policy, projectId: string): Promise<void> {
  await requireLease(policy.state_root, `lead:${projectId}`, process.env.AGENT_HARNESS_LEAD_ID ?? '')
}

async function workspaceFor(policy: Policy, request: TaskRequest, taskId: string): Promise<string> {
  const repo = await realpath(request.workspace.repository)
  const project = await json<{ repository: string }>(join(projectDir(policy.state_root, request.project_id), 'project.json'))
  if (project.repository !== repo) throw new Error('repository does not match initialized project')
  const ref = request.workspace.git_ref ?? await git(repo, 'rev-parse', 'HEAD')
  const path = join(policy.state_root, 'workspaces', taskId)
  await mkdir(dirname(path), { recursive: true })
  if (request.role === 'code-explorer') await git(repo, 'worktree', 'add', '--detach', path, ref)
  else await git(repo, 'worktree', 'add', '-b', `codex/${taskId}`, path, ref)
  return path
}

async function updateTaskIndex(root: string, projectId: string, taskId: string): Promise<void> {
  const path = join(projectDir(root, projectId), 'task-index.json')
  await withLock(path, async () => {
    const index = await json<{ schema_version: 1; tasks: string[] }>(path)
    if (!index.tasks.includes(taskId)) index.tasks.push(taskId)
    await atomicJson(path, index)
  })
}

export async function delegate(requestFile: string, contextFile?: string): Promise<{ task_id: string; attempt_id: string; state: string }> {
  const raw = YAML.parse(await readFile(requestFile, 'utf8'))
  const request = validateRequest(raw)
  const policy = await loadPolicy()
  await requireLead(policy, request.project_id)
  if ((await realpath(process.env.AGENT_HARNESS_POLICY ?? defaultPolicyPath)).startsWith((await realpath(request.workspace.repository)) + '/')) throw new Error('policy must live outside target repository')
  checkPolicy(policy, request)
  await checkAdjacentEngine(policy, policy.state_root, request, request.model)
  const taskId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  if (request.task_id && request.task_id !== taskId) delete request.task_id
  request.task_id = taskId
  const dir = taskDir(policy.state_root, taskId)
  await mkdir(dir, { recursive: false })
  await writeExclusive(join(dir, 'request.yaml'), YAML.stringify(request))
  await atomicWrite(join(dir, 'context.md'), contextFile ? await readFile(contextFile, 'utf8') : `# Original requirement\n\n${request.objective}\n`)
  await mkdir(join(dir, 'steering'), { recursive: true })
  await mkdir(join(dir, 'logs'), { recursive: true })
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await appendEvent(dir, 'task.created', { task_id: taskId })
  await appendEvent(dir, 'policy.approved', { role: request.role, harness: request.harness, model: request.model })
  await atomicJson(join(dir, 'session.json'), { schema_version: 1, current_attempt_id: '', attempts: [] })
  await setStatus(dir, taskId, '', 'queued', 'preparing workspace')
  await updateTaskIndex(policy.state_root, request.project_id, taskId)
  try {
    const workspace = await workspaceFor(policy, request, taskId)
    await appendEvent(dir, 'workspace.created', { path: workspace, strategy: request.workspace.strategy })
    await atomicWrite(join(dir, 'workspace.txt'), workspace + '\n')
    const attemptId = await startAttempt(policy, request, dir, request.harness, request.model, 'initial')
    return { task_id: taskId, attempt_id: attemptId, state: 'starting' }
  } catch (error) {
    const session = await json<Session>(join(dir, 'session.json'))
    const attempt = session.attempts.at(-1)
    if (attempt) {
      attempt.state = 'failed'
      await atomicJson(join(dir, 'session.json'), session)
    }
    await setStatus(dir, taskId, attempt?.attempt_id ?? '', 'failed', `launch failed: ${String(error)}`)
    await appendEvent(dir, 'worker.failed', { attempt_id: attempt?.attempt_id ?? null, reason: String(error) })
    throw error
  }
}

export async function startAttempt(policy: Policy, request: TaskRequest, dir: string, harness: Harness, model: string, kind: AttemptRequest['kind'], steeringId?: number): Promise<string> {
  checkPolicy(policy, request, harness, model)
  const workspace = (await readFile(join(dir, 'workspace.txt'), 'utf8')).trim()
  const taskId = request.task_id!
  return withLock(join(dir, 'session.json'), async () => {
    const session = await json<Session>(join(dir, 'session.json')).catch(() => ({ schema_version: 1 as const, current_attempt_id: '', attempts: [] as Attempt[] }))
    const latest = session.attempts.at(-1)
    if (latest && !['completed', 'failed', 'cancelled'].includes(latest.state)) throw new Error('current attempt is still active')
    if (latest?.supervisor_pid && !(await awaitSupervisorExit(latest.supervisor_pid, latest.supervisor_started_at, 5000)).exited) throw new Error('previous supervisor is still active')
    const attemptId = `attempt-${String(session.attempts.length + 1).padStart(2, '0')}`
    await acquireLease(policy.state_root, `resume:${taskId}`, attemptId)
    let writerAcquired = false
    try {
    if (request.role === 'code-implementer') {
      await acquireLease(policy.state_root, `writer:${request.workspace.repository}`, taskId)
      writerAcquired = true
    }
    const aDir = attemptDir(dir, attemptId)
    await mkdir(aDir, { recursive: true })
    const context = await readFile(join(dir, 'context.md'), 'utf8')
    const checkpoint = await readFile(join(dir, 'checkpoint.md'), 'utf8').catch(() => '')
    const steering = steeringId ? await readFile(join(dir, 'steering', `${steeringId}.yaml`), 'utf8') : ''
    const prompt = `Role: ${request.role}\nObjective: ${request.objective}\nAcceptance criteria:\n${request.acceptance_criteria.map(x => `- ${x}`).join('\n')}\n\nContext:\n${context}\n\nPrior checkpoint:\n${checkpoint}\n\nSteering:\n${steering}\n\nReturn a concise result with evidence, acceptance status, unresolved risks, and a checkpoint for continuation.`
    const promptFile = join(aDir, 'prompt.md')
    await writeExclusive(promptFile, prompt)
    const effective: AttemptRequest = { schema_version: 1, attempt_id: attemptId, harness, model, workspace_path: workspace, kind, steering_id: steeringId, prompt_file: promptFile, created_at: now() }
    await writeExclusive(join(aDir, 'request.yaml'), YAML.stringify(effective))
    const attempt: Attempt = { attempt_id: attemptId, harness, requested_model: model, continuation_supported: harness === 'codex', state: 'starting' }
    session.attempts.push(attempt)
    session.current_attempt_id = attemptId
    await atomicJson(join(dir, 'session.json'), session)
    await setStatus(dir, taskId, attemptId, 'starting', `${kind} attempt starting`)
    const workerPath = join(moduleDir, 'worker.js')
    const profile = join(dir, 'sandbox.sb')
    const allowed = await Promise.all([dir, join(policy.state_root, 'orchestrator'), '/private/tmp', '/tmp', ...(request.role === 'code-implementer' ? [workspace] : [])].map(async path => await realpath(path).catch(() => path)))
    const escaped = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    await atomicWrite(profile, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (literal "/dev/null"))\n${allowed.map(path => `(allow file-write* (subpath "${escaped(path)}"))`).join('\n')}\n`)
    const supervisorLog = await open(join(aDir, 'supervisor.log'), 'a', 0o600)
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, workerPath, dir, attemptId], { detached: true, stdio: ['ignore', supervisorLog.fd, supervisorLog.fd], env: { ...process.env, AGENT_HARNESS_POLICY: process.env.AGENT_HARNESS_POLICY ?? defaultPolicyPath } })
    await supervisorLog.close()
    child.unref()
    attempt.supervisor_pid = child.pid
    attempt.supervisor_started_at = await processBirth(child.pid!).catch(() => '')
    await atomicJson(join(dir, 'session.json'), session)
    await atomicWrite(join(aDir, 'launch.ready'), '')
    if (steeringId) await appendEvent(dir, 'steering.delivered', { steering_id: steeringId, attempt_id: attemptId })
    if (kind === 'handoff') await appendEvent(dir, 'handoff.started', { attempt_id: attemptId, harness, model })
    return attemptId
    } catch (error) {
      if (writerAcquired) await releaseLease(policy.state_root, `writer:${request.workspace.repository}`, taskId)
      await releaseLease(policy.state_root, `resume:${taskId}`, attemptId)
      throw error
    }
  })
}

export async function setStatus(dir: string, taskId: string, attemptId: string, state: Status['state'], summary: string): Promise<Status> {
  return withLock(join(dir, 'status.json'), async () => {
    const previous = await json<Status>(join(dir, 'status.json')).catch(() => null)
    if (previous?.attempt_id === attemptId && previous.terminal) return previous
    const status: Status = { schema_version: 1, task_id: taskId, state, attempt_id: attemptId, revision: (previous?.revision ?? 0) + 1, updated_at: now(), heartbeat_at: now(), summary, needs_input: state === 'waiting_for_input', terminal: ['completed', 'failed', 'cancelled'].includes(state) }
    await atomicJson(join(dir, 'status.json'), status)
    return status
  })
}

export async function reconcile(dir: string, policy: Policy): Promise<Status> {
  const status = await json<Status>(join(dir, 'status.json'))
  if (status.terminal) {
    await maybeReleaseWriterLease(dir, policy, status.task_id, status)
    return status
  }
  const session = await json<Session>(join(dir, 'session.json')).catch(() => null)
  if (!session) {
    if (Date.now() - Date.parse(status.updated_at) < policy.defaults.stale_after_seconds * 1000) return status
    const failed = await setStatus(dir, status.task_id, status.attempt_id, 'failed', 'launch record missing after controller restart')
    await maybeReleaseWriterLease(dir, policy, status.task_id, failed)
    return failed
  }
  const attempt = session.attempts.find(x => x.attempt_id === status.attempt_id)
  if (!attempt?.supervisor_pid) {
    if (Date.now() - Date.parse(status.updated_at) < policy.defaults.stale_after_seconds * 1000) return status
    const finalized = await finalizeMissing(dir, status, policy, 'supervisor was never recorded')
    await maybeReleaseWriterLease(dir, policy, status.task_id, finalized)
    return finalized
  }
  const birth = await processBirth(attempt.supervisor_pid).catch(() => '')
  const processState = await exec('ps', ['-p', String(attempt.supervisor_pid), '-o', 'stat=']).then(x => x.stdout.trim()).catch(() => '')
  if (!birth || processState.startsWith('Z') || (attempt.supervisor_started_at && birth !== attempt.supervisor_started_at)) {
    const finalized = await finalizeMissing(dir, status, policy, 'supervisor exited without terminal record')
    await maybeReleaseWriterLease(dir, policy, status.task_id, finalized)
    return finalized
  }
  if (Date.now() - Date.parse(status.heartbeat_at) > policy.defaults.stale_after_seconds * 1000) {
    process.kill(attempt.supervisor_pid, 'SIGTERM')
    const finalized = await finalizeMissing(dir, status, policy, 'supervisor heartbeat stale')
    await maybeReleaseWriterLease(dir, policy, status.task_id, finalized)
    return finalized
  }
  return status
}

async function finalizeMissing(dir: string, status: Status, policy: Policy, reason: string): Promise<Status> {
  const session = await json<Session>(join(dir, 'session.json'))
  const attempt = session.attempts.find(x => x.attempt_id === status.attempt_id)
  const aDir = attemptDir(dir, status.attempt_id)
  const resultReady = await exists(join(aDir, 'result.md')) && await exists(join(aDir, 'checkpoint.md'))
  let route: { resolved_group: string; deployment_id: string; fallback_count: number; engine_id: string } | undefined
  if (resultReady && attempt && attempt.harness !== 'fake') {
    const lines = (await readFile(join(attemptDir(dir, attempt.attempt_id), 'routes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    route = lines.length ? JSON.parse(lines.at(-1)!) as typeof route : undefined
    if (route?.engine_id !== policy.models[attempt.requested_model]?.engine_id) route = undefined
  }
  const recovered = resultReady && (attempt?.harness === 'fake' || route)
  if (recovered) {
    await atomicWrite(join(dir, 'result.md'), await readFile(join(aDir, 'result.md'), 'utf8'))
    await atomicWrite(join(dir, 'checkpoint.md'), await readFile(join(aDir, 'checkpoint.md'), 'utf8'))
  }
  await completeAttempt(dir, status.attempt_id, recovered ? 'completed' : 'failed', recovered ? 'result and route recovered after supervisor exit' : reason, route)
  return json<Status>(join(dir, 'status.json'))
}

export async function inspect(taskId: string): Promise<{ request: TaskRequest; status: Status; session: Session; current_attempt: Attempt | null; events: unknown[] }> {
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  await reconcile(dir, policy)
  await recoverQueuedSteering(dir, policy)
  const status = await reconcile(dir, policy)
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x) as unknown)
  const session = await json<Session>(join(dir, 'session.json'))
  return { request: validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8'))), status, session, current_attempt: session.attempts.find(x => x.attempt_id === status.attempt_id) ?? null, events }
}

export type OutputSource = 'harness' | 'stderr' | 'result' | 'supervisor' | 'error' | 'routes'

export async function output(taskId: string, attemptId?: string, source: OutputSource = 'harness', lines = 100): Promise<{ task_id: string; attempt_id: string; harness: Harness; model: string; source: OutputSource; available: boolean; content: string }> {
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error('lines must be an integer from 1 to 1000')
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  const session = await json<Session>(join(dir, 'session.json'))
  const attempt = session.attempts.find(x => x.attempt_id === (attemptId ?? session.current_attempt_id))
  if (!attempt) throw new Error('attempt not found')
  const files: Record<OutputSource, string> = {
    harness: attempt.harness === 'codex' ? 'codex.jsonl' : attempt.harness === 'deepseek' ? 'deepseek.jsonl' : 'result.md',
    stderr: attempt.harness === 'codex' ? 'codex.stderr.log' : 'supervisor.log',
    result: 'result.md', supervisor: 'supervisor.log', error: 'error.log', routes: 'routes.jsonl'
  }
  const path = join(attemptDir(dir, attempt.attempt_id), files[source])
  const available = await exists(path)
  const raw = available ? await readFile(path, 'utf8') : ''
  const content = source === 'result' ? raw : raw.split('\n').slice(-lines - (raw.endsWith('\n') ? 1 : 0)).join('\n')
  return { task_id: taskId, attempt_id: attempt.attempt_id, harness: attempt.harness, model: attempt.requested_model, source, available, content }
}

export async function recoverQueuedSteering(dir: string, policy: Policy): Promise<void> {
  const status = await json<Status>(join(dir, 'status.json')).catch(() => null)
  if (!status?.terminal || status.state !== 'completed') return
  const sequence = Number(await readFile(join(dir, 'steering', 'sequence'), 'utf8').catch(() => '0'))
  if (!sequence) return
  const session = await json<Session>(join(dir, 'session.json'))
  const last = session.attempts.at(-1)!
  // The worker releases its writer lease inside completeAttempt before the supervisor
  // process exits, so a queued steering correction must wait for that supervisor to exit.
  // Starting a new attempt here would fail in startAttempt while the old supervisor runs.
  if (last.supervisor_pid && await isProcessAlive(last.supervisor_pid, last.supervisor_started_at)) return
  const consumed = new Set<number>()
  for (const attempt of session.attempts) {
    const effective = YAML.parse(await readFile(join(attemptDir(dir, attempt.attempt_id), 'request.yaml'), 'utf8')) as AttemptRequest
    if (effective.steering_id) consumed.add(effective.steering_id)
  }
  const pending = Array.from({ length: sequence }, (_, i) => i + 1).find(id => !consumed.has(id))
  if (!pending) return
  const request = await readRequest(dir)
  await startAttempt(policy, request, dir, last.harness, last.requested_model, 'correction', pending).catch(error => {
    if (!String(error).includes('current attempt is still active')) throw error
  })
}

export async function list(projectId?: string): Promise<Array<{ task_id: string; state: string; role: string; harness: string; model: string; resolved_model_group?: string }>> {
  const policy = await loadPolicy()
  const ids = projectId ? (await json<{ tasks: string[] }>(join(projectDir(policy.state_root, projectId), 'task-index.json'))).tasks : await directories(join(policy.state_root, 'tasks'))
  const result = []
  for (const id of ids) {
    const item = await inspect(id).catch(() => null)
    if (item) result.push({ task_id: id, state: item.status.state, role: item.request.role, harness: item.current_attempt?.harness ?? item.request.harness, model: item.current_attempt?.requested_model ?? item.request.model, resolved_model_group: item.current_attempt?.resolved_model_group })
  }
  return result
}

export async function wait(taskId: string, timeoutMs = 0): Promise<Status> {
  const end = timeoutMs ? Date.now() + timeoutMs : Infinity
  let lastRenewal = 0
  for (;;) {
    const inspected = await inspect(taskId)
    const status = inspected.status
    let correctionPending = false
    if (status.state === 'completed') {
      const policy = await loadPolicy()
      const dir = taskDir(policy.state_root, taskId)
      const sequence = Number(await readFile(join(dir, 'steering', 'sequence'), 'utf8').catch(() => '0'))
      if (sequence) {
        const delivered = await Promise.all(inspected.session.attempts.map(async attempt => {
          const effective = YAML.parse(await readFile(join(attemptDir(dir, attempt.attempt_id), 'request.yaml'), 'utf8')) as AttemptRequest
          return effective.steering_id ?? 0
        }))
        correctionPending = Math.max(0, ...delivered) < sequence
      }
    }
    if ((status.terminal && !correctionPending) || status.needs_input || Date.now() >= end) return status
    if (process.env.AGENT_HARNESS_LEAD_ID && Date.now() - lastRenewal > 30000) {
      const policy = await loadPolicy()
      const request = await readRequest(taskDir(policy.state_root, taskId))
      await acquireLease(policy.state_root, `lead:${request.project_id}`, process.env.AGENT_HARNESS_LEAD_ID)
      lastRenewal = Date.now()
    }
    await sleep(500)
  }
}

export async function releaseLead(projectId: string): Promise<{ project_id: string; released: boolean }> {
  const policy = await loadPolicy()
  await requireLead(policy, projectId)
  await releaseLease(policy.state_root, `lead:${projectId}`, process.env.AGENT_HARNESS_LEAD_ID!)
  return { project_id: projectId, released: true }
}

export async function steer(taskId: string, message: string): Promise<{ steering_id: number; state: string }> {
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  const request = validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8')))
  await requireLead(policy, request.project_id)
  const steeringId = await withLock(join(dir, 'steering', 'sequence'), async () => {
    const path = join(dir, 'steering', 'sequence')
    const value = Number(await readFile(path, 'utf8').catch(() => '0')) + 1
    if (value > (policy.defaults.max_correction_cycles ?? 3)) throw new Error('correction cycle limit reached')
    await atomicWrite(path, String(value))
    await writeExclusive(join(dir, 'steering', `${value}.yaml`), YAML.stringify({ schema_version: 1, steering_id: value, created_at: now(), author: 'cli', message }))
    return value
  })
  await appendEvent(dir, 'steering.queued', { steering_id: steeringId })
  const status = await reconcile(dir, policy)
  if (status.terminal) {
    const session = await json<Session>(join(dir, 'session.json'))
    const prior = session.attempts.at(-1)!
    await startAttempt(policy, request, dir, prior.harness, prior.requested_model, 'correction', steeringId)
    return { steering_id: steeringId, state: 'delivered' }
  }
  return { steering_id: steeringId, state: 'queued' }
}

export async function resume(taskId: string): Promise<{ attempt_id: string }> {
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  const request = validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8')))
  await requireLead(policy, request.project_id)
  const session = await json<Session>(join(dir, 'session.json'))
  const prior = session.attempts.at(-1)!
  return { attempt_id: await startAttempt(policy, request, dir, prior.harness, prior.requested_model, 'resume') }
}

export async function handoff(taskId: string, harness: Harness, model: string): Promise<{ attempt_id: string }> {
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  const request = validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8')))
  await requireLead(policy, request.project_id)
  checkPolicy(policy, request, harness, model)
  const status = await reconcile(dir, policy)
  if (!status.terminal) throw new Error('handoff requires a terminal attempt')
  if (!await exists(join(dir, 'checkpoint.md'))) throw new Error('handoff requires a checkpoint')
  const route = await json<{ resolved_engine_id: string }>(join(dir, 'route-summary.json')).catch(() => null)
  if (policy.workflow.require_adjacent_engine_diversity && route?.resolved_engine_id === policy.models[model].engine_id) throw new Error('handoff requires a different engine')
  return { attempt_id: await startAttempt(policy, request, dir, harness, model, 'handoff') }
}

export async function cancel(taskId: string): Promise<{ task_id: string; state: string; writer_lease_released: boolean }> {
  const policy = await loadPolicy()
  const dir = taskDir(policy.state_root, taskId)
  await requireLead(policy, (await readRequest(dir)).project_id)
  const status = await reconcile(dir, policy)
  if (status.terminal) {
    const release = await maybeReleaseWriterLease(dir, policy, taskId, status)
    return { task_id: taskId, state: status.state, writer_lease_released: release.released }
  }
  const session = await json<Session>(join(dir, 'session.json'))
  const current = session.attempts.at(-1)!
  const supervisorPid = current.supervisor_pid
  const supervisorBirth = current.supervisor_started_at
  const supervisorAlive = await isProcessAlive(supervisorPid, supervisorBirth)
  if (supervisorAlive && supervisorPid) process.kill(supervisorPid, 'SIGTERM')
  await setStatus(dir, taskId, current.attempt_id, 'cancelled', 'cancel requested')
  current.state = 'cancelled'
  await atomicJson(join(dir, 'session.json'), session)
  await appendEvent(dir, 'worker.cancelled', { attempt_id: current.attempt_id, supervisor_pid: supervisorPid, supervisor_alive: supervisorAlive })
  const request = await readRequest(dir)
  const graceSeconds = policy.defaults.cancel_grace_seconds ?? DEFAULT_CANCEL_GRACE_SECONDS
  const graceMs = graceSeconds * 1000
  let writerLeaseReleased = true
  if (request.role === 'code-implementer') {
    if (supervisorAlive) {
      const { exited } = await awaitSupervisorExit(supervisorPid, supervisorBirth, graceMs)
      if (exited) {
        await appendEvent(dir, 'worker.exited', { attempt_id: current.attempt_id })
      } else {
        writerLeaseReleased = false
        await appendEvent(dir, 'worker.stop_pending', { attempt_id: current.attempt_id, grace_ms: graceMs, supervisor_pid: supervisorPid, supervisor_birth: supervisorBirth, reason: 'supervisor did not exit within cancel grace; writer lease retained until next reconcile or cancel' })
      }
    }
    if (writerLeaseReleased) await releaseLease(policy.state_root, `writer:${request.workspace.repository}`, taskId)
  }
  await releaseLease(policy.state_root, `resume:${taskId}`, current.attempt_id)
  return { task_id: taskId, state: 'cancelled', writer_lease_released: writerLeaseReleased }
}

async function readRequest(dir: string): Promise<TaskRequest> { return validateRequest(YAML.parse(await readFile(join(dir, 'request.yaml'), 'utf8'))) }

export async function completeAttempt(dir: string, attemptId: string, state: Status['state'], summary: string, route?: { resolved_group: string; deployment_id: string; fallback_count: number; engine_id: string }): Promise<void> {
  const request = await readRequest(dir)
  const currentStatus = await json<Status>(join(dir, 'status.json')).catch(() => null)
  if (currentStatus?.attempt_id === attemptId && currentStatus.terminal) return
  const session = await json<Session>(join(dir, 'session.json'))
  const attempt = session.attempts.find(x => x.attempt_id === attemptId)!
  if (attempt.state === 'cancelled') return
  attempt.state = state
  if (route) {
    attempt.resolved_model_group = route.resolved_group
    attempt.resolved_deployment_id = route.deployment_id
    attempt.fallback_count = route.fallback_count
    await atomicJson(join(dir, 'route-summary.json'), { resolved_engine_id: route.engine_id, ...route })
  }
  await atomicJson(join(dir, 'session.json'), session)
  await setStatus(dir, request.task_id!, attemptId, state, summary)
  await appendEvent(dir, `worker.${state}`, { attempt_id: attemptId, summary })
  const policy = await loadPolicy()
  await releaseLease(policy.state_root, `resume:${request.task_id!}`, attemptId)
  if (state === 'completed' && (await readFile(join(dir, 'attempts', attemptId, 'request.yaml'), 'utf8')).includes('kind: handoff')) await appendEvent(dir, 'handoff.completed', { attempt_id: attemptId })
  // Normal completed/failed finish: result files are already written above and the worker
  // performs no further workspace writes, so release the writer lease now even though the
  // supervisor process is still alive. The cancelled path returns earlier in this function
  // and keeps the lease until the supervisor has exited (see cancel/reconcile).
  if (request.role === 'code-implementer') await releaseLease(policy.state_root, `writer:${request.workspace.repository}`, request.task_id!)
}
