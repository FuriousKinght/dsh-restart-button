// dsh-restart-button — relaunch helper.
//
// This file is the one piece of the plugin that runs OUTSIDE the DSH process
// tree. It is started through WMI (`Win32_Process.Create`), which parents it to
// WmiPrvSE.exe rather than to DSH, so it survives the `taskkill /T` that takes
// DSH down and is still there to start the app again.
//
// It is a Node script rather than PowerShell for a measured reason: on this
// machine a WMI-created `powershell.exe` fails to start at all ("access denied",
// no output, no log), while the bundled `node.exe` runs correctly from the very
// same context - including from a path containing CJK. Node also reads its own
// configuration as UTF-8 with no codec questions, which matters because the
// application path is `D:\AI类型\...`.
//
// Usage: node relaunch-helper.cjs <config.json path>
//
// The config carries: appPid, exePath, port, workingDir, env.

'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const configPath = process.argv[2]
const logPath = configPath === undefined
  ? path.join(__dirname, 'relaunch.log')
  : path.join(path.dirname(configPath), 'relaunch.log')

/** Append one timestamped line. Never throws: a log failure must not stop a restart. */
function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`, 'utf8')
  } catch {
    /* logging is best effort */
  }
}

/** Promise-based sleep. */
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

/**
 * Resolve a Windows system binary by absolute path.
 *
 * Nothing in this file may call a system tool by BARE NAME. Measured on the
 * machine this plugin was written for: its machine-level PATH has two mangled
 * entries (`%Syste;Root%\system32` instead of `%SystemRoot%\system32`), so
 * System32 is not on PATH and bare-name spawns fail with ENOENT while the same
 * binaries run perfectly when given a full path. That is what broke the restart
 * button once already.
 *
 * @param parts - path segments below the Windows directory.
 * @returns the absolute path that exists, or null.
 */
function systemBinary(parts) {
  const roots = [process.env.SystemRoot, process.env.windir, 'C:\\Windows']
  const seen = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || seen.has(root)) continue
    seen.add(root)
    const candidate = path.join(root, ...parts)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next root */
    }
  }
  return null
}

const TASKLIST = systemBinary(['System32', 'tasklist.exe'])
const TASKKILL = systemBinary(['System32', 'taskkill.exe'])

/**
 * Whether a PID is still alive.
 *
 * `process.kill(pid, 0)` is used rather than `tasklist`, because it needs no
 * external binary at all: a signal of 0 performs the permission and existence
 * checks and stops there. EPERM means the process EXISTS but belongs to someone
 * else, which for this purpose counts as alive.
 *
 * @param pid - process id.
 * @returns whether it is still running.
 */
function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Image name of a PID, or null when it cannot be determined.
 *
 * @param pid - target process id.
 * @returns the executable's file name, e.g. "DeepSeek Harness.exe", or null.
 */
function imageNameOf(pid) {
  if (TASKLIST === null) return null
  const result = spawnSync(TASKLIST, ['/FI', `PID eq ${String(pid)}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const line = String(result.stdout ?? '').trim().split('\n')[0] ?? ''
  const match = /^"([^"]+)"/.exec(line.trim())
  return match === null ? null : match[1]
}

/** Whether anything is listening on the port. */
function portBusy(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (value) => {
      try { socket.destroy() } catch { /* already gone */ }
      done(value)
    }
    socket.setTimeout(700)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

/**
 * Start the application and report its PID, or null on failure.
 *
 * The `try/catch` is NOT what makes this safe, and believing it was is a mistake
 * that has already been made here once. `spawn` reports a missing or unrunnable
 * executable asynchronously through an `'error'` event, not by throwing - measured:
 * spawning a nonexistent path returned normally with `child.pid === undefined` and
 * fired `'error'` with ENOENT a moment later. An `'error'` event with no listener
 * is rethrown as an uncaught exception, so the old version would have crashed the
 * helper on the third failed attempt and never written the "reopen DSH by hand"
 * line that the failure ladder exists to produce.
 *
 * So the listener is the fix, and the promise waits for either outcome: `'spawn'`
 * (the process really started) or `'error'` (it did not).
 *
 * `windowsHide: true` is the other half of the console-window fix. The Electron
 * executable is a console application until it takes over the GUI, so launching it
 * with `windowsHide: false` gave the relaunched app a console window of its own -
 * the same visible-window defect as the helper's own creation, at the other end of
 * the chain. It was `false` before only because nothing had been measured.
 *
 * @param exePath - absolute path of the application executable.
 * @param workingDir - directory to start it in, or null.
 * @param env - extra environment variables to merge over this process's.
 * @returns the new process id, or null when it could not be started.
 */
function launch(exePath, workingDir, env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(workingDir === null || workingDir === undefined ? {} : { cwd: workingDir }),
        env: { ...process.env, ...env },
      })
    } catch (error) {
      // A synchronous throw is still possible for argument errors, so it is kept
      // as well - it just is not the path a missing file takes.
      log(`launch threw: ${String(error && error.message ? error.message : error)}`)
      resolve(null)
      return
    }

    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    child.once('error', (error) => {
      log(`launch failed: ${String(error && error.code ? error.code : error)} ${exePath}`)
      settle(null)
    })
    child.once('spawn', () => {
      const pid = child.pid ?? null
      try {
        child.unref()
      } catch {
        /* unref is best effort; the process is already running */
      }
      settle(pid)
    })
  })
}

