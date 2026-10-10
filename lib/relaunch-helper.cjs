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

/** Whether a PID is still alive. */
function alive(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${String(pid)}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  // A dead PID produces the localised "no tasks match" sentence, which never
  // contains the quoted PID; a live one always does.
  return String(result.stdout ?? '').includes(`"${String(pid)}"`)
}

/**
 * Image name of a PID, or null when it is gone.
 * @param pid - target process id.
 * @returns the executable's file name, e.g. "DeepSeek Harness.exe".
 */
function imageNameOf(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${String(pid)}`, '/NH', '/FO', 'CSV'], {
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

/** Start the application and report its PID, or null on failure. */
function launch(exePath, workingDir, env) {
  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...(workingDir === null || workingDir === undefined ? {} : { cwd: workingDir }),
      env: { ...process.env, ...env },
    })
    child.unref()
    return child.pid ?? null
  } catch (error) {
    log(`launch threw: ${String(error && error.message ? error.message : error)}`)
    return null
  }
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

  log(`start: helper pid ${String(process.pid)}; appPid=${String(appPid)} port=${String(port)} exe=${exePath}`)

  // Let the HTTP response that started this helper reach the browser first.
  await sleep(graceMs)

  // Never kill a process that is not the application binary. If the PID was
  // reused, or this is not the desktop app at all, stopping here is the whole
  // difference between a restart and a wrecked session.
  if (!alive(appPid)) {
    log('target pid is already gone; nothing to kill')
  } else {
    const expected = path.basename(exePath)
    const actual = imageNameOf(appPid)
    if (actual === null || actual.toLowerCase() !== expected.toLowerCase()) {
      log(`REFUSING to kill pid ${String(appPid)}: image is "${String(actual)}", expected "${expected}"`)
      process.exit(3)
    }
    const killed = spawnSync('taskkill.exe', ['/PID', String(appPid), '/T', '/F'], {
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
  while (Date.now() < deadline) {
    const busy = await portBusy(port)
    if (!alive(appPid) && !busy) break
    await sleep(400)
  }
  log('process and port are clear; launching')

  let started = null
  for (let attempt = 1; attempt <= 3 && started === null; attempt += 1) {
    started = launch(exePath, workingDir, env)
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
