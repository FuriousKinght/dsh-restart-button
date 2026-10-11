// dsh-restart-button — Host half.
//
// One job: turn "this process tree is about to die" into "the desktop app comes
// back on its own". None of that is obvious on Windows, so every step is written
// out here rather than hidden behind a helper library.
//
// WHY THIS IS NOT A PROCESS SIGNAL
//
// The DSH desktop app is Electron. `DeepSeek Harness.exe` (PID A) owns the
// window and spawns this Host as a plain child (PID B) with an IPC channel; the
// Web server, this plugin, and every tool call live in B. Nothing in A or B
// exposes a restart: the Electron main process has `app.relaunch()` and even a
// `restartAppHostMenu` item, but both are hard-wired to the DEVELOPMENT menu
// (`...development ? [...] : []`), so a packaged install never shows them, and
// the Host -> Electron IPC channel carries only shutdown-complete, quit
// inspection, and update replies. There is no "restart" message to send.
//
// WHY A PLAIN CHILD PROCESS CANNOT DO THE RELAUNCH
//
// The only way to restart is to kill A and start it again. Killing A alone is
// not enough: B (and the Web server holding port 19387) would be orphaned, the
// port would stay bound, and the relaunched app would fail to serve. So the kill
// has to take the whole tree - `taskkill /T` - and that would take any helper
// this plugin spawned with it, because `/T` walks the parent/child chain and a
// `spawn(..., {detached:true})` child is still a child in that chain.
//
// The helper is therefore created through WMI (`Win32_Process.Create`), and a
// WMI-created process is parented to WmiPrvSE.exe rather than to us. It sits
// outside the tree that `/T` walks, so it survives the kill and can relaunch.
// Measured here: the created process reported ParentProcessId = WmiPrvSE, not
// the creating process.
//
// WHY THE HELPER RUNS ON THE BUNDLED NODE, NOT ON POWERSHELL
//
// Measured, not assumed. A WMI-created `powershell.exe` does not start on this
// machine: the process is created (ReturnValue 0) and dies immediately with
// "access denied", writing no output and no log - even for a three-line script
// that only appends to a file, while `cmd.exe`, `whoami` and `where` run from
// the same context without complaint. The bundled `node.exe` runs correctly
// there, including when its own path contains CJK.
//
// Node also removes the encoding problem. The app's path is
// `D:\AI类型\deepseekharness\DeepSeek Harness.exe`, and a batch or PowerShell
// file carrying those bytes is a liability: Windows PowerShell 5.1 decodes a
// BOM-less file as the system ANSI codepage, so CJK content can be mangled or can
// terminate a string literal outright. So the helper holds no path at all: every
// machine-specific value travels in a sidecar `config.json`, which the helper
// reads as UTF-8. The WMI command line is passed straight to CreateProcess (no
// shell is involved), so quoting is ordinary and CJK is safe.
//
// (8.3 short names would have been another way to dodge the CJK paths. They are
// unavailable on this volume: `%~sI` returns the long path unchanged.)

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

/** Package name; also the client bundle id. */
export const name = 'dsh-restart-button'

/** Services this half consumes. `webServer` is all it needs. */
export const inject = ['webServer']

/** Route prefix. Exact routes only — see the note in `apply`. */
const ROUTE = '/plugins/dsh-restart-button'

/** The port the desktop app always serves on (dsh-desktop-host hard-codes it). */
const DESKTOP_PORT = 19387

/** The relaunch helper, shipped beside the browser bundle. */
const HELPER_SCRIPT = fileURLToPath(new URL('./lib/relaunch-helper.cjs', import.meta.url))

/** Name of the sidecar the helper reads. Holds every non-ASCII path. */
const HELPER_CONFIG = 'config.json'

/**
 * Identity of THIS Host process.
 *
 * The browser half needs to tell "the app I was talking to" from "the app that
 * came back". A restart necessarily produces a new process, so a new token, which
 * is exactly the signal the page waits for before reloading itself.
 */
const BOOT_TOKEN = randomUUID()

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Depth-limited search for `node.exe` under a directory.
 * @param dir - directory to scan.
 * @param depth - remaining levels.
 * @returns the first match, or null.
 */
