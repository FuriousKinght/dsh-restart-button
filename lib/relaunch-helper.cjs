// dsh-restart-button — relaunch helper.
//
// @version 1.1.0
//
// 1.1.0（2026-10-27）两项改动：
//
//   ① 优雅关闭优先：原来是 taskkill /T /F 直接强杀，现在改成
//      taskkill /T → 等 8s → 还没退才 /T /F → 等 5s。
//      强杀会让 Chromium 来不及 flush LevelDB（Cookies / shared_proto_db），
//      2026-10-22 的事故就是这样把状态库写坏、导致 DSH 完全起不来的。
//      代价：重启慢约 8 秒。收益：几乎不会再写坏状态库。
//
//   ② 新增 cleanAuthCookies()：在 DSH 已退出、端口已释放的空窗期清理
//      累积的 dsh-auth-* cookie（2026-10-26 事故：71 个 cookie 使请求头
//      16,584 B 超过 Node 上限 16,384，报 "Web authentication failed"）。
//      清理失败只记日志，绝不阻断重启。
//
//   两项互相加强：优雅关闭让库处于一致状态 → 清理读写更可靠。
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
// application path contains CJK characters.
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
 * Clear accumulated DSH auth cookies (FK addition, v1.5.2).
 *
 * WHY THIS LIVES HERE
 *
 *   This process is created through WMI and therefore lives OUTSIDE the DSH
 *   process tree. By the time it has killed the app and waited for the port to
 *   clear, Chromium's exclusive lock on the cookie database is gone - which is
 *   the only moment that database can be rewritten safely.
 *
 *   That makes "restart" and "clear cookies" communicable in one click, instead
 *   of asking the user to quit the app, run a script, and open it again.
 *
 * WHY IT MATTERS (measured 2026-10-26)
 *
 *   The Host binds a dynamic port on every launch and mints one auth cookie
 *   whose NAME is derived from it:
 *
 *       "dsh-auth-" + base64url(sha256("127.0.0.1:PORT"))
 *
 *   A new port means a new name, old cookies are never removed, and Chromium
 *   sends every one of them for host 127.0.0.1. At 71 cookies the Cookie
 *   request header reaches 16,584 bytes, past Node's default maxHeaderSize of
 *   16,384; the Host then fails with HPE_HEADER_OVERFLOW and the shell reports
 *   "desktop welcome: Web authentication failed". Measured on Node 24.21.0:
 *   70 cookies = 16,356 B (200 OK), 71 = 16,584 B (crash).
 *
 *   These cookies hold no account data - only authority, issuedAt, expiresAt -
 *   and a cookie minted for an old port can never match a new one, so removing
 *   them costs nothing. The login token lives in .credentials.yaml.
 *
 * A cleanup failure MUST NOT block the restart: restarting is what the user
 * asked for, cleaning up is a bonus.
 *
 * @param cfg - { dbPath, backupDir, markerPath }.
 * @returns {{removed?:number, skipped?:string, error?:string, backupPath?:string}}
 */
