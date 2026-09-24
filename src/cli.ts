#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { cancel, delegate, handoff, initialize, inspect, list, releaseLead, resume, steer, wait } from './controller.js'
import type { Harness } from './types.js'

const [command, ...argv] = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
function required(name: string): string {
  const value = option(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}
async function main(): Promise<unknown> {
  if (option('policy')) process.env.AGENT_HARNESS_POLICY = required('policy')
  if (option('lead-id')) process.env.AGENT_HARNESS_LEAD_ID = required('lead-id')
  switch (command) {
    case 'init': return initialize(required('repo'), option('objective-file') ? await readFile(required('objective-file'), 'utf8') : required('objective'), process.env.AGENT_HARNESS_POLICY)
    case 'delegate': return delegate(required('request'), option('context'))
    case 'list': return list(option('project'))
    case 'inspect': return inspect(required('task'))
    case 'wait': return wait(required('task'), Number(option('timeout-ms') ?? 0))
    case 'steer': return steer(required('task'), option('message-file') ? await readFile(required('message-file'), 'utf8') : required('message'))
    case 'cancel': return cancel(required('task'))
    case 'resume': return resume(required('task'))
    case 'handoff': return handoff(required('task'), required('harness') as Harness, required('model'))
    case 'lead-release': return releaseLead(required('project'))
    default: throw new Error('usage: agent-harness <init|delegate|list|inspect|wait|steer|cancel|resume|handoff|lead-release> [options]')
  }
}

try { process.stdout.write(JSON.stringify(await main()) + '\n') }
catch (error) { process.stderr.write(JSON.stringify({ error: String(error) }) + '\n'); process.exitCode = 1 }