function findNodeBinary(dir, depth) {
  if (depth < 0) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'node.exe') {
      const candidate = join(dir, entry.name)
      // `dependencies/node/bin/node.exe` is the runtime; a same-named file in a
      // package's test fixtures would not be.
      if (candidate.includes(`${'bin'}`)) return candidate
      return candidate
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findNodeBinary(join(dir, entry.name), depth - 1)
    if (found !== null) return found
  }
  return null
}

/**
 * Resolve a Windows system binary by absolute path.
 *
 * This plugin must never spawn a system tool by BARE NAME, and that is not
 * theoretical: it is the bug that broke the restart button on the machine this was
 * written for. That box has a machine-level PATH with two mangled entries
 * (`%Syste;Root%\system32` instead of `%SystemRoot%\system32`), so System32 is
 * genuinely not on PATH and `spawn('powershell.exe')` fails with ENOENT even
 * though the file is exactly where Windows keeps it. Measured: `powershell.exe`,
 * `cmd.exe`, `taskkill.exe`, `tasklist.exe` and even `node.exe` are all
 * unreachable by name there, and all of them run when given a full path.
 *
 * `SystemRoot` is used rather than a hardcoded `C:\Windows`, and its usual
 * fallbacks are tried in order, so this works on a machine where Windows lives
 * elsewhere.
 *
 * @param parts - path segments below the Windows directory, e.g.
 *   `['System32', 'taskkill.exe']`.
 * @returns the absolute path that exists, or null when none does.
 */
function systemBinary(parts) {
  const roots = [
    process.env.SystemRoot,
    process.env.windir,
    'C:\\Windows',
  ]
  const seen = new Set()
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || seen.has(root)) continue
    seen.add(root)
    const candidate = join(root, ...parts)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next root */
    }
  }
  return null
}

/**
 * Locate the Node runtime that will run the helper.
 *
 * The desktop payload keeps exactly one, under `resources/runtime`. The plugin
 * cannot use `process.execPath` for this: that is the Electron binary, and
 * starting it without `ELECTRON_RUN_AS_NODE` would open a second copy of the app
 * instead of running a script. WMI cannot set an environment variable, so the
 * plain runtime is the only option that needs no shell in between.
 * @returns the node path, or null when it cannot be found.
 */
function resolveNode() {
  const exeDir = dirname(process.execPath)
  const explicit = join(
    exeDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
  )
  try {
    if (statSync(explicit).isFile()) return explicit
  } catch {
    /* fall through to the search */
  }
  return findNodeBinary(join(exeDir, 'resources', 'runtime'), 6)
}

/**
 * Pick the directory the helper's config and log live in.
 *
 * `%DSH_HOME%\restart-helper` is the intended home: a plain path next to the
 * rest of the DSH state, and somewhere a user can find the log when a restart
 * misbehaves. The system temp directory is the fallback.
 * @returns the chosen directory.
 */
function helperDir() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'restart-helper')
  return join(tmpdir(), 'dsh-restart-helper')
}

/**
 * Describe the application this Host is running inside.
 *
 * `process.ppid` is the Electron main process: the desktop Host is spawned
 * directly by it, with an IPC channel (`process.connected` is true, and
 * `dsh-desktop-host` uses `process.send` to report shutdown). That channel is
 * also what distinguishes the desktop app from `dsh web` started in a terminal,
 * where killing the parent would kill the user's shell.
 * @returns the target description, or an explanation of why there is none.
 */
function resolveTarget() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '这个按钮目前只支持 Windows 桌面版 DSH。' }
  }
  const appPid = process.ppid
  const exePath = process.execPath
  if (typeof appPid !== 'number' || appPid <= 1) {
    return { ok: false, reason: '读不到父进程 PID，无法确定要重启哪个进程。' }
  }
  if (typeof exePath !== 'string' || exePath === '' || extname(exePath).toLowerCase() !== '.exe') {
    return { ok: false, reason: '当前进程不是由桌面应用启动的（没有可执行文件路径）。' }
  }
  if (process.connected !== true || typeof process.send !== 'function') {
    return {
      ok: false,
      reason: '当前不是桌面版 DSH（Host 与 Electron 之间没有 IPC 通道），重启按钮不适用。'
        + '如果这是命令行启动的 dsh web，请直接在终端里重启它。',
    }
  }
  return {
    ok: true,
    appPid,
    exePath,
    appName: basename(exePath),
    // The working directory is carried through rather than invented. The Host
    // inherits its cwd from the Electron main process, which is where the app was
    // originally launched from, and the profile's own sandbox policy derives its
    // `workspaceRoot` from `process.cwd()` - so starting the app from anywhere
    // else would quietly move the default workspace.
    workingDir: process.cwd() === '' ? dirname(exePath) : process.cwd(),
  }
}

