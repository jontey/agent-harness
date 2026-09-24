import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { appendEvent, atomicJson, directories, json } from '../src/store.js'
import { checkPolicy } from '../src/policy.js'
import { acquireLease, releaseLease } from '../src/leases.js'
import { sleep } from '../src/store.js'
import { delegate, handoff, initialize, inspect, steer, wait } from '../src/controller.js'
import { validateRequest, type Policy, type TaskRequest } from '../src/types.js'

const exec = promisify(execFile)

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-test-'))
  const repo = join(base, 'repo')
  await import('node:fs/promises').then(fs => fs.mkdir(repo))
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'README.md'), 'test source\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
  const stateRoot = join(base, 'state')
  const policyPath = join(base, 'policy.yaml')
  const policy: Policy = {
    schema_version: 1, state_root: stateRoot,
    defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 5, require_resolved_route: true, allow_cross_engine_fallback: false },
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
  const project = await initialize(repo, 'Explore the repository', policyPath)
  process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
  const request: TaskRequest = { schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'fake', model: 'alpha', objective: 'Read the README', acceptance_criteria: ['Report content'], permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read'] }, workspace: { strategy: 'read-only-checkout', repository: repo } }
  const requestFile = join(base, 'request.yaml')
  await writeFile(requestFile, YAML.stringify(request))
  return { base, repo, stateRoot, policyPath, policy, request, requestFile }
}

