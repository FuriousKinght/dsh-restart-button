// Does the restart route still WORK? Asked without restarting anything.
//
// This is the test whose absence let a real defect ship. `verify-relaunch.mjs`
// reproduced the helper's survival mechanics faithfully but built its OWN
// PowerShell command line from the test process - so it kept passing while the
// plugin's route failed, because the plugin called `powershell.exe` by BARE NAME
// and this machine's PATH no longer resolves that (a machine-level entry reads
// `%Syste;Root%\system32` instead of `%SystemRoot%\system32`). Production and the
// test used different mechanisms, so the test could not see production's bug.
//
// This suite therefore talks to the plugin over HTTP and invents no command line
// of its own, and it uses the route's `?dryRun=1` mode: the helper is genuinely
// created through WMI, verifies the target, the tools and the port, and then stops
// before the kill. Nothing is restarted, so it is safe to run at any time.
//
//   node verify/verify-route.mjs

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHostPort } from './find-port.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The Host binds a dynamically assigned port, so it is discovered rather than assumed.
const PORT = await findHostPort()
if (PORT === null) {
  console.error('Could not find the running DSH Host. Start the desktop app first.')
  process.exit(2)
}
const ROUTE = `http://127.0.0.1:${String(PORT)}/plugins/dsh-fk-restart-button`

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

// --- 1. the plugin answers at all -----------------------------------------

let info = null
try {
  const response = await fetch(`${ROUTE}/info`)
  info = await response.json()
} catch (error) {
  console.error(`Could not reach the plugin on port ${String(PORT)}: ${String(error.message)}`)
  console.error('Start the desktop app first; this suite tests the running Host.')
  process.exit(2)
}

console.log(`host         : pid ${String(info.pid)}`)
console.log(`app          : ${String(info.appName)} (pid ${String(info.appPid)})`)
console.log(`node runtime : ${String(info.nodePath)}`)
console.log(`helper dir   : ${String(info.helperDir)}`)
console.log('')

check('the plugin reports itself available', info.available === true, String(info.reason ?? ''))
check(
  'it found a node runtime for the helper',
  typeof info.nodePath === 'string' && info.nodePath !== '',
  String(info.nodePath),
)
check('it is running inside the desktop app', typeof info.appPid === 'number' && info.appPid > 0, String(info.appPid))
check(
  'the node runtime it chose actually exists',
  typeof info.nodePath === 'string' && existsSyncSafe(info.nodePath),
  String(info.nodePath),
)

function existsSyncSafe(file) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

// --- 2. press the route in dry-run mode -----------------------------------

const logPath = join(info.helperDir, 'relaunch.log')
let before = ''
try {
  before = readFileSync(logPath, 'utf8')
} catch {
  before = ''
}

let restart = null
try {
  const response = await fetch(`${ROUTE}/restart?dryRun=1`, { method: 'POST' })
  restart = { status: response.status, body: await response.json() }
} catch (error) {
  restart = { status: 0, body: { error: String(error.message) } }
}

console.log(`POST /restart?dryRun=1 -> HTTP ${String(restart.status)}`)
console.log(`  ${JSON.stringify(restart.body)}`)
console.log('')

// THE ASSERTION THAT WAS MISSING. The old failure surfaced here as an HTTP 500
// whose body said only "powershell 启动失败", which is how a PATH problem stayed
// invisible for a day: the error covered ENOENT, EPERM and everything else, and
// named no path. Anything other than a created helper now has to say why.
check('the route created the helper', restart.status === 200, String(restart.body?.error ?? ''))
check(
  'it reported a helper process id',
  typeof restart.body?.helperPid === 'number' && restart.body.helperPid > 0,
  String(restart.body?.helperPid ?? restart.body?.error ?? '(none)'),
)
check('it says the run was a dry run', restart.body?.dryRun === true, String(restart.body?.dryRun))
check(
  'the response names the log it writes',
  typeof restart.body?.logPath === 'string' && restart.body.logPath !== '',
  String(restart.body?.logPath),
)

// --- 3. the helper must have run, verified, and stopped -------------------

await sleep(3000)

let after = ''
try {
  after = readFileSync(logPath, 'utf8')
} catch {
  after = ''
}
const fresh = after.startsWith(before) ? after.slice(before.length) : after
const lines = fresh.trim().split('\n').filter((line) => line !== '')

console.log('  --- what the dry run reported ---')
for (const line of lines) console.log(`  | ${line.replace(/^\S+\s+/, '')}`)
console.log('')

check('the helper wrote to the log', lines.length > 0, `${String(lines.length)} line(s)`)
check('it verified the target process by image name', /dry run: target alive=/.test(fresh))
check(
  'it resolved the system tools it needs by absolute path',
  /dry run: tasklist=".*tasklist\.exe" taskkill=".*taskkill\.exe"/.test(fresh),
)
check('it checked the port', /dry run: port \d+ busy=/.test(fresh))
check('it finished', /done$/.test(fresh.trimEnd()))
// The decisive one: the helper must have found the app and its tools, not merely
// started. A dry run that cannot verify the target is a restart that would fail.
check(
  'the target was VERIFIED (a real run would go through)',
  /dry run: target verified/.test(fresh),
  /target NOT verified/.test(fresh) ? 'the helper would refuse a real run' : '',
)

// --- 3b. a dry run must not latch the in-flight guard ----------------------
//
// A dry run leaves the process alive on purpose, so the `restarting` flag that
// guards against a second helper can never be cleared by one. Taking it anyway
// latches the flag for the remaining life of the app: the button then answers
// "已经有一次重启在进行了" forever. That was a real defect, introduced with the dry
// run itself and caught by running this suite twice - so run it twice.
const repeat = await fetch(`${ROUTE}/restart?dryRun=1`, { method: 'POST' })
const repeatBody = await repeat.json()
console.log('')
console.log(`POST /restart?dryRun=1 (second time) -> HTTP ${String(repeat.status)}`)
console.log(`  ${JSON.stringify(repeatBody)}`)
console.log('')
check('a second dry run still works', repeat.status === 200, String(repeatBody?.error ?? ''))
check(
  'the first dry run did not latch the in-flight guard',
  repeat.status !== 409,
  repeat.status === 409 ? 'the guard was left set - the button would be dead' : '',
)

// --- 4. nothing may have been disturbed -----------------------------------

let stillHere = null
try {
  const response = await fetch(`${ROUTE}/info`)
  stillHere = await response.json()
} catch {
  stillHere = null
}
check('DSH is still running, untouched', stillHere !== null && stillHere.pid === info.pid, String(stillHere?.pid))

console.log('')
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`)
if (failures > 0) process.exitCode = 1
