import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import YAML from 'yaml'
import { acquireLease, releaseLease, requireLease } from '../src/leases.js'
import { appendEvent, atomicJson, atomicWrite, json, sleep } from '../src/store.js'
import { awaitSupervisorExit, cancel, completeAttempt, initialize, inspect, processBirth, reconcile, resume } from '../src/controller.js'
import { type Attempt, type Policy, type Session, type Status, type TaskRequest } from '../src/types.js'

const exec = promisify(execFile)

async function fixture(options: { cancelGraceSeconds?: number; heartbeatSeconds?: number; staleSeconds?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-cancel-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'README.md'), 'test source\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  const stateRoot = join(base, 'state')
  const policyPath = join(base, 'policy.yaml')
  const policy: Policy = {
    schema_version: 1, state_root: stateRoot,
    defaults: {
      heartbeat_interval_seconds: options.heartbeatSeconds ?? 1,
      stale_after_seconds: options.staleSeconds ?? 5,
      require_resolved_route: true,
      allow_cross_engine_fallback: false,
      cancel_grace_seconds: options.cancelGraceSeconds ?? 30
    },
    providers: { litellm: { base_url_env: 'LITELLM_BASE_URL', api_key_env: 'LITELLM_API_KEY' } },
    models: { alpha: { engine_id: 'a', litellm_model_group: 'alpha', permitted_fallback_engines: [] }, beta: { engine_id: 'b', litellm_model_group: 'beta', permitted_fallback_engines: [] } },
    roles: {
      'code-explorer': { allowed_harnesses: ['fake'], allowed_models: ['alpha', 'beta'], filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read'] },
      'code-implementer': { allowed_harnesses: ['fake'], allowed_models: ['alpha', 'beta'], filesystem: 'workspace-write', network: 'allow', workspace_strategy: 'git-worktree', tools: ['file-read', 'file-write'], exclusive_writer: true }
    },
    workflow: { require_adjacent_engine_diversity: true }
  }
  await writeFile(policyPath, YAML.stringify(policy))
  process.env.AGENT_HARNESS_POLICY = policyPath
  const project = await initialize(repo, 'Test repo', policyPath)
  process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
  return { base, repo, stateRoot, policyPath, policy, project }
}

function implementerRequest(f: Awaited<ReturnType<typeof fixture>>, repository: string): TaskRequest {
  return {
    schema_version: 1,
    project_id: f.project.project_id,
    role: 'code-implementer',
    harness: 'fake',
    model: 'alpha',
    objective: 'Edit a file',
    acceptance_criteria: ['Make the change'],
    permissions: { filesystem: 'workspace-write', network: 'allow', tools: ['file-read', 'file-write'] },
    workspace: { strategy: 'git-worktree', repository }
  }
}

/**
 * Create a synthetic running task that has the writer lease held but with a controllable
 * supervisor PID. Returns a handle that can be used to mark the supervisor exited later.
 */
async function syntheticRunningImplementer(f: Awaited<ReturnType<typeof fixture>>, options: { supervisorPid: number; supervisorStartedAt: string }) {
  const request = implementerRequest(f, f.repo)
  const taskId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  request.task_id = taskId
  const dir = join(f.stateRoot, 'tasks', taskId)
  await mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, 'request.yaml'), YAML.stringify(request))
  await atomicWrite(join(dir, 'context.md'), request.objective + '\n')
  await atomicWrite(join(dir, 'workspace.txt'), f.repo + '\n')
  await mkdir(join(dir, 'attempts', 'attempt-01'), { recursive: true })
  await atomicJson(join(dir, 'attempts', 'attempt-01', 'request.yaml'), {
    schema_version: 1,
    attempt_id: 'attempt-01',
    harness: 'fake',
    model: 'alpha',
    workspace_path: f.repo,
    kind: 'initial',
    prompt_file: join(dir, 'attempts', 'attempt-01', 'prompt.md'),
    created_at: new Date().toISOString()
  })
  await atomicWrite(join(dir, 'attempts', 'attempt-01', 'prompt.md'), 'synthetic prompt\n')
  await atomicJson(join(dir, 'session.json'), {
    schema_version: 1,
    current_attempt_id: 'attempt-01',
    attempts: [{
      attempt_id: 'attempt-01',
      harness: 'fake',
      requested_model: 'alpha',
      continuation_supported: false,
      state: 'running',
      supervisor_pid: options.supervisorPid,
      supervisor_started_at: options.supervisorStartedAt
    } satisfies Attempt]
  })
  await atomicJson(join(dir, 'status.json'), {
    schema_version: 1,
    task_id: taskId,
    state: 'running',
    attempt_id: 'attempt-01',
    revision: 1,
    updated_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    summary: 'synthetic running',
    needs_input: false,
    terminal: false
  } satisfies Status)
  await acquireLease(f.stateRoot, `writer:${f.repo}`, taskId)
  await acquireLease(f.stateRoot, `resume:${taskId}`, 'attempt-01')
  await appendEvent(dir, 'task.created', { task_id: taskId })
  return { taskId, dir, request }
}

