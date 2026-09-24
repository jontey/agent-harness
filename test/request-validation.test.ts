import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { delegate, initialize } from '../src/controller.js'
import { type Policy, type TaskRequest, validateRequest } from '../src/types.js'

const exec = promisify(execFile)

// A canonical, fully-documented first-release explorer request. Mirrors
// examples/task-0007/request.yaml and is used as the base for both valid and
// rejected cases.
function explorerFixture(): TaskRequest {
  return {
    schema_version: 1,
    project_id: 'example-a1b2c3',
    role: 'code-explorer',
    harness: 'codex',
    model: 'north-mini-code',
    objective: 'Trace how authentication state reaches the API client.',
    acceptance_criteria: [
      'Identify the state owner and transformation boundaries.',
      'Cite relevant files and symbols.',
      'Report unresolved ambiguity explicitly.'
    ],
    permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search', 'shell-read', 'git-read'] },
    workspace: { strategy: 'read-only-checkout', repository: '/absolute/path/to/repository', git_ref: 'abc123' }
  }
}

function implementerFixture(): TaskRequest {
  return {
    schema_version: 1,
    project_id: 'example-a1b2c3',
    role: 'code-implementer',
    harness: 'codex',
    model: 'north-mini-code',
    objective: 'Implement the documented fix.',
    acceptance_criteria: ['Land the change behind tests.'],
    permissions: { filesystem: 'workspace-write', network: 'allow', tools: ['file-read', 'file-write'] },
    workspace: { strategy: 'git-worktree', repository: '/absolute/path/to/repository' }
  }
}

// TypeScript-friendly way to mutate a strict-typed TaskRequest into an arbitrary
// object so we can assert that validateRequest rejects unknown / malformed keys.
function mutate(request: TaskRequest): any {
  return request as unknown as any
}

test('documented first-release explorer request validates', () => {
  const request = explorerFixture()
  assert.doesNotThrow(() => validateRequest(request))
})

test('documented first-release implementer request validates', () => {
  const request = implementerFixture()
  assert.doesNotThrow(() => validateRequest(request))
})

test('fully-populated explorer request with every optional field validates', () => {
  const request = explorerFixture()
  request.task_id = 'task-0007'
  request.reasoning_effort = 'high'
  request.scope = { include: ['src/auth', 'src/api'], exclude: ['vendor', 'generated'] }
  request.parent = { task_id: 'lead-0001' }
  request.output_contract = { result: 'result.md', checkpoint: 'checkpoint.md', events: 'events.jsonl' }
  assert.doesNotThrow(() => validateRequest(request))
})

test('minimal request with only required fields validates', () => {
  const request: TaskRequest = {
    schema_version: 1,
    project_id: 'example-a1b2c3',
    role: 'code-explorer',
    harness: 'codex',
    model: 'north-mini-code',
    objective: 'Read the README',
    acceptance_criteria: ['Report content'],
    permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read'] },
    workspace: { strategy: 'read-only-checkout', repository: '/repo' }
  }
  assert.doesNotThrow(() => validateRequest(request))
})

test('rejects unknown top-level fields before task creation', () => {
  const request = mutate(explorerFixture())
  request.rogue_field = 'value'
  assert.throws(() => validateRequest(request), /rogue_field is not a recognised field/)
})

test('rejects multiple unknown top-level fields and names the first', () => {
  const request = mutate(explorerFixture())
  request.something_else = 1
  request.more_bogus = 2
  assert.throws(() => validateRequest(request), /is not a recognised field/)
})

test('rejects non-object requests', () => {
  assert.throws(() => validateRequest(null), /request must be an object/)
  assert.throws(() => validateRequest('hello'), /request must be an object/)
  assert.throws(() => validateRequest([1, 2, 3]), /request must be an object/)
  assert.throws(() => validateRequest(42), /request must be an object/)
})

test('rejects wrong schema_version', () => {
  const request = mutate(explorerFixture())
  request.schema_version = 2
  assert.throws(() => validateRequest(request), /schema_version must be 1/)
})

test('rejects malformed project_id', () => {
  const request = mutate(explorerFixture())
  request.project_id = '-bad-id'
  assert.throws(() => validateRequest(request), /project_id/)
})

test('rejects malformed task_id when provided', () => {
  const request = mutate(explorerFixture())
  request.task_id = 'bad id with spaces'
  assert.throws(() => validateRequest(request), /task_id/)
})

test('rejects model alias with uppercase characters', () => {
  const request = mutate(explorerFixture())
  request.model = 'North-Mini'
  assert.throws(() => validateRequest(request), /model/)
})

test('rejects unsupported role', () => {
  const request = mutate(explorerFixture())
  request.role = 'code-reviewer'
  assert.throws(() => validateRequest(request), /role/)
})

test('rejects unsupported harness', () => {
  const request = mutate(explorerFixture())
  request.harness = 'gpt-cli'
  assert.throws(() => validateRequest(request), /harness/)
})

