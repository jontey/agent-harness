import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

test('Codex CLI starts with an isolated custom provider', { timeout: 30000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-harness-codex-'))
  await exec('git', ['init', base])
  const server = http.createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'alpha', object: 'model' }] }))
      return
    }
    assert.equal(request.headers.authorization, 'Bearer proxy-token')
    for await (const _ of request) { /* consume */ }
    const id = 'resp_test'
    const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'orange' }], status: 'completed' }
    const completed = { id, object: 'response', created_at: 1, status: 'completed', model: 'alpha', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, error: null, incomplete_details: null }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
      { type: 'response.content_part.added', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_test', content_index: 0, delta: 'orange' },
      { type: 'response.output_text.done', output_index: 0, item_id: 'msg_test', content_index: 0, text: 'orange' },
      { type: 'response.content_part.done', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: 'orange' } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: completed }
    ]
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server bind failed')
  const home = join(base, 'codex')
  await mkdir(home)
  await writeFile(join(home, 'config.toml'), `model = "alpha"\nmodel_provider = "litellm"\napproval_policy = "never"\n[model_providers.litellm]\nname = "LiteLLM"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nenv_key = "AGENT_HARNESS_PROXY_TOKEN"\nwire_api = "responses"\n`)
  const output = join(base, 'final.txt')
  try {
    const child = spawn('codex', ['exec', '--json', '-m', 'alpha', '-C', base, '-s', 'read-only', '-o', output, 'Say orange'], { env: { ...process.env, CODEX_HOME: home, AGENT_HARNESS_PROXY_TOKEN: 'proxy-token' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    for await (const chunk of child.stdout) stdout += String(chunk)
    const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)))
    assert.equal(code, 0, stderr.slice(-1000))
    assert.match(await readFile(output, 'utf8'), /orange/i, stdout.slice(-2500))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  }
})
