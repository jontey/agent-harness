import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { delegate, handoff, initialize, inspect, steer, wait } from '../src/controller.js'
import type { Policy, TaskRequest } from '../src/types.js'

const exec = promisify(execFile)

test('Codex correction then DeepSeek handoff through the controller proxy', { timeout: 90000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-cross-'))
  const repo = join(base, 'repo')
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string }
    assert.equal(request.headers.authorization, 'Bearer mock-key')
    response.setHeader('x-litellm-model-group', payload.model)
    response.setHeader('x-litellm-model-id', `deployment-${payload.model}`)
    response.setHeader('x-litellm-fallback-count', '0')
    response.setHeader('content-type', 'text/event-stream')
    if (request.url?.endsWith('/responses')) {
      const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The word is orange in README.md.' }], status: 'completed' }
      const completed = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: payload.model, output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, error: null, incomplete_details: null }
      const events = [
        { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
        { type: 'response.content_part.added', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_test', content_index: 0, delta: 'The word is orange in README.md.' },
        { type: 'response.output_text.done', output_index: 0, item_id: 'msg_test', content_index: 0, text: 'The word is orange in README.md.' },
        { type: 'response.content_part.done', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: 'The word is orange in README.md.' } },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: completed }
      ]
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } else {
      response.end(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'orange in README.md' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream bind failed')
  try {
    process.env.TEST_GATEWAY_URL = `http://127.0.0.1:${address.port}/v1`
    process.env.TEST_GATEWAY_KEY = 'mock-key'
    await mkdir(repo)
    await exec('git', ['init', repo])
    await writeFile(join(repo, 'README.md'), 'The secret word is orange.\n')
    await exec('git', ['-C', repo, 'add', '.'])
    await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'])
    const stateRoot = join(base, 'state')
    const policyPath = join(base, 'policy.yaml')
    const policy: Policy = { schema_version: 1, state_root: stateRoot, defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 10, require_resolved_route: true, allow_cross_engine_fallback: false }, providers: { litellm: { base_url_env: 'TEST_GATEWAY_URL', api_key_env: 'TEST_GATEWAY_KEY' } }, models: { alpha: { engine_id: 'a', litellm_model_group: 'alpha', permitted_fallback_engines: [] }, beta: { engine_id: 'b', litellm_model_group: 'beta', permitted_fallback_engines: [] } }, roles: { 'code-explorer': { allowed_harnesses: ['codex', 'deepseek'], allowed_models: ['alpha', 'beta'], filesystem: 'read-only', network: 'allow', workspace_strategy: 'read-only-checkout', tools: ['file-read', 'search'] } }, workflow: { require_adjacent_engine_diversity: true } }
    await writeFile(policyPath, YAML.stringify(policy))
    process.env.AGENT_HARNESS_POLICY = policyPath
    const project = await initialize(repo, 'Explore the test repository', policyPath)
    process.env.AGENT_HARNESS_LEAD_ID = project.lead_id
    const request: TaskRequest = { schema_version: 1, project_id: project.project_id, role: 'code-explorer', harness: 'codex', model: 'alpha', objective: 'Report the word in README.md.', acceptance_criteria: ['State the word.'], permissions: { filesystem: 'read-only', network: 'allow', tools: ['file-read', 'search'] }, workspace: { strategy: 'read-only-checkout', repository: repo } }
    const requestFile = join(base, 'request.yaml')
    await writeFile(requestFile, YAML.stringify(request))
    const delegated = await delegate(requestFile)
    await steer(delegated.task_id, 'Confirm the filename.')
    const second = await wait(delegated.task_id, 30000)
    if (second.state !== 'completed') throw new Error(`Codex: ${second.summary}; ${(await readFile(join(stateRoot, 'tasks', delegated.task_id, 'attempts', 'attempt-01', 'error.log'), 'utf8').catch(() => '')).slice(-1000)}`)
    assert.equal((await inspect(delegated.task_id)).session.attempts.length, 2)
    await handoff(delegated.task_id, 'deepseek', 'beta')
    const third = await wait(delegated.task_id, 30000)
    assert.equal(third.state, 'completed', third.summary)
    const bundle = await inspect(delegated.task_id)
    assert.equal(bundle.session.attempts.length, 3)
    assert.equal(bundle.session.attempts[0].resolved_model_group, 'alpha')
    assert.equal(bundle.session.attempts[2].resolved_model_group, 'beta')
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
    delete process.env.TEST_GATEWAY_URL
    delete process.env.TEST_GATEWAY_KEY
  }
})