test('rejects empty or non-string objective', () => {
  const request = mutate(explorerFixture())
  request.objective = ''
  assert.throws(() => validateRequest(request), /objective/)

  const req2 = mutate(explorerFixture())
  req2.objective = 42
  assert.throws(() => validateRequest(req2), /objective/)
})

test('rejects missing required fields', () => {
  const required = ['project_id', 'role', 'harness', 'model', 'objective'] as const
  for (const field of required) {
    const req = mutate(explorerFixture())
    delete req[field]
    assert.throws(() => validateRequest(req), new RegExp(field))
  }
})

test('rejects non-string reasoning_effort and empty string', () => {
  const r1 = mutate(explorerFixture())
  r1.reasoning_effort = 7
  assert.throws(() => validateRequest(r1), /reasoning_effort/)

  const r2 = mutate(explorerFixture())
  r2.reasoning_effort = ''
  assert.throws(() => validateRequest(r2), /reasoning_effort/)
})

test('rejects acceptance_criteria that is not a non-empty string array', () => {
  const r1 = mutate(explorerFixture())
  r1.acceptance_criteria = []
  assert.throws(() => validateRequest(r1), /acceptance_criteria/)

  const r2 = mutate(explorerFixture())
  r2.acceptance_criteria = ['ok', 5]
  assert.throws(() => validateRequest(r2), /acceptance_criteria/)

  const r3 = mutate(explorerFixture())
  r3.acceptance_criteria = 'not an array'
  assert.throws(() => validateRequest(r3), /acceptance_criteria/)
})

// ---- scope ----

test('rejects unknown keys in scope', () => {
  const request = mutate(explorerFixture())
  request.scope = { include: ['src'], unknown: 'value' }
  assert.throws(() => validateRequest(request), /scope.unknown is not a recognised field/)
})

test('rejects non-array scope.include and scope.exclude', () => {
  const request = mutate(explorerFixture())
  request.scope = { include: 'src' }
  assert.throws(() => validateRequest(request), /scope.include/)

  const req2 = mutate(explorerFixture())
  req2.scope = { exclude: 5 }
  assert.throws(() => validateRequest(req2), /scope.exclude/)
})

test('rejects non-string entries in scope arrays', () => {
  const request = mutate(explorerFixture())
  request.scope = { include: ['ok', 7] }
  assert.throws(() => validateRequest(request), /scope.include\[1\]/)
})

test('accepts scope with only include or only exclude', () => {
  const r1 = explorerFixture()
  r1.scope = { include: ['src'] }
  assert.doesNotThrow(() => validateRequest(r1))

  const r2 = explorerFixture()
  r2.scope = { exclude: ['vendor'] }
  assert.doesNotThrow(() => validateRequest(r2))
})

// ---- permissions ----

test('rejects unknown keys in permissions', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'read-only', network: 'allow', tools: ['file-read'], extra: true }
  assert.throws(() => validateRequest(request), /permissions.extra is not a recognised field/)
})

test('rejects permissions.network that is not allow', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'read-only', network: 'deny', tools: ['file-read'] }
  assert.throws(() => validateRequest(request), /permissions.network/)
})

test('rejects permissions.filesystem with an unsupported value', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'no-such-mode', network: 'allow', tools: ['file-read'] }
  assert.throws(() => validateRequest(request), /permissions.filesystem/)
})

test('rejects permissions.tools that is not a string array', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'read-only', network: 'allow', tools: 'shell-write' }
  assert.throws(() => validateRequest(request), /permissions.tools/)

  const req2 = mutate(explorerFixture())
  req2.permissions = { filesystem: 'read-only', network: 'allow', tools: ['file-read', 5] }
  assert.throws(() => validateRequest(req2), /permissions.tools\[1\]/)
})

test('rejects empty or non-string entries inside permissions.tools', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'read-only', network: 'allow', tools: ['file-read', ''] }
  assert.throws(() => validateRequest(request), /permissions.tools\[1\]/)
})

test('rejects permissions.filesystem that does not match the role', () => {
  const request = mutate(explorerFixture())
  request.permissions = { filesystem: 'workspace-write', network: 'allow', tools: ['file-read'] }
  assert.throws(() => validateRequest(request), /filesystem/)
})

test('rejects non-object permissions', () => {
  const request = mutate(explorerFixture())
  request.permissions = 'allow'
  assert.throws(() => validateRequest(request), /permissions must be an object/)
})

// ---- workspace ----

test('rejects unknown keys in workspace', () => {
  const request = mutate(explorerFixture())
  request.workspace = { strategy: 'read-only-checkout', repository: '/x', branch: 'main' }
  assert.throws(() => validateRequest(request), /workspace.branch is not a recognised field/)
})

test('rejects non-absolute workspace.repository', () => {
  const request = mutate(explorerFixture())
  request.workspace.repository = 'relative/repo'
  assert.throws(() => validateRequest(request), /workspace.repository/)

  const req2 = mutate(explorerFixture())
  req2.workspace.repository = 7
  assert.throws(() => validateRequest(req2), /workspace.repository/)
})

