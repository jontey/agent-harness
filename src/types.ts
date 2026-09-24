export type Role = 'code-explorer' | 'code-implementer'
export type Harness = 'codex' | 'deepseek' | 'fake'
export type State = 'queued' | 'starting' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'

export interface TaskRequest {
  schema_version: 1
  task_id?: string
  project_id: string
  role: Role
  harness: Harness
  model: string
  reasoning_effort?: string
  objective: string
  scope?: { include?: string[]; exclude?: string[] }
  acceptance_criteria: string[]
  permissions: { filesystem: 'read-only' | 'workspace-write'; network: 'allow'; tools: string[] }
  workspace: { strategy: 'read-only-checkout' | 'git-worktree'; repository: string; git_ref?: string }
  parent?: { task_id: string }
  output_contract?: { result: string; checkpoint: string; events: string }
}

export interface AttemptRequest {
  schema_version: 1
  attempt_id: string
  harness: Harness
  model: string
  workspace_path: string
  kind: 'initial' | 'resume' | 'correction' | 'handoff'
  steering_id?: number
  prompt_file: string
  created_at: string
}

export interface Status {
  schema_version: 1
  task_id: string
  state: State
  attempt_id: string
  revision: number
  updated_at: string
  heartbeat_at: string
  summary: string
  needs_input: boolean
  terminal: boolean
}

export interface Attempt {
  attempt_id: string
  harness: Harness
  requested_model: string
  native_session_id?: string
  supervisor_pid?: number
  supervisor_started_at?: string
  process_started_at?: string
  resolved_model_group?: string
  resolved_deployment_id?: string
  fallback_count?: number
  continuation_supported: boolean
  state: State
}

export interface Session {
  schema_version: 1
  current_attempt_id: string
  attempts: Attempt[]
}

export interface Policy {
  schema_version: 1
  state_root: string
  defaults: { heartbeat_interval_seconds: number; stale_after_seconds: number; require_resolved_route: boolean; allow_cross_engine_fallback: boolean; max_correction_cycles?: number; cancel_grace_seconds?: number }
  providers: { litellm: { base_url_env: string; api_key_env: string } }
  models: Record<string, { engine_id: string; litellm_model_group: string; permitted_fallback_engines: string[] }>
  roles: Record<string, { allowed_harnesses: Harness[]; allowed_models: string[]; filesystem: string; network: string; workspace_strategy: string; tools: string[]; exclusive_writer?: boolean }>
  workflow: { require_adjacent_engine_diversity: boolean }
}

export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
}

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const MODEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/

const KNOWN_TOP_LEVEL_KEYS = [
  'schema_version', 'task_id', 'project_id', 'role', 'harness', 'model',
  'reasoning_effort', 'objective', 'scope', 'acceptance_criteria',
  'permissions', 'workspace', 'parent', 'output_contract'
] as const

const KNOWN_PERMISSION_KEYS = ['filesystem', 'network', 'tools'] as const
const KNOWN_WORKSPACE_KEYS = ['strategy', 'repository', 'git_ref'] as const
const KNOWN_SCOPE_KEYS = ['include', 'exclude'] as const
const KNOWN_PARENT_KEYS = ['task_id'] as const
const KNOWN_OUTPUT_CONTRACT_KEYS = ['result', 'checkpoint', 'events'] as const

function ensureKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${path}.${key} is not a recognised field`)
  }
}

function ensureStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`)
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') throw new Error(`${path}[${i}] must be a string`)
  }
}

function validateScope(value: unknown, path: string): void {
  assertObject(value, path)
  ensureKeys(value, KNOWN_SCOPE_KEYS, path)
  if (value.include !== undefined) ensureStringArray(value.include, `${path}.include`)
  if (value.exclude !== undefined) ensureStringArray(value.exclude, `${path}.exclude`)
}

function validatePermissions(value: unknown, path: string): { filesystem: 'read-only' | 'workspace-write'; network: 'allow'; tools: string[] } {
  assertObject(value, path)
  ensureKeys(value, KNOWN_PERMISSION_KEYS, path)
  if (value.filesystem !== 'read-only' && value.filesystem !== 'workspace-write') {
    throw new Error(`${path}.filesystem must be read-only or workspace-write`)
  }
  if (value.network !== 'allow') throw new Error(`${path}.network must be allow in the first release`)
  if (!Array.isArray(value.tools)) throw new Error(`${path}.tools must be an array of strings`)
  for (let i = 0; i < value.tools.length; i++) {
    if (typeof value.tools[i] !== 'string' || !(value.tools[i] as string)) {
      throw new Error(`${path}.tools[${i}] must be a non-empty string`)
    }
  }
  return value as { filesystem: 'read-only' | 'workspace-write'; network: 'allow'; tools: string[] }
}

