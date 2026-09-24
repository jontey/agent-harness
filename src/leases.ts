import { join } from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicJson, exists, json, now, withLock } from './store.js'

interface Lease { resource: string; owner: string; host: string; pid: number; acquired_at: string; heartbeat_at: string; expires_at: string }
const key = (resource: string) => createHash('sha256').update(resource).digest('hex')
const exec = promisify(execFile)

async function liveWriterOwner(root: string, lease: Lease): Promise<boolean> {
  if (!lease.resource.startsWith('writer:') || lease.host !== os.hostname() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(lease.owner)) return false
  const session = await json<{ attempts?: Array<{ supervisor_pid?: number; supervisor_started_at?: string }> }>(join(root, 'tasks', lease.owner, 'session.json')).catch(() => null)
  const attempt = session?.attempts?.at(-1)
  if (!attempt?.supervisor_pid) return false
  const pid = String(attempt.supervisor_pid)
  const birth = await exec('ps', ['-p', pid, '-o', 'lstart=']).then(x => x.stdout.trim()).catch(() => '')
  if (!birth || (attempt.supervisor_started_at && birth !== attempt.supervisor_started_at)) return false
  const state = await exec('ps', ['-p', pid, '-o', 'stat=']).then(x => x.stdout.trim()).catch(() => '')
  return Boolean(state) && !state.startsWith('Z')
}

export async function acquireLease(root: string, resource: string, owner: string, ttlMs = 120000): Promise<void> {
  const path = join(root, 'orchestrator', 'locks', `${key(resource)}.json`)
  await withLock(path, async () => {
    const current = await json<Lease>(path).catch(() => null)
    if (current && Date.parse(current.expires_at) > Date.now() && current.owner !== owner) throw new Error(`resource already leased: ${resource}`)
    if (current && current.owner !== owner && await liveWriterOwner(root, current)) throw new Error(`resource still held by a live writer: ${resource}`)
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
