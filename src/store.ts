import { mkdir, open, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

export const now = () => new Date().toISOString()
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const expandHome = (path: string) => path.startsWith('~/') ? join(os.homedir(), path.slice(2)) : path

export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T }
export async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  const handle = await open(tmp, 'wx', 0o600)
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  await rename(tmp, path)
  const dir = await open(dirname(path), 'r')
  try { await dir.sync() } finally { await dir.close() }
}
export async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + '\n') }

export async function withLock<T>(path: string, fn: () => Promise<T>, timeoutMs = 10000): Promise<T> {
  const lock = `${path}.lock`
  const started = Date.now()
  for (;;) {
    try { await mkdir(lock); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = Date.now() - (await stat(lock).catch(err => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mtimeMs: Date.now() }
        throw err
      })).mtimeMs
      if (age > 30000) { await rm(lock, { recursive: true, force: true }); continue }
      if (Date.now() - started > timeoutMs) throw new Error(`lock timeout: ${path}`)
      await sleep(25)
    }
  }
  try { return await fn() } finally { await rm(lock, { recursive: true, force: true }) }
}

export async function appendEvent(taskDir: string, type: string, data: Record<string, unknown> = {}): Promise<void> {
  const path = join(taskDir, 'events.jsonl')
  await withLock(path, async () => {
    const existing = await readFile(path, 'utf8').catch(() => '')
    const seq = existing.trim() ? existing.trimEnd().split('\n').length + 1 : 1
    const handle = await open(path, 'a', 0o600)
    try { await handle.writeFile(JSON.stringify({ seq, at: now(), type, ...data }) + '\n'); await handle.sync() } finally { await handle.close() }
  })
}

export async function directories(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(x => x.isDirectory()).map(x => x.name)
}

export async function writeExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { flag: 'wx', mode: 0o600 })
}
