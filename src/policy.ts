import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { assertObject, type Policy, type TaskRequest, type Harness } from './types.js'
import { expandHome, json } from './store.js'

export const defaultPolicyPath = join(os.homedir(), '.config', 'agent-harness', 'policy.yaml')

export async function loadPolicy(path = process.env.AGENT_HARNESS_POLICY ?? defaultPolicyPath): Promise<Policy> {
  if (!isAbsolute(path)) throw new Error('policy path must be absolute and outside the repository')
  const value: unknown = YAML.parse(await readFile(path, 'utf8'))
  assertObject(value, 'policy')
  if (value.schema_version !== 1) throw new Error('policy.schema_version must be 1')
  for (const field of ['defaults', 'providers', 'models', 'roles', 'workflow']) assertObject(value[field], `policy.${field}`)
  if (typeof value.state_root !== 'string') throw new Error('policy.state_root is required')
  const policy = value as unknown as Policy
  policy.state_root = expandHome(policy.state_root)
  if (!isAbsolute(policy.state_root)) throw new Error('policy.state_root must be absolute')
  return policy
}

export function checkPolicy(policy: Policy, request: TaskRequest, harness = request.harness as Harness, model = request.model): void {
  const role = policy.roles[request.role]
  if (!role) throw new Error(`role ${request.role} is not authorized`)
  if (!role.allowed_harnesses.includes(harness)) throw new Error(`harness ${harness} is not allowed for ${request.role}`)
  if (!role.allowed_models.includes(model)) throw new Error(`model ${model} is not allowed for ${request.role}`)
  if (!policy.models[model]) throw new Error(`model ${model} has no route`)
  if (role.filesystem !== request.permissions.filesystem || role.workspace_strategy !== request.workspace.strategy) throw new Error('permissions exceed or differ from role policy')
  if (role.network !== request.permissions.network) throw new Error('network permission differs from role policy')
  for (const tool of request.permissions.tools) if (!role.tools.includes(tool)) throw new Error(`tool ${tool} is not allowed`)
}

export async function checkAdjacentEngine(policy: Policy, stateRoot: string, request: TaskRequest, model: string): Promise<void> {
  if (!policy.workflow.require_adjacent_engine_diversity || !request.parent?.task_id) return
  const previous = await json<{ resolved_engine_id?: string }>(join(stateRoot, 'tasks', request.parent.task_id, 'route-summary.json')).catch(() => null)
  if (previous?.resolved_engine_id && previous.resolved_engine_id === policy.models[model].engine_id) throw new Error('adjacent stages require a different resolved engine')
}