/**
 * Write the helper's config, then start the helper through WMI.
 *
 * WMI is the whole point: a process this Host spawns normally would be a child
 * in the tree that `taskkill /T` is about to walk, and would die with it.
 * `Win32_Process.Create` produces a process parented to WmiPrvSE instead, which
 * survives the kill and is therefore able to relaunch the app.
 * @param target - resolved target description.
 * @param dryRun - when true the helper is told to verify everything and stop
 *   short of killing anything. See the note on the config's `dryRun` field.
 * @returns the created helper's PID, or an explanation of the failure.
 */
async function startHelper(target, dryRun = false) {
  const node = resolveNode()
  if (node === null) {
    return { helperPid: null, error: '找不到 DSH 自带的 node.exe，无法启动重启助手' }
  }

  const dir = helperDir()
  mkdirSync(dir, { recursive: true })

  // Only the variables that locate DSH's own state are forwarded. The
  // WMI-created helper inherits the WMI provider's environment rather than this
  // process's, so anything the app needs from here has to be written down - but
  // forwarding every DSH_* variable would be worse than forwarding none: this
  // process carries DSH_SESSION_ID, DSH_WEB_URL and DSH_SHELL describing the
  // session being killed, and the relaunched app would inherit them as if they
  // were its own. It repopulates all three for its own children.
  const env = {}
  for (const key of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }

  const configPath = join(dir, HELPER_CONFIG)
  writeFileSync(configPath, JSON.stringify({
    appPid: target.appPid,
    exePath: target.exePath,
    port: DESKTOP_PORT,
    workingDir: target.workingDir ?? null,
    env,
    // A dry run exists so the whole creation path can be exercised - and tested -
    // without disturbing a running DSH. The helper still verifies the target, the
    // tools and the port, then stops before the kill; see its own note.
    dryRun,
    requestedAt: new Date().toISOString(),
  }, null, 2), 'utf8')

  // CreateProcess parses this directly - no shell sits in between - so ordinary
  // quoting is correct, and CJK in either path is safe because the string is
  // carried as UTF-16 the whole way.
  const commandLine = `"${node}" "${HELPER_SCRIPT}" "${configPath}"`
  const psCommand = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create '
    + `-Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' } | `
    + 'Select-Object -ExpandProperty ProcessId'

  // Absolute, never 'powershell.exe'. See `systemBinary` for the measured reason.
  const shell = systemBinary(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
  if (shell === null) {
    return {
      helperPid: null,
      error: '找不到 powershell.exe（System32\\WindowsPowerShell\\v1.0），无法通过 WMI 创建重启助手',
      dir,
      logPath: join(dir, 'relaunch.log'),
      node,
    }
  }

  const created = await new Promise((resolve) => {
    const child = spawn(shell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    // The failure reason is carried through rather than flattened. The original
    // version answered "powershell 启动失败" for every possible cause, which is how
    // a PATH problem stayed invisible: `error.code` names ENOENT versus EPERM, and
    // the attempted path says which one was missing.
    child.on('error', (error) => {
      resolve({
        pid: null,
        error: `${shell} 启动失败：${String(error.code ?? error.message)}`,
      })
    })
    child.on('close', (code) => {
      const pid = Number.parseInt(out.trim(), 10)
      if (Number.isFinite(pid) && pid > 0) resolve({ pid })
      else {
        const detail = err.trim() || out.trim() || '(没有输出)'
        resolve({ pid: null, error: `WMI 没有返回进程号（powershell 退出码 ${String(code)}）：${detail}` })
      }
    })
  })

  return {
    helperPid: created.pid,
    error: created.error,
    dir,
    logPath: join(dir, 'relaunch.log'),
    node,
  }
}

/**
 * Mount the two routes and answer them.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const server = ctx.webServer

  // A restart in flight, so a second click cannot start a second helper. The flag
  // lives only in this process, which is correct: it guards the window between
  // "helper started" and "this process is gone".
  let restarting = false

  /**
   * Whether the client-module registry accepted this package's browser half.
   *
   * Reported because the bundle is not reachable by guessing a URL: the registry
   * serves it from a precomputed map keyed by the EXACT
   * `/plugins/??<id>/client.js&rev=<rev>` string, so a hand-made request 404s
   * whether or not the package registered, and that 404 proves nothing either
   * way. `clientPath` answers the real question - did the scan resolve this
   * package and find its `./client` export - so a missing button can be told
   * apart from a bundle that was never composed.
   * @returns the resolved bundle path, or null when the registry does not list it.
   */
  const bundlePathOf = () => {
    try {
      const modules = ctx.get('clientModules')
      if (modules === undefined || modules === null) return null
      if (typeof modules.clientPath !== 'function') return null
      return modules.clientPath(name) ?? null
    } catch {
      return null
    }
  }

  /** What the browser half needs before it is allowed to restart. */
  const describe = () => {
    const target = resolveTarget()
    const node = resolveNode()
    return {
      token: BOOT_TOKEN,
      pid: process.pid,
      restarting,
      available: target.ok && node !== null,
      reason: target.ok
        ? (node === null ? '找不到 DSH 自带的 node.exe，重启助手无法运行。' : null)
        : target.reason,
      appPid: target.ok ? target.appPid : null,
      appName: target.ok ? target.appName : null,
      port: DESKTOP_PORT,
      platform: process.platform,
      // Reported because it is carried into the relaunch: the profile's sandbox
      // policy derives its `workspaceRoot` from `process.cwd()`, so the value the
      // new process starts with is worth being able to see.
      cwd: process.cwd(),
      helperDir: helperDir(),
      nodePath: node,
      bundlePath: bundlePathOf(),
    }
  }

  // Two EXACT routes rather than one prefix on ROUTE. The web server resolves
  // prefixes longest-first, and client-modules serves this package's own browser
  // bundle under `/plugins`; a prefix here would answer that request with this
  // plugin's 404, the bundle would never load, and the button would never appear.
  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/info`,
    handler: (req, res) => {
      sendJson(res, 200, describe())
    },
  }), 'restart-button: info route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/restart`,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
        return
      }
      const target = resolveTarget()
      if (!target.ok) {
        sendJson(res, 409, { ok: false, error: target.reason })
        return
      }
      if (restarting) {
        sendJson(res, 409, { ok: false, error: '已经有一次重启在进行了。' })
        return
      }
      restarting = true

      void (async () => {
        // `?dryRun=1` creates the helper and lets it check everything it would
        // need, but stops it before the kill. It exists so this whole path can be
        // exercised - by a person or by verify/verify-route.mjs - without
        // restarting a DSH that may be in the middle of something.
        const dryRun = new URL(req.url, 'http://127.0.0.1').searchParams.get('dryRun') === '1'
        const started = await startHelper(target, dryRun)
        if (started.helperPid === null) {
          // Nothing was killed, so the session is intact and the failure can be
          // reported honestly rather than pretended away.
          restarting = false
          ctx.logger?.error?.('restart-button: helper was not created', started.error)
          sendJson(res, 500, {
            ok: false,
            error: `没能启动重启助手：${String(started.error)}。DSH 没有被关闭。`,
          })
          return
        }
        ctx.logger?.info?.(
          `restart-button: helper pid ${String(started.helperPid)} `
          + `${dryRun ? 'is doing a dry run' : 'will restart the app'}; `
          + `log at ${started.logPath}`,
        )
        // Answered BEFORE the helper's 1.2 s grace expires, so the browser learns
        // the restart is under way and can start polling for the new process.
        sendJson(res, 200, {
          ok: true,
          dryRun,
          helperPid: started.helperPid,
          logPath: started.logPath,
          token: BOOT_TOKEN,
        })
      })().catch((error) => {
        restarting = false
        ctx.logger?.error?.('restart-button: restart route failed', error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: `重启失败：${String(error)}。DSH 没有被关闭。` })
        } else {
          res.end()
        }
      })
    },
  }), 'restart-button: restart route')
}
