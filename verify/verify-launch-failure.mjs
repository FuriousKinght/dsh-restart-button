// Does the helper survive a failed launch and still write its diagnosis?
//
// The defect this guards against: `launch()` wrapped `spawn` in try/catch, but a
// missing executable does not throw - it fires an asynchronous 'error' event, and
// an 'error' event with no listener becomes an uncaught exception. The helper would
// therefore have CRASHED on the third failed attempt, never writing the
// "LAUNCH FAILED - DSH has to be reopened by hand" line that is the entire point
// of the failure ladder.
//
// This runs the real helper with a config naming an executable that does not
// exist, so the launch path fails for certain and the log is the only witness.
// Nothing is killed: the config names a dead PID, which the helper reports.
//
//   node verify/verify-launch-failure.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(packageRoot, 'lib', 'relaunch-helper.cjs')

const scratch = mkdtempSync(join(tmpdir(), 'dshrb-launchfail-'))
const configPath = join(scratch, 'config.json')
const logPath = join(scratch, 'relaunch.log')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

check('the helper script exists', existsSync(helper), helper)

// A PID that is certainly not running, so the kill step is skipped, and an
// executable that does not exist, so every launch attempt fails.
const MISSING_EXE = join(scratch, 'no-such-app.exe')
writeFileSync(configPath, JSON.stringify({
  appPid: 999999,
  exePath: MISSING_EXE,
  port: 59994,
  workingDir: scratch,
  env: {},
  graceMs: 0,
}, null, 2), 'utf8')

const started = Date.now()
const child = spawn(process.execPath, [helper, configPath], { stdio: 'ignore', windowsHide: true })

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 60000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
  child.on('error', () => {
    clearTimeout(timer)
    resolve('spawn-error')
  })
})

console.log(`helper exited : ${String(exited)} after ${String(Date.now() - started)}ms`)
console.log('')
const log = readLog()
console.log('  --- relaunch.log ---')
for (const line of log.trim().split('\n')) console.log(`  | ${line.replace(/^\S+\s+/, '')}`)
console.log('')

// The decisive pair: it must have run to the end of the ladder, and the log must
// contain the message the ladder exists to produce.
check('the helper exited on its own', exited !== 'timeout', String(exited))
check('it did NOT crash with an uncaught exception', !/helper failed:/.test(log), 'an uncaught error would appear as "helper failed:"')
check('it logged each failed launch attempt', /launch failed: ENOENT/.test(log))
check('it logged all three attempts', (log.match(/launch attempt \d+ failed/g) ?? []).length === 3,
  String((log.match(/launch attempt \d+ failed/g) ?? []).length))
check('it wrote the "reopen by hand" line', /LAUNCH FAILED - DSH has to be reopened by hand/.test(log))
check('it exited with the documented code 4', exited === 4, String(exited))

console.log('')
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`)
if (failures > 0) process.exitCode = 1