test('request and policy reject invalid permissions and routes', async () => {
  const f = await fixture()
  try {
    assert.throws(() => validateRequest({ ...f.request, permissions: { ...f.request.permissions, network: 'deny' } }))
    assert.throws(() => checkPolicy(f.policy, { ...f.request, model: 'unknown' }))
    assert.throws(() => checkPolicy(f.policy, { ...f.request, permissions: { ...f.request.permissions, tools: ['shell-write'] } }))
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('events stay ordered under concurrent appends', async () => {
  const f = await fixture()
  try {
    const dir = join(f.base, 'events')
    await import('node:fs/promises').then(fs => fs.mkdir(dir))
    await Promise.all(Array.from({ length: 30 }, (_, i) => appendEvent(dir, 'progress', { i })))
    const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x) as { seq: number })
    assert.deepEqual(events.map(x => x.seq), Array.from({ length: 30 }, (_, i) => i + 1))
    await atomicJson(join(dir, 'status.json'), { revision: 1 })
    assert.deepEqual(await json(join(dir, 'status.json')), { revision: 1 })
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('exclusive lease rejects a second owner', async () => {
  const f = await fixture()
  try {
    await acquireLease(f.stateRoot, 'writer:repo', 'first')
    await assert.rejects(acquireLease(f.stateRoot, 'writer:repo', 'second'))
    await acquireLease(f.stateRoot, 'expiring', 'first', 1)
    await sleep(5)
    await acquireLease(f.stateRoot, 'expiring', 'second')
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('writer conflict releases the failed attempt resume lease', async () => {
  const f = await fixture()
  try {
    const implementerRequest: TaskRequest = { ...f.request, role: 'code-implementer', permissions: { filesystem: 'workspace-write', network: 'allow', tools: ['file-read', 'file-write'] }, workspace: { strategy: 'git-worktree', repository: f.repo } }
    await writeFile(f.requestFile, YAML.stringify(implementerRequest))
    await acquireLease(f.stateRoot, `writer:${f.repo}`, 'other-task')
    await assert.rejects(delegate(f.requestFile), /resource already leased/)
    const [taskId] = await directories(join(f.stateRoot, 'tasks'))
    assert.ok(taskId)
    const failed = await inspect(taskId)
    assert.equal(failed.status.state, 'failed')
    assert.match(failed.status.summary, /resource already leased/)
    await acquireLease(f.stateRoot, `resume:${taskId}`, 'replacement-attempt')
    await releaseLease(f.stateRoot, `writer:${f.repo}`, 'other-task')
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('fake adapter completes, steers, and hands off within one task', async () => {
  const f = await fixture()
  try {
    const delegated = await delegate(f.requestFile)
    const first = await wait(delegated.task_id, 10000)
    if (first.state !== 'completed') {
      const log = await readFile(join(f.stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'supervisor.log'), 'utf8').catch(() => '')
      assert.equal(first.state, 'completed', `${first.summary}\n${log}`)
    }
    const correction = await steer(delegated.task_id, 'Also report the filename')
    assert.equal(correction.state, 'delivered')
    const second = await wait(delegated.task_id, 10000)
    assert.equal(second.state, 'completed', second.summary)
    assert.notEqual(second.attempt_id, first.attempt_id)
    const next = await handoff(delegated.task_id, 'fake', 'beta')
    const third = await wait(delegated.task_id, 10000)
    assert.equal(third.state, 'completed', third.summary)
    assert.equal(third.attempt_id, next.attempt_id)
    const bundle = await inspect(delegated.task_id)
    assert.equal(bundle.session.attempts.length, 3)
    assert.equal(bundle.session.attempts[0].requested_model, 'alpha')
    assert.equal(bundle.session.attempts[2].requested_model, 'beta')
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('macOS sandbox denies explorer writes and confines implementer writes', async () => {
  if (process.platform !== 'darwin') return
  const f = await fixture()
  try {
    const explorer = await delegate(f.requestFile)
    assert.equal((await wait(explorer.task_id, 10000)).state, 'completed')
    const explorerDir = join(f.stateRoot, 'tasks', explorer.task_id)
    const explorerProfile = join(explorerDir, 'sandbox.sb')
    const explorerWorkspace = (await readFile(join(explorerDir, 'workspace.txt'), 'utf8')).trim()
    await assert.rejects(exec('/usr/bin/sandbox-exec', ['-f', explorerProfile, '/usr/bin/touch', join(explorerWorkspace, 'blocked')]))
    await exec('/usr/bin/sandbox-exec', ['-f', explorerProfile, '/usr/bin/touch', join(explorerDir, 'artifacts', 'allowed')])

    const implementerRequest: TaskRequest = { ...f.request, role: 'code-implementer', permissions: { filesystem: 'workspace-write', network: 'allow', tools: ['file-read', 'file-write'] }, workspace: { strategy: 'git-worktree', repository: f.repo } }
    await writeFile(f.requestFile, YAML.stringify(implementerRequest))
    const implementer = await delegate(f.requestFile)
    assert.equal((await wait(implementer.task_id, 10000)).state, 'completed')
    const implementerDir = join(f.stateRoot, 'tasks', implementer.task_id)
    const implementerProfile = join(implementerDir, 'sandbox.sb')
    const implementerWorkspace = (await readFile(join(implementerDir, 'workspace.txt'), 'utf8')).trim()
    await exec('/usr/bin/sandbox-exec', ['-f', implementerProfile, '/usr/bin/touch', join(implementerWorkspace, 'allowed')])
    await assert.rejects(exec('/usr/bin/sandbox-exec', ['-f', implementerProfile, '/usr/bin/touch', join(f.repo, 'blocked')]))
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('restart reconciliation recovers finished artifacts after supervisor loss', async () => {
  const f = await fixture()
  try {
    const delegated = await delegate(f.requestFile)
    assert.equal((await wait(delegated.task_id, 10000)).state, 'completed')
    const dir = join(f.stateRoot, 'tasks', delegated.task_id)
    const session = await json<{ attempts: Array<{ supervisor_pid?: number; supervisor_started_at?: string; state: string }> }>(join(dir, 'session.json'))
    session.attempts[0].supervisor_pid = 999999
    session.attempts[0].supervisor_started_at = 'old process'
    session.attempts[0].state = 'running'
    await atomicJson(join(dir, 'session.json'), session)
    const status = await json<Record<string, unknown>>(join(dir, 'status.json'))
    status.state = 'running'
    status.terminal = false
    await atomicJson(join(dir, 'status.json'), status)
    const recovered = await inspect(delegated.task_id)
    assert.equal(recovered.status.state, 'completed')
    assert.match(recovered.status.summary, /recovered/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})