test('rejects workspace.strategy that does not match role', () => {
  const request = mutate(explorerFixture())
  request.workspace.strategy = 'git-worktree'
  assert.throws(() => validateRequest(request), /workspace.strategy/)
})

test('rejects unsupported workspace.strategy values', () => {
  const request = mutate(explorerFixture())
  request.workspace.strategy = 'in-place'
  assert.throws(() => validateRequest(request), /workspace.strategy/)
})

test('rejects non-string or empty git_ref', () => {
  const r1 = mutate(explorerFixture())
  r1.workspace.git_ref = 5
  assert.throws(() => validateRequest(r1), /workspace.git_ref/)

  const r2 = mutate(explorerFixture())
  r2.workspace.git_ref = ''
  assert.throws(() => validateRequest(r2), /workspace.git_ref/)
})

// ---- parent ----

test('rejects unknown keys in parent', () => {
  const request = mutate(explorerFixture())
  request.parent = { task_id: 'lead-0001', reason: 'init' }
  assert.throws(() => validateRequest(request), /parent.reason is not a recognised field/)
})

test('rejects malformed parent.task_id', () => {
  const request = mutate(explorerFixture())
  request.parent = { task_id: 'bad id' }
  assert.throws(() => validateRequest(request), /parent.task_id/)

  const req2 = mutate(explorerFixture())
  req2.parent = { task_id: 5 }
  assert.throws(() => validateRequest(req2), /parent.task_id/)
})

// ---- output_contract ----

test('rejects unknown keys in output_contract', () => {
  const request = mutate(explorerFixture())
  request.output_contract = { result: 'result.md', checkpoint: 'checkpoint.md', events: 'events.jsonl', extra: 'x' }
  assert.throws(() => validateRequest(request), /output_contract.extra is not a recognised field/)
})

test('rejects output_contract with non-canonical paths', () => {
  const request = mutate(explorerFixture())
  request.output_contract = { result: 'out.md', checkpoint: 'checkpoint.md', events: 'events.jsonl' }
  assert.throws(() => validateRequest(request), /output_contract/)
})

// ---- end-to-end: rejection prevents task creation ----

test('unknown field rejection prevents task creation during delegate', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-validate-'))
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
    models: { 'north-mini-code': { engine_id: 'a', litellm_model_group: 'north-mini-code', permitted_fallback_engines: [] } },
    roles: {
      'code-explorer': { allowed_harnesses: ['fake'], allowed_models: ['north-mini-code'], filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read'] }
    },
    workflow: { require_adjacent_engine_diversity: false }
  }
  await writeFile(policyPath, YAML.stringify(policy))
  process.env.AGENT_HARNESS_POLICY = policyPath
  const project = await initialize(repo, 'Explore the repository', policyPath)
  process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
  const request: Record<string, unknown> = {
    schema_version: 1,
    project_id: project.project_id,
    role: 'code-explorer',
    harness: 'fake',
    model: 'north-mini-code',
    objective: 'Read the README',
    acceptance_criteria: ['Report content'],
    permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read'] },
    workspace: { strategy: 'read-only-checkout', repository: repo },
    rogue_field: 'must be rejected'
  }
  const requestFile = join(base, 'request.yaml')
  await writeFile(requestFile, YAML.stringify(request))
  try {
    await assert.rejects(delegate(requestFile), /rogue_field is not a recognised field/)
    // The task directory must not have been created.
    const tasksDir = join(stateRoot, 'tasks')
    const entries = await import('node:fs/promises').then(fs => fs.readdir(tasksDir).catch(() => []))
    assert.deepEqual(entries, [], 'no task directory should be created when validation fails')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('malformed nested field rejection prevents task creation during delegate', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-validate-'))
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
    models: { 'north-mini-code': { engine_id: 'a', litellm_model_group: 'north-mini-code', permitted_fallback_engines: [] } },
    roles: {
      'code-explorer': { allowed_harnesses: ['fake'], allowed_models: ['north-mini-code'], filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read'] }
    },
    workflow: { require_adjacent_engine_diversity: false }
  }
  await writeFile(policyPath, YAML.stringify(policy))
  process.env.AGENT_HARNESS_POLICY = policyPath
  const project = await initialize(repo, 'Explore the repository', policyPath)
  process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
  const request: Record<string, unknown> = {
    schema_version: 1,
    project_id: project.project_id,
    role: 'code-explorer',
    harness: 'fake',
    model: 'north-mini-code',
    objective: 'Read the README',
    acceptance_criteria: ['Report content'],
    permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read'] },
    workspace: { strategy: 'read-only-checkout', repository: repo },
    scope: { include: ['src', 5] }
  }
  const requestFile = join(base, 'request.yaml')
  await writeFile(requestFile, YAML.stringify(request))
  try {
    await assert.rejects(delegate(requestFile), /scope.include\[1\]/)
    const tasksDir = join(stateRoot, 'tasks')
    const entries = await import('node:fs/promises').then(fs => fs.readdir(tasksDir).catch(() => []))
    assert.deepEqual(entries, [], 'no task directory should be created when nested validation fails')
  } finally { await rm(base, { recursive: true, force: true }) }
})