import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProxy } from '../src/proxy.js'
import type { Policy } from '../src/types.js'

test('proxy restricts model and requires resolved route evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-proxy-'))
  let withEvidence = true
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer shared-secret')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert.equal((JSON.parse(Buffer.concat(chunks).toString()) as { model: string }).model, 'Gateway Alpha')
    res.writeHead(200, withEvidence ? { 'content-type': 'application/json', 'x-litellm-model-group': 'Gateway Alpha', 'x-litellm-model-id': 'deployment-1', 'x-litellm-attempted-fallbacks': '0' } : { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: [] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream failed')
  process.env.TEST_LITELLM_URL = `http://127.0.0.1:${address.port}/v1`
  process.env.TEST_LITELLM_KEY = 'shared-secret'
  const policy: Policy = { schema_version: 1, state_root: base, defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 5, require_resolved_route: true, allow_cross_engine_fallback: false }, providers: { litellm: { base_url_env: 'TEST_LITELLM_URL', api_key_env: 'TEST_LITELLM_KEY' } }, models: { alpha: { engine_id: 'a', litellm_model_group: 'Gateway Alpha', permitted_fallback_engines: [] } }, roles: {}, workflow: { require_adjacent_engine_diversity: false } }
  const proxy = await startProxy({ policy, alias: 'alpha', taskId: 'task', attemptId: 'attempt-01', logPath: join(base, 'routes.jsonl'), onRoute: async () => {} })
  try {
    const call = (model: string) => fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model }) })
    assert.equal((await call('other')).status, 403)
    assert.equal((await call('alpha')).status, 200)
    assert.equal(proxy.routes.length, 1)
    withEvidence = false
    assert.equal((await call('alpha')).status, 502)
    assert.equal(proxy.routes.length, 1)
  } finally {
    await proxy.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
    delete process.env.TEST_LITELLM_URL
    delete process.env.TEST_LITELLM_KEY
  }
})

test('proxy records token usage from a streamed completion', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-proxy-stream-'))
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume body */ }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-litellm-model-group': 'Gateway Alpha', 'x-litellm-model-id': 'deployment-1', 'x-litellm-attempted-fallbacks': '0' })
    response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
    response.end('data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream failed')
  process.env.TEST_LITELLM_URL = `http://127.0.0.1:${address.port}/v1`
  process.env.TEST_LITELLM_KEY = 'shared-secret'
  const policy: Policy = { schema_version: 1, state_root: base, defaults: { heartbeat_interval_seconds: 1, stale_after_seconds: 5, require_resolved_route: true, allow_cross_engine_fallback: false }, providers: { litellm: { base_url_env: 'TEST_LITELLM_URL', api_key_env: 'TEST_LITELLM_KEY' } }, models: { alpha: { engine_id: 'a', litellm_model_group: 'Gateway Alpha', permitted_fallback_engines: [] } }, roles: {}, workflow: { require_adjacent_engine_diversity: false } }
  const proxy = await startProxy({ policy, alias: 'alpha', taskId: 'task', attemptId: 'attempt-01', logPath: join(base, 'routes.jsonl'), onRoute: async () => {} })
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'alpha' }) })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(proxy.routes[0].input_tokens, 12)
    assert.equal(proxy.routes[0].output_tokens, 7)
  } finally {
    await proxy.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
    delete process.env.TEST_LITELLM_URL
    delete process.env.TEST_LITELLM_KEY
  }
})