test('cancel after the supervisor has exited finalises the attempt and releases the writer lease', async () => {
  const f = await fixture({ cancelGraceSeconds: 1 })
  try {
    // Spawn a child that we will let exit naturally before calling cancel so the supervisor is
    // already gone when cancel starts. The status remains "running" so cancel goes through
    // reconcile, which will detect the missing supervisor and finalise the attempt.
    const exitedChild = spawn('/bin/sh', ['-c', 'sleep 0.05'], { stdio: 'ignore' })
    const exitedPid = exitedChild.pid!
    const exitedBirth = await processBirth(exitedPid).catch(() => '')
    await new Promise<void>(resolve => exitedChild.once('exit', () => resolve()))
    assert.ok(exitedBirth, 'processBirth should observe the brief start of the short-lived child')
    // Give the OS a moment to reap the zombie before cancel observes the missing PID.
    await sleep(50)
    const { taskId } = await syntheticRunningImplementer(f, { supervisorPid: exitedPid, supervisorStartedAt: exitedBirth })
    const writerResource = `writer:${f.repo}`
    const result = await cancel(taskId)
    // Reconcile will have detected the missing supervisor and finalised the attempt as failed.
    assert.ok(['failed', 'cancelled'].includes(result.state), `unexpected state: ${result.state}`)
    // The writer lease must be released: reconcile's finalisation went through completeAttempt
    // and observed the supervisor is gone.
    await assert.rejects(requireLease(f.stateRoot, writerResource, taskId), /active lease required/)
    // A new implementer can now acquire the writer lease.
    await acquireLease(f.stateRoot, writerResource, 'next-implementer')
    await releaseLease(f.stateRoot, writerResource, 'next-implementer')
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('cancel retains the writer lease while the supervisor is alive past the grace period', async () => {
  const f = await fixture({ cancelGraceSeconds: 1 })
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  slowChild.unref()
  try {
    const supervisorPid = slowChild.pid!
    const supervisorStartedAt = await processBirth(supervisorPid)
    assert.ok(supervisorStartedAt)
    const { taskId, dir } = await syntheticRunningImplementer(f, { supervisorPid, supervisorStartedAt })
    const writerResource = `writer:${f.repo}`
    const startedAt = Date.now()
    const result = await cancel(taskId)
    const elapsed = Date.now() - startedAt
    assert.equal(result.state, 'cancelled')
    assert.equal(result.writer_lease_released, false, 'writer lease must remain held while the supervisor is alive past grace')
    assert.ok(elapsed >= 1000, 'cancel must wait at least the grace duration')
    // Writer lease is still held by this task — a second implementer cannot acquire it.
    await requireLease(f.stateRoot, writerResource, taskId)
    await assert.rejects(acquireLease(f.stateRoot, writerResource, 'second-implementer'), /resource already leased/)
    // The cancel event stream recorded the durable "stop pending" marker.
    const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string })
    assert.ok(events.some(e => e.type === 'worker.stop_pending'), 'a worker.stop_pending event must record the grace-exceeded state')
    assert.ok(events.some(e => e.type === 'worker.cancelled'), 'a worker.cancelled event must be recorded even when the supervisor is still alive')
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a second implementer is rejected while the first cancellation is still waiting for the supervisor', async () => {
  const f = await fixture({ cancelGraceSeconds: 2 })
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  slowChild.unref()
  try {
    const supervisorPid = slowChild.pid!
    const supervisorStartedAt = await processBirth(supervisorPid)
    assert.ok(supervisorStartedAt)
    const { taskId } = await syntheticRunningImplementer(f, { supervisorPid, supervisorStartedAt })
    const writerResource = `writer:${f.repo}`
    // Kick off cancel without awaiting and race a second acquisition against it.
    const cancelPromise = cancel(taskId)
    // The writer lease must remain held for the duration of the cancel wait.
    let acquired = false
    for (let i = 0; i < 60 && !acquired; i++) {
      try { await acquireLease(f.policy.state_root, writerResource, 'second-implementer'); acquired = true }
      catch { acquired = false }
      if (!acquired) await sleep(50)
    }
    assert.equal(acquired, false, 'a second implementer must not acquire the writer lease during cancellation')
    const result = await cancelPromise
    assert.equal(result.writer_lease_released, false)
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('reconcile releases the writer lease once the supervisor is gone after a cancel that timed out', async () => {
  const f = await fixture({ cancelGraceSeconds: 1 })
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  slowChild.unref()
  try {
    const supervisorPid = slowChild.pid!
    const supervisorStartedAt = await processBirth(supervisorPid)
    assert.ok(supervisorStartedAt)
    const { taskId } = await syntheticRunningImplementer(f, { supervisorPid, supervisorStartedAt })
    const writerResource = `writer:${f.repo}`
    // Cancel will exceed grace and leave the lease held.
    const result = await cancel(taskId)
    assert.equal(result.writer_lease_released, false)
    await assert.rejects(acquireLease(f.policy.state_root, writerResource, 'second-implementer'), /resource already leased/)
    // Kill the supervisor so it actually exits, then call reconcile via inspect and verify the lease is freed.
    slowChild.kill('SIGKILL')
    await sleep(100)
    await inspect(taskId)
    // A second implementer can now acquire the lease.
    await acquireLease(f.policy.state_root, writerResource, 'recovery-implementer')
    await releaseLease(f.policy.state_root, writerResource, 'recovery-implementer')
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('reconcile keeps the writer lease when the supervisor is alive and the status is cancelled', async () => {
  const f = await fixture({ cancelGraceSeconds: 1 })
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  slowChild.unref()
  try {
    const supervisorPid = slowChild.pid!
    const supervisorStartedAt = await processBirth(supervisorPid)
    assert.ok(supervisorStartedAt)
    const { taskId } = await syntheticRunningImplementer(f, { supervisorPid, supervisorStartedAt })
    const writerResource = `writer:${f.repo}`
    // Force the status to terminal cancelled (as if cancel had already run), but keep the supervisor alive.
    await atomicJson(join(f.stateRoot, 'tasks', taskId, 'status.json'), {
      schema_version: 1,
      task_id: taskId,
      state: 'cancelled',
      attempt_id: 'attempt-01',
      revision: 2,
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      summary: 'cancel requested; awaiting worker stop',
      needs_input: false,
      terminal: true
    } satisfies Status)
    // Reconcile should leave the writer lease intact because the supervisor is still alive.
    const policy = f.policy
    const reconciled = await reconcile(join(f.stateRoot, 'tasks', taskId), policy)
    assert.equal(reconciled.state, 'cancelled')
    // The writer lease must still be held by the original task.
    await requireLease(f.stateRoot, writerResource, taskId)
    await assert.rejects(acquireLease(f.stateRoot, writerResource, 'second-implementer'), /resource already leased/)
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a completed implementer releases the writer lease before the supervisor process exits', async () => {
  const f = await fixture()
  const longChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  longChild.unref()
  try {
    const supervisorPid = longChild.pid!
    const supervisorStartedAt = await processBirth(supervisorPid)
    assert.ok(supervisorStartedAt)
    const { taskId, dir } = await syntheticRunningImplementer(f, { supervisorPid, supervisorStartedAt })
    const writerResource = `writer:${f.repo}`
    // Simulate the worker's normal finish: result files are written first, then the worker
    // calls completeAttempt while the supervisor process is still alive.
    await atomicWrite(join(dir, 'attempts', 'attempt-01', 'result.md'), 'result\n')
    await atomicWrite(join(dir, 'attempts', 'attempt-01', 'checkpoint.md'), 'checkpoint\n')
    await completeAttempt(dir, 'attempt-01', 'completed', 'worker completed')
    const status = await json<Status>(join(dir, 'status.json'))
    assert.equal(status.state, 'completed')
    assert.equal(status.terminal, true)
    // The writer lease must be gone even though the supervisor process is still running.
    await assert.rejects(requireLease(f.stateRoot, writerResource, taskId), /active lease required/)
    // A second implementer can acquire the writer lease immediately, without waiting for
    // the old supervisor to exit or for the lease TTL to expire.
    await acquireLease(f.stateRoot, writerResource, 'second-implementer')
    await releaseLease(f.stateRoot, writerResource, 'second-implementer')
  } finally {
    longChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('awaitSupervisorExit returns immediately when the process is already gone', async () => {
  const { exited } = await awaitSupervisorExit(999999, 'synthetic', 1000)
  assert.equal(exited, true)
})

test('processBirth returns empty for non-existent pids', async () => {
  const birth = await processBirth(999999).catch(() => '')
  assert.equal(birth, '')
})

test('expired writer lease remains fenced while its supervisor is alive', async () => {
  const f = await fixture()
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  try {
    const birth = await processBirth(slowChild.pid!)
    const { taskId } = await syntheticRunningImplementer(f, { supervisorPid: slowChild.pid!, supervisorStartedAt: birth })
    await acquireLease(f.stateRoot, `writer:${f.repo}`, taskId, 1)
    await sleep(10)
    await assert.rejects(acquireLease(f.stateRoot, `writer:${f.repo}`, 'second-implementer'), /live writer/)
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})

test('a cancelled task cannot resume while its prior supervisor is alive', async () => {
  const f = await fixture()
  const slowChild = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' })
  try {
    const birth = await processBirth(slowChild.pid!)
    const { taskId, dir } = await syntheticRunningImplementer(f, { supervisorPid: slowChild.pid!, supervisorStartedAt: birth })
    const session = await json<Session>(join(dir, 'session.json'))
    session.attempts[0].state = 'cancelled'
    await atomicJson(join(dir, 'session.json'), session)
    const status = await json<Status>(join(dir, 'status.json'))
    status.state = 'cancelled'
    status.terminal = true
    await atomicJson(join(dir, 'status.json'), status)
    await assert.rejects(resume(taskId), /previous supervisor is still active/)
  } finally {
    slowChild.kill('SIGKILL')
    await rm(f.base, { recursive: true, force: true })
  }
})
