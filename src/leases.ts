import { join } from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { atomicJson, exists, json, now, withLock } from './store.js'

interface Lease { resource: string; owner: string; host: string; pid: number; acquired_at: string; heartbeat_at: string; expires_at: string }
const key = (resource: string) => createHash('sha256').update(resource).digest('hex')

export async function acquireLease(root: string, resource: string, owner: string, ttlMs = 120000): Promise<void> {
  const path = join(root, 'orchestrator', 'locks', `${key(resource)}.json`)
  await withLock(path, async () => {
    const current = await json<Lease>(path).catch(() => null)
    if (current && Date.parse(current.expires_at) > Date.now() && current.owner !== owner) throw new Error(`resource already leased: ${resource}`)
    const timestamp = now()
    await atomicJson(path, { resource, owner, host: os.hostname(), pid: process.pid, acquired_at: current?.owner === owner ? current.acquired_at : timestamp, heartbeat_at: timestamp, expires_at: new Date(Date.now() + ttlMs).toISOString() } satisfies Lease)
  })
}

export async function releaseLease(root: string, resource: string, owner: string): Promise<void> {
  const path = join(root, 'orchestrator', 'locks', `${key(resource)}.json`)
  if (!await exists(path)) return
  await withLock(path, async () => {
    const current = await json<Lease>(path).catch(() => null)
    if (current?.owner === owner) await import('node:fs/promises').then(fs => fs.rm(path, { force: true }))
  })
}

export async function requireLease(root: string, resource: string, owner: string): Promise<void> {
  const path = join(root, 'orchestrator', 'locks', `${key(resource)}.json`)
  const current = await json<Lease>(path).catch(() => null)
  if (!owner || current?.owner !== owner || Date.parse(current.expires_at) <= Date.now()) throw new Error(`active lease required: ${resource}`)
  await acquireLease(root, resource, owner)
}
