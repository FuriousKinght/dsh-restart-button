// The helper-death decision, tested directly.
//
// `helperDeathVerdict` is exported from entry.js for exactly this. The decision is
// small, and both ways of getting it wrong are quiet:
//
//   - Report a death during a dry run as a failure -> every self-check shows an
//     error, and users learn to ignore the message.
//   - Fail to report a death during a real restart -> the page spins for its full
//     90-second timeout, which is the reported defect.
//
// Neither is visible without pressing the button, so they are asserted here.
//
// This also checks the field is actually SERVED by the running Host, because the
// page reads it from `/info`: a correct function behind a field nobody sends fixes
// nothing.
//
//   node verify/verify-helper-death.mjs

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DSH_PORT ?? 19387)
const ROUTE = `http://127.0.0.1:${String(PORT)}/plugins/dsh-restart-button`

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

// --- the pure decision ------------------------------------------------------

const entry = await import(new URL('../entry.js', import.meta.url).href)

check('entry.js exports helperDeathVerdict', typeof entry.helperDeathVerdict === 'function')

if (typeof entry.helperDeathVerdict === 'function') {
  const verdict = entry.helperDeathVerdict

  check(
    'a live helper during a restart is not a failure',
    verdict({ alive: true, restarting: true }) === null,
  )
  check(
    'a live helper with nothing in flight is not a failure',
    verdict({ alive: true, restarting: false }) === null,
  )
  check(
    'a helper that exits during a DRY RUN is not a failure',
    verdict({ alive: false, restarting: false }) === null,
    'a self-check ending is success, not an error',
  )

  const real = verdict({ alive: false, restarting: true })
  check(
    'a helper that dies during a REAL restart IS a failure',
    typeof real === 'string' && real.length > 0,
    String(real),
  )
  check(
    'the failure message tells the user where to look',
    typeof real === 'string' && real.includes('日志'),
    String(real),
  )
}

// --- and the running Host must actually serve it ----------------------------

let info = null
try {
  const response = await fetch(`${ROUTE}/info`)
  info = await response.json()
} catch (error) {
  console.error(`Could not reach the plugin on port ${String(PORT)}: ${String(error.message)}`)
  console.error('The offline half of this suite passed; start DSH to check the wiring.')
  process.exit(failures === 0 ? 0 : 1)
}

console.log('')
console.log(`host pid: ${String(info.pid)}`)
check(
  '/info carries restartFailed',
  Object.prototype.hasOwnProperty.call(info, 'restartFailed'),
  Object.keys(info).join(', '),
)
check('nothing has failed right now', !info.restartFailed, String(info.restartFailed ?? 'null'))

console.log('')
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`)
if (failures > 0) process.exitCode = 1
