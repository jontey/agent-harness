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

export function validateRequest(value: unknown): TaskRequest {
  assertObject(value, 'request')
  if (value.schema_version !== 1) throw new Error('request.schema_version must be 1')
  for (const field of ['project_id', 'role', 'harness', 'model', 'objective']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`request.${field} is required`)
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.project_id as string)) throw new Error('project_id contains invalid characters')
  if (value.task_id !== undefined && (typeof value.task_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.task_id))) throw new Error('task_id contains invalid characters')
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.model as string)) throw new Error('model alias must be a lowercase slug')
  if (!['code-explorer', 'code-implementer'].includes(value.role as string)) throw new Error('unsupported role')
  if (!['codex', 'deepseek', 'fake'].includes(value.harness as string)) throw new Error('unsupported harness')
  if (!Array.isArray(value.acceptance_criteria) || !value.acceptance_criteria.every(v => typeof v === 'string')) throw new Error('acceptance_criteria must be strings')
  assertObject(value.permissions, 'permissions')
  assertObject(value.workspace, 'workspace')
  if (value.output_contract !== undefined) {
    assertObject(value.output_contract, 'output_contract')
    if (value.output_contract.result !== 'result.md' || value.output_contract.checkpoint !== 'checkpoint.md' || value.output_contract.events !== 'events.jsonl') throw new Error('unsupported output contract paths')
  }
  if (typeof value.workspace.repository !== 'string' || !value.workspace.repository.startsWith('/')) throw new Error('workspace.repository must be absolute')
  if (value.permissions.network !== 'allow') throw new Error('first-release network policy must truthfully declare allow')
  const expected = value.role === 'code-explorer' ? ['read-only', 'read-only-checkout'] : ['workspace-write', 'git-worktree']
  if (value.permissions.filesystem !== expected[0] || value.workspace.strategy !== expected[1]) throw new Error('workspace or filesystem permission does not match role')
  if (!Array.isArray(value.permissions.tools) || !value.permissions.tools.every(v => typeof v === 'string')) throw new Error('permissions.tools must be strings')
  return value as unknown as TaskRequest
}