async function main() {
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    log(`cannot read ${String(configPath)}: ${String(error.message)}`)
    process.exit(2)
  }

  const appPid = Number(config.appPid)
  const exePath = String(config.exePath)
  const port = Number(config.port)
  const workingDir = config.workingDir ?? null
  const env = config.env ?? {}
  // How long to wait before killing anything. The default covers the round trip
  // of the HTTP response that started this helper; the field exists so a caller
  // that needs a longer runway can ask for one without editing this file.
  const graceMs = Number.isFinite(Number(config.graceMs)) ? Number(config.graceMs) : 1200
  // Check everything, kill nothing. Used to exercise the creation path - and the
  // route that drives it - without restarting a DSH that may be mid-task.
  const dryRun = config.dryRun === true

  log(`start: helper pid ${String(process.pid)}; appPid=${String(appPid)} port=${String(port)} exe=${exePath}${dryRun ? ' [DRY RUN]' : ''}`)

  // Let the HTTP response that started this helper reach the browser first.
  await sleep(graceMs)

  // A dry run reports exactly what it found and stops. Reporting is the point: the
  // failure that motivated this mode was a restart that did nothing visible, where
  // the only clue was a log line nobody had reason to open.
  if (dryRun) {
    const expected = path.basename(exePath)
    const actual = imageNameOf(appPid)
    const busy = await portBusy(port)
    log(`dry run: target alive=${String(alive(appPid))} image=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
    log(`dry run: port ${String(port)} busy=${String(busy)}`)
    log(`dry run: tasklist=${JSON.stringify(TASKLIST)} taskkill=${JSON.stringify(TASKKILL)}`)
    log(`dry run: launch target exists=${String(fs.existsSync(exePath))}`)
    const verdict = actual !== null && actual.toLowerCase() === expected.toLowerCase()
      ? 'target verified, everything needed is present; a real run would kill and relaunch'
      : 'target NOT verified; a real run would refuse'
    log(`dry run: ${verdict}`)
    log('done')
    process.exit(0)
  }

  // Never kill a process that is not the application binary. If the PID was
  // reused, or this is not the desktop app at all, stopping here is the whole
  // difference between a restart and a wrecked session.
  if (!alive(appPid)) {
    log('target pid is already gone; nothing to kill')
  } else {
    const expected = path.basename(exePath)
    const actual = imageNameOf(appPid)
    if (actual !== null && actual.toLowerCase() !== expected.toLowerCase()) {
      log(`REFUSING to kill pid ${String(appPid)}: image is "${actual}", expected "${expected}"`)
      process.exit(3)
    }
    if (actual === null) {
      // The image name could not be read, so the check that makes this safe did
      // not run. Killing anyway would be the difference between a restart and a
      // wrecked session if the PID had been reused, so it does not happen.
      log(`REFUSING to kill pid ${String(appPid)}: could not read its image name to verify it is "${expected}"`)
      process.exit(3)
    }

    if (TASKKILL === null) {
      log('cannot find taskkill.exe under System32; not killing anything')
      process.exit(4)
    }
    const killed = spawnSync(TASKKILL, ['/PID', String(appPid), '/T', '/F'], {
      windowsHide: true,
    })
    // taskkill writes its message in the console codepage (GBK on this machine),
    // so the text decodes to mojibake under UTF-8; the exit status is the part
    // that can be trusted, and the text is kept only when it survives as ASCII.
    const text = killed.stdout === null ? '' : killed.stdout.toString('utf8')
    const ascii = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? ` ${text.trim()}` : ''
    log(`taskkill exit=${String(killed.status)}${ascii}`)
  }

  // Wait for the process AND the listening port to clear. The port is the one
  // that actually matters: starting the app while the old server still holds
  // 19387 gives an app that cannot serve, which is worse than not restarting.
  const deadline = Date.now() + 40000
  let cleared = false
  while (Date.now() < deadline) {
    const busy = await portBusy(port)
    if (!alive(appPid) && !busy) {
      cleared = true
      break
    }
    await sleep(400)
  }
  // Said differently depending on what actually happened. The previous version
  // logged "process and port are clear; launching" unconditionally, which is a
  // lie in precisely the case the log exists to explain - and a reader chasing a
  // failed restart would have been told everything was fine.
  if (cleared) {
    log('process and port are clear; launching')
  } else {
    log(
      `WARNING: after 40s the old process is ${alive(appPid) ? 'still alive' : 'gone'} `
      + `and port ${String(port)} is still held; launching anyway`,
    )
  }

  let started = null
  for (let attempt = 1; attempt <= 3 && started === null; attempt += 1) {
    started = await launch(exePath, workingDir, env)
    log(started === null ? `launch attempt ${String(attempt)} failed` : `launched pid ${String(started)} on attempt ${String(attempt)}`)
    if (started === null) await sleep(800)
  }

  if (started === null) {
    log('LAUNCH FAILED - DSH has to be reopened by hand')
    process.exit(4)
  }
  log('done')
}

main().catch((error) => {
  log(`helper failed: ${String(error && error.stack ? error.stack : error)}`)
  process.exit(1)
})
