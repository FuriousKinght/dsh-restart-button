// Exercise the relaunch helper for real, without touching the running DSH.
//
// The helper's whole reason for existing is that it must OUTLIVE the process tree
// it kills. That is the one property a unit test cannot assert and a live test
// cannot safely assert either - a failed live test leaves the user without a DSH.
// So the production shape is reproduced against a throwaway stand-in:
//
//   stand-in "app"  (its own node process)
//     +-- creates the helper through WMI, then sleeps
//   helper          (parented to WmiPrvSE, NOT to the stand-in)
//     +-- taskkill /T /F on the stand-in's PID
//     +-- relaunches the executable
//
// The stand-in is the helper's CREATOR and also its VICTIM, exactly as the DSH
// Host is both relative to the Electron process. If the helper were an ordinary
// child of the tree it kills, its own taskkill would take it down halfway and the
// log would stop before "launched". Nothing artificial is added to force that:
// the nested kill is the real one.
//
//   node verify/verify-relaunch.mjs

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const helperScript = join(packageDir, 'lib', 'relaunch-helper.cjs')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-verify-'))
const configPath = join(scratch, 'config.json')
const logPath = join(scratch, 'relaunch.log')
const handshakePath = join(scratch, 'handshake.json')
const standInPath = join(scratch, 'stand-in.cjs')

// A port nothing is listening on, so the helper's "wait for the port" step
// finishes immediately. 59993 is in the dynamic range and unused here.
const PORT = 59993

// The runtime both the stand-in and the relaunch use. Run through the bundled
// node, `process.execPath` IS node.exe, which makes the helper's image-name guard
// meaningful: it compares the victim's image ("node.exe") against the executable
// it was told to relaunch (also node.exe). Launching node.exe with no arguments
// prints usage and exits, so the relaunch is harmless.
const NODE = process.execPath

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

const alive = (pid) => {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${String(pid)}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return String(result.stdout ?? '').includes(`"${String(pid)}"`)
}

const processNameOf = (pid) => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue).ProcessName`,
  ], { encoding: 'utf8', windowsHide: true })
  return String(result.stdout ?? '').trim()
}

const parentOf = (pid) => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").ParentProcessId`,
  ], { encoding: 'utf8', windowsHide: true })
  return Number.parseInt(String(result.stdout ?? '').trim(), 10)
}

console.log(`scratch : ${scratch}`)
console.log(`node    : ${NODE}`)
console.log('')

check('the helper script exists', existsSync(helperScript), helperScript)
if (failures > 0) process.exit(1)

// --- the stand-in application ---------------------------------------------
// It creates the helper through WMI exactly as the plugin does, records what it
// did for the observer, and then simply waits to be killed.
writeFileSync(standInPath, `
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const [, , configPath, logPath, handshakePath, port] = process.argv

fs.writeFileSync(configPath, JSON.stringify({
  appPid: process.pid,
  exePath: process.execPath,
  port: Number(port),
  workingDir: null,
  env: {},
  requestedAt: new Date().toISOString(),
}, null, 2), 'utf8')

const commandLine = '"' + process.execPath + '" "' + ${JSON.stringify(helperScript)} + '" "' + configPath + '"'
const script = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
  + "-Arguments @{ CommandLine = '" + commandLine.replace(/'/g, "''") + "' } | "
  + 'Select-Object -ExpandProperty ProcessId'
const created = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
], { encoding: 'utf8', windowsHide: true })

fs.writeFileSync(handshakePath, JSON.stringify({
  appPid: process.pid,
  helperPid: Number.parseInt(String(created.stdout || '').trim(), 10) || null,
  logPath,
}), 'utf8')

setInterval(() => {}, 1000)
`, 'utf8')

const standIn = spawn(NODE, [standInPath, configPath, logPath, handshakePath, String(PORT)], {
  stdio: 'ignore',
  windowsHide: true,
})

let handshake = null
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (existsSync(handshakePath)) {
    try {
      handshake = JSON.parse(readFileSync(handshakePath, 'utf8'))
      break
    } catch {
      /* written in two steps; retry */
    }
  }
  await sleep(250)
}

check('the stand-in created the helper', handshake !== null && handshake.helperPid !== null,
  handshake === null ? 'no handshake' : `helper pid ${String(handshake.helperPid)}`)
check('the stand-in is running', handshake !== null && alive(handshake.appPid),
  handshake === null ? '-' : `pid ${String(handshake.appPid)}`)

// The property everything rests on.
if (handshake !== null && handshake.helperPid !== null) {
  const parent = parentOf(handshake.helperPid)
  check(
    'helper is parented outside the tree it will kill',
    processNameOf(parent) === 'WmiPrvSE',
    `parent ${processNameOf(parent)} (${String(parent)})`,
  )
}

// --- the helper must kill the stand-in and still finish --------------------
let finished = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (readLog().includes('done') || readLog().includes('LAUNCH FAILED')) { finished = true; break }
  await sleep(500)
}

const log = readLog()
console.log('')
console.log('--- relaunch.log ---')
console.log(log.trim() || '(empty)')
console.log('-------------------')
console.log('')

check('helper ran to completion', log.includes('done'))
check('it killed the stand-in application', handshake !== null && !alive(handshake.appPid))
check('it logged the kill', /taskkill exit=0/i.test(log))
check('it relaunched the executable', /launched pid \d+/i.test(log))

if (handshake !== null && alive(handshake.appPid)) {
  spawnSync('taskkill.exe', ['/PID', String(handshake.appPid), '/T', '/F'], { windowsHide: true })
}
try { standIn.kill() } catch { /* already gone */ }

console.log('')
if (failures === 0) {
  console.log('all checks passed')
} else {
  console.log(`${String(failures)} check(s) failed`)
  process.exitCode = 1
}
