// A GUI application must never be launched hidden.
//
// This guards a regression that reached a user. The console-window fix made the
// helper's own creation hidden - correct, that is a console program - and the same
// flag was then applied to the application itself, on the reasoning that "the same
// defect must have the same cause at the other end of the chain". It does not:
//
//   DeepSeek Harness.exe  subsystem 2 = GUI      -> hiding it hides its WINDOW
//   node.exe              subsystem 3 = CONSOLE  -> hiding it hides its console
//
// `windowsHide: true` maps to libuv's UV_PROCESS_WINDOWS_HIDE, which sets both
// CREATE_NO_WINDOW and STARTF_USESHOWWINDOW/SW_HIDE. A GUI process has no console,
// so the SW_HIDE lands on its own first window and it starts invisible - which is
// what the user saw.
//
// Three things are asserted, so the rule rests on measurements rather than prose:
//
//   1. the helper derives `windowsHide` from the binary instead of hardcoding it
//   2. the real application binary really is a GUI program, read from its PE header
//   3. node.exe really is a console program - the control that makes the
//      distinction meaningful rather than a coincidence
//
//   node verify/verify-gui-not-hidden.mjs

import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = join(packageRoot, 'lib', 'relaunch-helper.cjs')
const PORT = Number(process.env.DSH_PORT ?? 19387)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

/**
 * Subsystem from a PE header: 2 = GUI, 3 = console.
 * Written independently of the helper's reader so a bug in one is not mirrored by
 * the other - two implementations that agree are evidence; one copied from the
 * other is not.
 * @param file - absolute path of an executable.
 * @returns the subsystem number, or null.
 */
function peSubsystem(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const header = Buffer.alloc(4096)
    const read = readSync(fd, header, 0, header.length, 0)
    if (read < 64 || header.toString('ascii', 0, 2) !== 'MZ') return null
    const peOffset = header.readUInt32LE(0x3c)
    if (peOffset + 24 > read) return null
    if (header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
    const optional = peOffset + 24
    const magic = header.readUInt16LE(optional)
    if (magic !== 0x10b && magic !== 0x20b) return null
    return header.readUInt16LE(optional + 68)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

// --- 1. the helper must derive the flag, not hardcode it --------------------

const source = readFileSync(helperPath, 'utf8')

check('the helper reads the PE subsystem', /function peSubsystem\s*\(/.test(source))
check(
  'it hides only console programs',
  /const\s+hide\s*=\s*subsystem\s*===\s*3/.test(source),
  'subsystem 3 is console; 2 is GUI and must stay visible',
)
check('it passes the derived value to spawn', /windowsHide:\s*hide\b/.test(source))

// The prohibition is scoped to the APPLICATION launch, not to the whole file.
// `spawnSync(TASKLIST, ..., { windowsHide: true })` is correct and must stay:
// tasklist is a console program, and hiding it is exactly right. A file-wide
// search would forbid that too and force a wrong change.
const launchBody = /function launch\(exePath, workingDir, env\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
check(
  'the application launch was found in the source',
  launchBody !== '',
  'the check below is scoped to this function',
)
check(
  'the application launch does not hardcode windowsHide: true',
  !/windowsHide:\s*true/.test(launchBody),
  'that is the regression that hid the GUI window',
)
check(
  'it logs the decision so a wrong answer shows up in the restart log',
  /log\(`launch: subsystem=/.test(source),
)

// --- 2. and the two binaries really are different kinds ---------------------

let info = null
try {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/plugins/dsh-restart-button/info`)
  info = await response.json()
} catch {
  info = null
}

console.log('')

if (info === null) {
  console.log('DSH is not running, so the binaries could not be inspected. The source')
  console.log('rules above still ran; start DSH to complete this suite.')
  console.log('')
  console.log(failures === 0 ? 'source rules passed' : `${String(failures)} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

// The application executable is the one the helper will launch. It is not served
// by `/info`, but `appPid` is - and that process's image is exactly what `launch`
// starts. `process.execPath` would be wrong here: from the Host that is the
// Electron binary, but this suite may be running under a plain node.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32')
const TASKLIST = join(SYSTEM32, 'tasklist.exe')

const { spawnSync } = await import('node:child_process')
let imageName = null
if (typeof info.appPid === 'number' && info.appPid > 0) {
  const result = spawnSync(TASKLIST, ['/FI', `PID eq ${String(info.appPid)}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const line = String(result.stdout ?? '').trim().split('\n')[0] ?? ''
  imageName = /^"([^"]+)"/.exec(line.trim())?.[1] ?? null
}

check('the application process was identified', imageName !== null, String(imageName))

if (imageName !== null) {
  // The executable path is the app directory plus that image name. It is taken
  // from the running process rather than guessed, and existence is asserted
  // before the header is read.
  const candidates = [
    join(dirname(process.execPath), '..', '..', '..', '..', '..', imageName),
    `D:\\AI类型\\deepseekharness\\${imageName}`,
  ]
  let appExe = null
  for (const candidate of candidates) {
    if (peSubsystem(candidate) !== null) {
      appExe = resolve(candidate)
      break
    }
  }

  check('the application executable was located', appExe !== null, String(appExe))
  if (appExe !== null) {
    const appSubsystem = peSubsystem(appExe)
    console.log(`  ${appExe}`)
    check(
      'the application is a GUI binary (subsystem 2)',
      appSubsystem === 2,
      `subsystem ${String(appSubsystem)}`,
    )
    check(
      'and the helper therefore will not hide it',
      appSubsystem !== 2 || /windowsHide:\s*hide\b/.test(source),
      'a GUI binary launched hidden shows no window',
    )
  }
}

// The control: the bundled runtime the helper itself uses IS a console program,
// which is why hiding it is right. Without this, "hide console binaries" could be
// satisfied by hiding everything.
const nodeSubsystem = peSubsystem(process.execPath)
console.log(`  ${process.execPath}`)
check(
  'the control binary (node) is a console program (subsystem 3)',
  nodeSubsystem === 3,
  `subsystem ${String(nodeSubsystem)}`,
)

console.log('')
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`)
if (failures > 0) process.exitCode = 1
