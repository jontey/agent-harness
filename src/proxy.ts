import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { appendFile } from 'node:fs/promises'
import type { Policy } from './types.js'

export interface RouteEvidence { resolved_group: string; deployment_id: string; fallback_count: number; engine_id: string; call_id?: string; cost_usd?: number; input_tokens?: number; output_tokens?: number }
export interface ProxyHandle { baseUrl: string; token: string; routes: RouteEvidence[]; close: () => Promise<void> }

const header = (response: Response, ...names: string[]): string | null => names.map(name => response.headers.get(name)).find(Boolean) ?? null

export async function startProxy(options: { policy: Policy; alias: string; taskId: string; attemptId: string; logPath: string; onRoute: (route: RouteEvidence) => Promise<void> }): Promise<ProxyHandle> {
  const { policy, alias } = options
  const upstreamBase = process.env[policy.providers.litellm.base_url_env]
  const upstreamKey = process.env[policy.providers.litellm.api_key_env]
  if (!upstreamBase || !upstreamKey) throw new Error('LiteLLM base URL and API key are required')
  const target = new URL(upstreamBase)
  const token = randomBytes(32).toString('hex')
  const routes: RouteEvidence[] = []
  const server = http.createServer((request, response) => { void handle(request, response).catch(error => {
    if (!response.headersSent) { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: String(error) })) }
    else response.destroy(error as Error)
  }) })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return }
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: alias, object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !request.url || !/(chat\/completions|responses)$/.test(request.url.split('?')[0])) { response.writeHead(404); response.end(); return }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 10 * 1024 * 1024) { response.writeHead(413); response.end(); return }
      chunks.push(bytes)
    }
    const raw = Buffer.concat(chunks)
    const payload = JSON.parse(raw.toString('utf8')) as { model?: string }
    if (payload.model !== alias) { response.writeHead(403); response.end(JSON.stringify({ error: 'model denied' })); return }
    const upstreamPayload = { ...payload, model: policy.models[alias].litellm_model_group }
    const incoming = new URL(request.url, 'http://localhost')
    const suffix = incoming.pathname.replace(/^\/v1/, '')
    const path = target.pathname.replace(/\/$/, '') + suffix + incoming.search
    const upstream = new URL(path, target.origin)
    const upstreamResponse = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${upstreamKey}`, 'x-agent-harness-task-id': options.taskId, 'x-agent-harness-attempt-id': options.attemptId },
      body: JSON.stringify(upstreamPayload)
    })
    if (!upstreamResponse.ok) {
      response.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json' })
      response.end(await upstreamResponse.text())
      return
    }
    const group = header(upstreamResponse, 'x-litellm-model-group', 'x-litellm-model-group-name')
    const deployment = header(upstreamResponse, 'x-litellm-model-id', 'x-litellm-deployment-id')
    const fallbackHeader = header(upstreamResponse, 'x-litellm-attempted-fallbacks', 'x-litellm-fallback-count')
    const fallback = Number(fallbackHeader)
    const route = Object.values(policy.models).find(x => x.litellm_model_group === group)
    if (!group || !deployment || fallbackHeader === null || !route || !Number.isInteger(fallback) || fallback < 0 || (route.engine_id !== policy.models[alias].engine_id && !policy.defaults.allow_cross_engine_fallback)) {
      await appendFile(`${options.logPath}.rejected`, JSON.stringify({ at: new Date().toISOString(), group, deployment, fallback_header: fallbackHeader, expected_group: policy.models[alias].litellm_model_group }) + '\n', { mode: 0o600 })
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'resolved model route unavailable or disallowed' }))
      return
    }
    const evidence: RouteEvidence = { resolved_group: group, deployment_id: deployment, fallback_count: fallback, engine_id: route.engine_id }
    const callId = header(upstreamResponse, 'x-litellm-call-id')
    const cost = header(upstreamResponse, 'x-litellm-response-cost')
    if (callId) evidence.call_id = callId
    if (cost && Number.isFinite(Number(cost))) evidence.cost_usd = Number(cost)
    const record = async () => {
      routes.push(evidence)
      await appendFile(options.logPath, JSON.stringify({ at: new Date().toISOString(), ...evidence }) + '\n', { mode: 0o600 })
      await options.onRoute(evidence)
    }
    const headers: Record<string, string> = { 'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json' }
    if (headers['content-type'].includes('application/json')) {
      const body = await upstreamResponse.text()
      try {
        const parsed = JSON.parse(body) as { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } }
        evidence.input_tokens = parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens
        evidence.output_tokens = parsed.usage?.output_tokens ?? parsed.usage?.completion_tokens
      } catch { /* preserve upstream body */ }
      await record()
      response.writeHead(upstreamResponse.status, headers)
      response.end(body)
      return
    }
    response.writeHead(upstreamResponse.status, headers)
    if (upstreamResponse.body) {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of upstreamResponse.body) {
        const bytes = Buffer.from(chunk)
        pending += decoder.decode(bytes, { stream: true })
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline < 0) break
          const line = pending.slice(0, newline).trimEnd()
          pending = pending.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          try {
            const event = JSON.parse(line.slice(5).trim()) as { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }; response?: { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } } }
            const usage = event.response?.usage ?? event.usage
            evidence.input_tokens = usage?.input_tokens ?? usage?.prompt_tokens ?? evidence.input_tokens
            evidence.output_tokens = usage?.output_tokens ?? usage?.completion_tokens ?? evidence.output_tokens
          } catch { /* other SSE frames are forwarded unchanged */ }
        }
        if (pending.length > 1024 * 1024) pending = ''
        if (!response.write(bytes)) await once(response, 'drain')
      }
    }
    await record()
    response.end()
  }
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).once('error', reject))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('proxy bind failed')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, token, routes, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
