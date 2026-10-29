// Does pressing restart open a console window? And is a killed helper reported?
//
// This reproduces the reported defect end to end. The user said: pressing restart
// opened a CMD-like window, and closing that window meant the restart never
// happened while the page spun until it timed out. The cause was `Win32_Process`
// being asked to create the helper with no `ProcessStartupInformation`, which lets
// WMI allocate a console - and a console is a visible terminal window, which is
// also the process's own console, so closing it kills the helper.
//
// The window class to look for is NOT the classic `ConsoleWindowClass`. On this
// machine Windows Terminal is the registered default terminal, so the window is
// `CASCADIA_HOSTING_WINDOW_CLASS`. An earlier probe searched only for the classic
// class and reported "no window" while one was plainly on screen.
//
// Runs against the live Host through the route's dry-run mode, so nothing restarts.
//
//   node verify/verify-no-console-window.mjs

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
const helperDir = process.env.DSH_HOME === undefined
  ? join(process.env.TEMP ?? '.', 'dsh-restart-helper')
  : join(process.env.DSH_HOME, 'restart-helper')
const LOG = join(helperDir, 'relaunch.log')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

// --- enumerate visible terminal windows from Node, without extra tooling ----
//
// `tasklist` can list processes but not window classes, and spawning it by bare
// name fails on this machine. PowerShell is resolved absolutely and asked for the
// window list in one shot.

const POWERSHELL = (() => {
  const root = process.env.SystemRoot ?? 'C:\\WINDOWS'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
})()

/** Visible windows of the classes a console/terminal shows up as. */
async function terminalWindows() {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;',
    'public static class TW {',
    '  public delegate bool E(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);',
    '  public static List<string> L() { var f = new List<string>();',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) { if (!IsWindowVisible(h)) return true;',
    '      uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(256); GetClassName(h, c, 256);',
    '      var n = c.ToString();',
    '      if (n == "CASCADIA_HOSTING_WINDOW_CLASS" || n == "ConsoleWindowClass" || n == "PseudoConsoleWindow")',
    '        f.Add(p.ToString() + "|" + n);',
    '      return true; }, IntPtr.Zero); return f; }',
    '}',
    '"@',
    '[TW]::L()',
  ].join('\n')

  // The script is passed with -Command and read from stdin-free argv, so quoting
  // is kept simple: a here-string inside single quotes would be fragile here.
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  })
  const text = String(result.stdout ?? '')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
}

let info = null
try {
  const response = await fetch(`${ROUTE}/info`)
  info = await response.json()
} catch (error) {
  console.error(`Could not reach the plugin on port ${String(PORT)}: ${String(error.message)}`)
  process.exit(2)
}

console.log(`host      : pid ${String(info.pid)}`)
console.log(`powerShell: ${POWERSHELL}`)
console.log('')

check('the plugin is available', info.available === true, String(info.reason ?? ''))

// --- the actual reproduction ----------------------------------------------
//
// A dry run creates the helper through the very same WMI call, so whatever window
// that call would open for a real restart opens here too.

const before = await terminalWindows()
console.log(`terminal windows before : ${String(before.length)}`)

let response = null
try {
  const http = await fetch(`${ROUTE}/restart?dryRun=1`, { method: 'POST' })
  response = await http.json()
} catch (error) {
  response = { ok: false, error: String(error.message) }
}

check('the helper was created', response?.ok === true, String(response?.error ?? ''))

// The window appears with the process, so a short settle is enough; waiting longer
// only risks a slow dry run exiting before the check runs.
await sleep(1200)

const after = await terminalWindows()
const appeared = after.filter((entry) => !before.includes(entry))
console.log(`terminal windows after  : ${String(after.length)}  (new: ${String(appeared.length)})`)
for (const entry of appeared) console.log(`    ${entry}`)
console.log('')

check(
  'creating the helper opened NO terminal window',
  appeared.length === 0,
  appeared.length === 0 ? '' : appeared.join(', '),
)

// --- and the failure must be reportable ------------------------------------

check(
  'the route reports no pending failure',
  info.restartFailed === null || info.restartFailed === undefined,
  String(info.restartFailed ?? 'null'),
)

// The page relies on this field to stop early; if it stops being served, the
// 90-second spin comes back.
let after_info = null
try {
  const http = await fetch(`${ROUTE}/info`)
  after_info = await http.json()
} catch {
  after_info = null
}
check(
  '/info carries the restartFailed field the page reads to stop waiting',
  after_info !== null && Object.prototype.hasOwnProperty.call(after_info, 'restartFailed'),
  after_info === null ? 'no response' : Object.keys(after_info).join(', '),
)

// --- the log must record what the helper did ------------------------------

let log = ''
try {
  log = readFileSync(LOG, 'utf8')
} catch {
  log = ''
}
check('the helper wrote its dry-run report', /dry run:/.test(log))

console.log('')
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`)
if (failures > 0) process.exitCode = 1
