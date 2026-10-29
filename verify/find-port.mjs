// Find the port the running DSH Host is serving on.
//
// The host stopped taking `--port` and now binds a dynamically assigned port
// (measured: 59292 on this machine, not the old 19387). Every suite that talks to
// the live plugin needs the real port, and hardcoding one made those suites report
// "unreachable" - which reads as a broken plugin rather than a stale assumption.
//
// Order of preference:
//   1. DSH_PORT, when set - an operator overriding it is the strongest signal
//   2. the port observed in `DSH_WEB_URL`, which the Host sets for its children
//   3. a scan of the listening ports owned by the DSH processes
//
// The scan is last because it is the slowest and the most indirect, but it is the
// only one that works when invoked from an environment with no DSH variables.
//
// This file is import-only and has no side effects.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32')

/** Ports this machine is listening on, with the owning process id. */
function listeningPorts() {
  const netstat = join(SYSTEM32, 'netstat.exe')
  let output = ''
  try {
    output = execFileSync(netstat, ['-ano'], { encoding: 'utf8', windowsHide: true })
  } catch {
    return []
  }

  const rows = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    const local = fields[1]
    const ownerPid = Number.parseInt(fields[fields.length - 1], 10)
    const match = /:(\d+)$/.exec(local)
    if (match === null || !Number.isInteger(ownerPid)) continue
    rows.push({ port: Number.parseInt(match[1], 10), pid: ownerPid })
  }
  return rows
}

/** Process ids of the running DSH desktop application and its host. */
function dshPids() {
  const tasklist = join(SYSTEM32, 'tasklist.exe')
  let output = ''
  try {
    output = execFileSync(tasklist, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch {
    return []
  }
  const pids = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (match !== null) pids.push(Number.parseInt(match[2], 10))
  }
  return pids
}

/**
 * Whether the plugin answers on a port.
 * @param port - candidate port.
 * @returns true when `/plugins/dsh-fk-restart-button/info` responds.
 */
async function servesPlugin(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/plugins/dsh-fk-restart-button/info`, {
      signal: AbortSignal.timeout(2500),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The port the running Host serves the plugin on.
 * @returns the port, or null when none could be found.
 */
export async function findHostPort() {
  const fromEnv = Number(process.env.DSH_PORT ?? '')
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv

  const webUrl = process.env.DSH_WEB_URL
  if (typeof webUrl === 'string' && webUrl !== '') {
    const match = /:(\d+)/.exec(webUrl)
    if (match !== null) {
      const port = Number.parseInt(match[1], 10)
      if (await servesPlugin(port)) return port
    }
  }

  // Candidate ports: everything the DSH processes are listening on.
  const pids = new Set(dshPids())
  const candidates = [...new Set(
    listeningPorts()
      .filter((row) => pids.has(row.pid))
      .map((row) => row.port),
  )]

  for (const port of candidates) {
    if (await servesPlugin(port)) return port
  }
  return null
}
