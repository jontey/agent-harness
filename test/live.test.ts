import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { cancel, delegate, handoff, initialize, inspect, steer, wait } from '../src/controller.js'
import type { Policy, TaskRequest } from '../src/types.js'

const live = process.env.AGENT_HARNESS_LIVE === '1' && Boolean(process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY && process.env.AGENT_HARNESS_TEST_CODEX_MODEL && process.env.AGENT_HARNESS_TEST_DSH_MODEL)
const exec = promisify(execFile)

test('live Codex correction and DeepSeek handoff through LiteLLM', { skip: !live, timeout: 600000 }, async () => {
  const codexGroup = process.env.AGENT_HARNESS_TEST_CODEX_MODEL!
  const dshGroup = process.env.AGENT_HARNESS_TEST_DSH_MODEL!
  const codexModel = 'live-codex'
  const dshModel = 'live-deepseek'
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-live-'))
  const repo = join(base, 'repo')
  let activeTask: string | undefined
  try {
    await mkdir(repo)
    await exec('git', ['init', repo])
    await writeFile(join(repo, 'README.md'), '# Tiny project\n\nThe secret word is orange.\n')
    await exec('git', ['-C', repo, 'add', '.'])
    await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
    const stateRoot = join(base, 'state')
    const policyPath = join(base, 'policy.yaml')
    const policy: Policy = { schema_version: 1, state_root: stateRoot, defaults: { heartbeat_interval_seconds: 2, stale_after_seconds: 30, require_resolved_route: true, allow_cross_engine_fallback: false }, providers: { litellm: { base_url_env: 'LITELLM_BASE_URL', api_key_env: 'LITELLM_API_KEY' } }, models: { [codexModel]: { engine_id: codexModel, litellm_model_group: codexGroup, permitted_fallback_engines: [] }, [dshModel]: { engine_id: dshModel, litellm_model_group: dshGroup, permitted_fallback_engines: [] } }, roles: { 'code-explorer': { allowed_harnesses: ['codex', 'deepseek'], allowed_models: [codexModel, dshModel], filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read', 'search'] } }, workflow: { require_adjacent_engine_diversity: true } }
    await writeFile(policyPath, YAML.stringify(policy))
    process.env.AGENT_HARNESS_POLICY = policyPath
    const project = await initialize(repo, 'Explore the tiny project', policyPath)
    process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
    const request: TaskRequest = { schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'codex', model: codexModel, objective: 'Read README.md and report the secret word.', acceptance_criteria: ['Cite README.md and state the word.'], permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search'] }, workspace: { strategy: 'read-only-checkout', repository: repo } }
    const requestFile = join(base, 'request.yaml')
    await writeFile(requestFile, YAML.stringify(request))
    const delegated = await delegate(requestFile)
    activeTask = delegated.task_id
    const first = await wait(activeTask, 180000)
    assert.equal(first.state, 'completed', first.summary)
    await steer(activeTask, 'Confirm the answer and mention the filename.')
    const second = await wait(activeTask, 180000)
    assert.equal(second.state, 'completed', second.summary)
    assert.notEqual(first.attempt_id, second.attempt_id)
    await handoff(activeTask, 'deepseek', dshModel)
    const third = await wait(activeTask, 180000)
    assert.equal(third.state, 'completed', third.summary)
    const bundle = await inspect(activeTask)
    assert.equal(bundle.session.attempts.length, 3)
    assert.ok((await readFile(join(stateRoot, 'tasks', activeTask, 'result.md'), 'utf8')).toLowerCase().includes('orange'))
  } finally {
    if (activeTask) await cancel(activeTask).catch(() => undefined)
    await rm(base, { recursive: true, force: true })
  }
})