function cleanAuthCookies(cfg) {
  if (cfg === null || typeof cfg !== 'object') return { skipped: 'no config' }
  const dbPath = cfg.dbPath
  if (typeof dbPath !== 'string' || dbPath === '') return { skipped: 'no dbPath' }
  if (!fs.existsSync(dbPath)) return { skipped: 'cookies db not found' }

  // Back up first. No backup means no delete: refuse rather than gamble.
  let backupPath = null
  try {
    const dir = String(cfg.backupDir ?? path.join(path.dirname(dbPath), '_cookie-backup'))
    fs.mkdirSync(dir, { recursive: true })
    backupPath = path.join(dir, 'Cookies')
    fs.copyFileSync(dbPath, backupPath)
  } catch (e) {
    return { error: `backup failed: ${String(e && e.message ? e.message : e)}` }
  }

  // ── 统计 + 删除（一次打开，先读后删）──
  //
  // 这里是【唯一能拿到真实值的地方】：DSH 已退出、Chromium 已释放独占锁。
  // 所以除了删除，还要把看到的真实情况完整记下来 ——
  // 面板运行时读不到，只能靠这份快照说话。
  let removed = 0
  let observed = 0
  let total = 0
  let headerBytes = 0
  let oldest = null
  let newest = null
  const portList = []
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const WHERE = "host_key IN ('127.0.0.1','localhost') AND name LIKE 'dsh-auth-%'"

      try { total = Number(db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n ?? 0) } catch { total = 0 }

      const rows = db.prepare(`SELECT name, value FROM cookies WHERE ${WHERE}`).all()
      observed = rows.length
      const seenPorts = new Set()
      for (const r of rows) {
        const nm = String(r.name ?? '')
        const val = String(r.value ?? '')
        headerBytes += nm.length + 1 + val.length + 2
        try {
          const parts = val.split('.')
          if (parts.length >= 2) {
            const j = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
            if (typeof j.authority === 'string') {
              const m = j.authority.match(/:(\d+)$/)
              if (m) seenPorts.add(Number(m[1]))
            }
            if (typeof j.issuedAt === 'number') {
              if (oldest === null || j.issuedAt < oldest) oldest = j.issuedAt
              if (newest === null || j.issuedAt > newest) newest = j.issuedAt
            }
          }
        } catch { /* payload 解析失败不影响计数 */ }
      }
      portList.push(...[...seenPorts].sort((a, b) => a - b))

      if (observed > 0) {
        db.prepare(`DELETE FROM cookies WHERE ${WHERE}`).run()
        removed = observed
      }
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  } catch (e) {
    return { error: `delete failed: ${String(e && e.message ? e.message : e)}`, backupPath }
  }

  // A zero-byte journal left behind makes Chromium think a transaction is open.
  try {
    const j = `${dbPath}-journal`
    if (fs.existsSync(j) && fs.statSync(j).size === 0) fs.unlinkSync(j)
  } catch { /* ignore */ }

  // ④ 无论清掉几个，都留下这份「实测快照」
  //
  //   ⚠️ 不能以 removed > 0 为条件（原实现的缺陷）：
  //      那样「这次没有 cookie 需要清」就什么也不记，
  //      面板永远显示「还没有实测记录」，用户永远无法核对推算值。
  //
  //   快照是面板唯一的真实数据来源，必须每次都写。
  const snapshot = {
    at: new Date().toISOString(),
    observed,
    total,
    removed,
    headerBytes,
    headerBudget: 15984,
    ratio: headerBytes / 15984,
    ports: portList,
    oldest,
    newest,
    backupPath,
    source: 'relaunch-helper',
    // 谁触发的这次重启（两个插件共用 restart-helper/，靠它区分来源）
    triggeredBy: typeof cfg.triggeredBy === 'string' ? cfg.triggeredBy : null,
  }
  if (typeof cfg.markerPath === 'string' && cfg.markerPath !== '') {
    try {
      fs.mkdirSync(path.dirname(cfg.markerPath), { recursive: true })
      fs.writeFileSync(cfg.markerPath, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch { /* marker is best effort */ }
  }

  return { removed, observed, total, headerBytes, ports: portList.length, backupPath }
}

/**
 * Read a Windows executable's PE subsystem.
 *
 * Needed because `windowsHide` means different things for the two programs this
 * helper deals with, and getting it wrong is invisible until someone looks at the
 * screen. Subsystem 2 is a GUI application and 3 is a console application; the
 * value is read from the header rather than assumed from the file name, so a
 * future rename cannot silently change the answer.
 *
 * @param file - absolute path of an executable.
 * @returns 2 for GUI, 3 for console, or null when it cannot be determined.
 */
function peSubsystem(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(4096)
    const read = fs.readSync(fd, header, 0, header.length, 0)
    if (read < 64 || header.toString('ascii', 0, 2) !== 'MZ') return null
    const peOffset = header.readUInt32LE(0x3c)
    if (peOffset + 24 > read) return null
    if (header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
    const optional = peOffset + 24
    const magic = header.readUInt16LE(optional)
    if (magic !== 0x10b && magic !== 0x20b) return null
    // Subsystem sits at offset 68 in both PE32 and PE32+ optional headers.
    return header.readUInt16LE(optional + 68)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

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
 * WHY `windowsHide` IS FALSE HERE, WHILE THE HELPER'S OWN CREATION USES SW_HIDE
 *
 * These look like the same problem and are not, and treating them as one caused a
 * real regression: the app was relaunched into the background with no visible
 * window.
 *
 * The two programs are different PE kinds - measured from their headers:
 *
 *   DeepSeek Harness.exe  subsystem 2 = GUI (windows)
 *   node.exe              subsystem 3 = CONSOLE
 *
 * `windowsHide: true` maps to libuv's UV_PROCESS_WINDOWS_HIDE, which sets BOTH
 * CREATE_NO_WINDOW and STARTF_USESHOWWINDOW with SW_HIDE. For a console program
 * that hides the console - correct, and what the helper needs. For a GUI program
 * there is no console to hide, so the same flag applies SW_HIDE to the process's
 * own first window: the application starts, fully functional, with no window on
 * screen. That is exactly what a user reported.
 *
 * The application draws its own window and must be left to do so. The console
 * window the user saw came from the HELPER's creation, not from here.
 *
 * @param exePath - absolute path of the application executable.
 * @param workingDir - directory to start it in, or null.
 * @param env - extra environment variables to merge over this process's.
 * @returns the new process id, or null when it could not be started.
 */
function launch(exePath, workingDir, env) {
  return new Promise((resolve) => {
    // The flag is derived from the binary rather than hardcoded, and logged, so a
    // wrong answer here is visible in the restart log instead of only on screen.
    // A GUI binary must never be hidden: `windowsHide` would apply SW_HIDE to its
    // own window and it would start with nothing on screen. A console binary must
    // be hidden, or it allocates a console the user can see and close.
    const subsystem = peSubsystem(exePath)
    const hide = subsystem === 3
    log(`launch: subsystem=${String(subsystem ?? 'unknown')} windowsHide=${String(hide)} (${subsystem === 2 ? 'GUI: window must stay visible' : subsystem === 3 ? 'console: hide the console' : 'unknown: leaving the window visible'})`)

    let child
    try {
      child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: hide,
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
    // ── Graceful shutdown first (FK change 1.0.1, 2026-10-27) ─────────────
    //
    // WHY NOT /F STRAIGHT AWAY
    //
    //   The desktop app is Electron. A forced kill (/F) does not give Chromium
    //   time to flush its LevelDB buffers (Cookies / shared_proto_db), which is
    //   how a state database gets corrupted. The 2026-10-22 incident was exactly
    //   that: force-kill -> wrecked state database -> "Web authentication failed"
    //   on every launch, and no config snapshot could repair it.
    //
    //   DSH's own stop() sequence (app.asar, lib/main.js) is:
    //     child.send({ type: "shutdown" })
    //     -> wait 10s -> child.kill("SIGTERM")
    //     -> wait  5s -> child.kill("SIGKILL")
    //
    //   The taskkill equivalent (no /F means "ask to close", /F means "kill"):
    //     1. taskkill /T       -> wait 8s  (Chromium flushes and closes its DBs)
    //     2. taskkill /T /F    -> wait 5s  (only if it is still alive)
    //     3. still alive -> fall through to the 40s port-clear wait, then WARN
    //
    //   Cost: the restart takes about 8 seconds longer.
    //   Benefit: the state databases are essentially never written broken.

    /**
     * Run taskkill and log its exit status.
     *
     * taskkill writes its message in the console codepage (GBK on this machine),
     * so the text decodes to mojibake under UTF-8; the exit status is the part
     * that can be trusted, and the text is kept only when it survives as ASCII.
     */
    const runTaskkill = (args, label) => {
      const r = spawnSync(TASKKILL, args, { windowsHide: true })
      const text = r.stdout === null ? '' : r.stdout.toString('utf8')
      const ascii = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? ` ${text.trim()}` : ''
      log(`${label} exit=${String(r.status)}${ascii}`)
      return r
    }

    const GRACEFUL_WAIT_MS = 8000
    const FORCED_WAIT_MS = 5000

    log('graceful shutdown: asking the app to close (no /F) so Chromium can flush its LevelDB')
    runTaskkill(['/PID', String(appPid), '/T'], 'taskkill(graceful)')

    let gone = false
    for (let waited = 0; waited < GRACEFUL_WAIT_MS; waited += 400) {
      await sleep(400)
      if (!alive(appPid)) { gone = true; break }
    }

    if (gone) {
      log(`app exited gracefully after ~${String(Math.round(GRACEFUL_WAIT_MS / 1000))}s; state flushed properly`)
    } else {
      log('app did NOT exit gracefully; escalating to forced kill (this may risk state corruption)')
      runTaskkill(['/PID', String(appPid), '/T', '/F'], 'taskkill(forced)')
      for (let waited = 0; waited < FORCED_WAIT_MS; waited += 400) {
        await sleep(400)
        if (!alive(appPid)) { gone = true; break }
      }
      if (gone) log('app exited after forced kill')
      else log('WARNING: app is still alive after forced kill')
    }
  }

  // Wait for the process AND the listening port to clear. The port is the one
  // that actually matters: starting the app while the old server still holds it
  // gives an app that cannot serve, which is worse than not restarting.
  //
  // `port` comes from the config, written by the Host from the port it observed
  // itself being served on - not from a constant. The host assigns its port
  // dynamically, so a guessed number would make this loop wait for something that
  // was never bound.
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

  // ─────────────────────────────────────────────────────────────────
  // FK addition: the app has exited and the port is released, so Chromium's
  // exclusive lock on the cookie database is gone. Clear the accumulated
  // dsh-auth-* rows here - the one safe window. Failure never blocks relaunch.
  // ─────────────────────────────────────────────────────────────────
  if (config.cookies !== undefined && config.cookies !== null) {
    try {
      const r = cleanAuthCookies(config.cookies)
      if (r.error !== undefined) {
        log(`cookie cleanup FAILED (continuing): ${r.error}`)
      } else if (r.skipped !== undefined) {
        log(`cookie cleanup skipped: ${r.skipped}`)
      } else {
        log(r.removed > 0
          ? `cookie cleanup removed ${String(r.removed)} dsh-auth-* (backup: ${String(r.backupPath)})`
          : 'cookie cleanup: nothing to remove')
      }
    } catch (e) {
      log(`cookie cleanup threw (continuing): ${String(e && e.message ? e.message : e)}`)
    }
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