function validateWorkspace(value: unknown, path: string, expectedStrategy: 'read-only-checkout' | 'git-worktree'): { strategy: 'read-only-checkout' | 'git-worktree'; repository: string; git_ref?: string } {
  assertObject(value, path)
  ensureKeys(value, KNOWN_WORKSPACE_KEYS, path)
  if (value.strategy !== 'read-only-checkout' && value.strategy !== 'git-worktree') {
    throw new Error(`${path}.strategy must be read-only-checkout or git-worktree`)
  }
  if (value.strategy !== expectedStrategy) {
    throw new Error(`${path}.strategy does not match role; expected ${expectedStrategy}`)
  }
  if (typeof value.repository !== 'string' || !value.repository.startsWith('/')) {
    throw new Error(`${path}.repository must be an absolute path`)
  }
  if (value.git_ref !== undefined) {
    if (typeof value.git_ref !== 'string' || !value.git_ref) {
      throw new Error(`${path}.git_ref must be a non-empty string when provided`)
    }
  }
  return value as { strategy: 'read-only-checkout' | 'git-worktree'; repository: string; git_ref?: string }
}

function validateParent(value: unknown, path: string): void {
  assertObject(value, path)
  ensureKeys(value, KNOWN_PARENT_KEYS, path)
  if (typeof value.task_id !== 'string' || !TASK_ID_PATTERN.test(value.task_id)) {
    throw new Error(`${path}.task_id must match the task-id slug pattern`)
  }
}

function validateOutputContract(value: unknown, path: string): void {
  assertObject(value, path)
  ensureKeys(value, KNOWN_OUTPUT_CONTRACT_KEYS, path)
  if (value.result !== 'result.md' || value.checkpoint !== 'checkpoint.md' || value.events !== 'events.jsonl') {
    throw new Error(`${path} must use the canonical paths result.md/checkpoint.md/events.jsonl`)
  }
}

export function validateRequest(value: unknown): TaskRequest {
  assertObject(value, 'request')
  ensureKeys(value, KNOWN_TOP_LEVEL_KEYS, 'request')
  if (value.schema_version !== 1) throw new Error('request.schema_version must be 1')
  if (typeof value.project_id !== 'string' || !PROJECT_ID_PATTERN.test(value.project_id)) {
    throw new Error('request.project_id is required and must match the slug pattern')
  }
  if (value.task_id !== undefined && (typeof value.task_id !== 'string' || !TASK_ID_PATTERN.test(value.task_id))) {
    throw new Error('request.task_id, when present, must match the slug pattern')
  }
  if (typeof value.role !== 'string' || !['code-explorer', 'code-implementer'].includes(value.role)) {
    throw new Error('request.role must be code-explorer or code-implementer')
  }
  if (typeof value.harness !== 'string' || !['codex', 'deepseek', 'fake'].includes(value.harness)) {
    throw new Error('request.harness must be codex, deepseek, or fake')
  }
  if (typeof value.model !== 'string' || !MODEL_PATTERN.test(value.model)) {
    throw new Error('request.model is required and must be a lowercase slug')
  }
  if (value.reasoning_effort !== undefined) {
    if (typeof value.reasoning_effort !== 'string' || !value.reasoning_effort) {
      throw new Error('request.reasoning_effort must be a non-empty string when provided')
    }
  }
  if (typeof value.objective !== 'string' || !value.objective) {
    throw new Error('request.objective is required and must be a non-empty string')
  }
  if (value.scope !== undefined) validateScope(value.scope, 'request.scope')
  if (!Array.isArray(value.acceptance_criteria) || !value.acceptance_criteria.length) {
    throw new Error('request.acceptance_criteria must be a non-empty array of strings')
  }
  for (let i = 0; i < value.acceptance_criteria.length; i++) {
    if (typeof value.acceptance_criteria[i] !== 'string') {
      throw new Error(`request.acceptance_criteria[${i}] must be a string`)
    }
  }
  const expectedStrategy = value.role === 'code-explorer' ? 'read-only-checkout' : 'git-worktree'
  const expectedFilesystem = value.role === 'code-explorer' ? 'read-only' : 'workspace-write'
  const permissions = validatePermissions(value.permissions, 'request.permissions')
  const workspaceObj = validateWorkspace(value.workspace, 'request.workspace', expectedStrategy)
  if (permissions.filesystem !== expectedFilesystem) {
    throw new Error(`request.permissions.filesystem ${permissions.filesystem} does not match role ${value.role}`)
  }
  if (value.parent !== undefined) validateParent(value.parent, 'request.parent')
  if (value.output_contract !== undefined) validateOutputContract(value.output_contract, 'request.output_contract')
  return value as unknown as TaskRequest
}
