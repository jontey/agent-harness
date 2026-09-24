import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

test('DeepSeek SDK subprocess accepts an isolated custom provider', { timeout: 45000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-dsh-'))
  const server = http.createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'alpha', object: 'model' }] }))
      return
    }
    assert.equal(request.headers.authorization, 'Bearer proxy-token')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
    if (payload.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'alpha', choices: [{ index: 0, delta: { role: 'assistant', content: 'orange' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'alpha', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'alpha', choices: [{ index: 0, message: { role: 'assistant', content: 'orange' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server bind failed')
  const home = join(base, 'home')
  await mkdir(home)
  const patchPath = join(base, 'provider.patch.yml')
  await writeFile(patchPath, YAML.stringify([{ id: 'llm-pi-ai', config: { providers: { litellm: { apiKeyEnv: 'AGENT_HARNESS_PROXY_TOKEN', api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'alpha' }] } } } }]))
  const harness = new DeepSeekHarness({ dshHome: home, patches: [patchPath], processCwd: base, cwd: base, provider: 'litellm', model: 'alpha', env: { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'OFF', AGENT_HARNESS_PROXY_TOKEN: 'proxy-token' } })
  try {
    const result = await harness.run('Say orange. Do not use tools.')
    assert.match(result.finalResponse, /orange/i)
    assert.ok(result.sessionId)
  } finally {
    await harness.close().catch(() => undefined)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  }
})
