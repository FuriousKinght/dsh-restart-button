# dsh-restart-button

A button at the foot of the sidebar that restarts the DSH desktop app: it closes
itself, comes back, and the page reconnects on its own. No more closing the window
by hand and double-clicking the icon again.

- **Platform:** Windows desktop only.
- **Requires DSH `0.2.0-rc.2` or newer** — the version this plugin was developed
  and verified against, and the oldest build it is claimed to work on. The
  requirement is declared in `package.json` as `peerDependencies` on
  `@deepseek-ai/dsh-host-webserver` (the route registration this needs) and
  `@deepseek-ai/dsh-client-ui-slots` (the footer slot the button mounts into).
  DSH checks those before importing a plugin, so an older build refuses the
  install with a named reason instead of mounting a button that never draws.
- **Applies to:** the packaged desktop app. It refuses to run under `dsh web` in a
  terminal, where killing the parent process would kill your shell.
- **Cost of a restart:** it is a force-kill (`taskkill /T /F`), so a task that is
  currently running is interrupted. That is why the button needs two clicks — the
  first arms it for 5 seconds, the second confirms.
- **Nothing to configure:** the plugin declares no settings namespace and has no
  dependencies outside the Node standard library.

### Version requirement

The range is `^0.2.0-rc.2`, which resolves to `>=0.2.0-rc.2 <0.3.0`. DSH evaluates
it as `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` against
the harness's own version, and refuses the install when it does not match. That
call was reproduced against a real `semver` for the cases that matter:

| Harness version | Installs | |
| --- | --- | --- |
| `0.1.7-rc.2` | ❌ | below the floor |
| `0.2.0-rc.1` | ❌ | the release just before the one this was built against |
| `0.2.0-rc.2` | ✅ | the version this plugin was developed and tested on |
| `0.2.0-rc.3`, `0.2.0`, `0.2.1` | ✅ | later prereleases and patches of the same minor |
| `0.3.0` | ❌ | outside the `^` upper bound, so a new minor needs a re-check |

The floor is a statement about where this was tested, not a claim about which
internal API each earlier build happened to lack — those builds were not available
to check. What *is* verified is the range itself: DSH's own call was reproduced
against `semver` 7.8.5, and every row above comes from running it rather than from
reading it.

A refusal is not a crash: it is one line naming the plugin, the version and the
peer that did not match, and `dsh plugin allow-version` exists to override it
deliberately.

### Source layout

| Path | What it is |
| --- | --- |
| [`entry.js`](entry.js) | Host half: serves `/plugins/dsh-restart-button/{info,restart}` and starts the relaunch helper. |
| [`src/client.js`](src/client.js) | Browser half: registers one action in the `sidebar.footer.action` slot. |
| [`lib/client.js`](lib/client.js) | The built browser bundle. Committed, so the repository installs from source with no build step. |
| [`lib/relaunch-helper.cjs`](lib/relaunch-helper.cjs) | The process that outlives the kill and starts the app again. |
| [`tools/`](tools) | `install.mjs` / `uninstall.mjs` for a profile. |
| [`verify/`](verify) | Two test suites; neither touches a running DSH. |

## Why this is not a one-line IPC call

The Electron main process has `app.relaunch()`, and there is even a
`restartAppHostMenu` item — but both sit inside a `...development ? [...] : []`
branch, so a packaged build never gets them. The Host → Electron IPC channel
carries only shutdown-complete, quit-inspection and update replies; there is no
restart message to send. A restart therefore has to kill the whole process tree
from outside and start the executable again, which brings two problems this plugin
exists to solve:

1. **The helper must outlive the tree it kills.** Killing only the main process
   would orphan the Host and leave port 19387 bound, so the new app could not
   serve. `taskkill /T` takes the tree — including any process this plugin spawned
   normally, since `/T` walks the parent/child chain and a `detached` child is still
   a child in it. The helper is therefore created through WMI
   (`Win32_Process.Create`), which parents it to `WmiPrvSE.exe`, outside that tree.
2. **A WMI-created `powershell.exe` does not start on this machine** — it exits
   immediately with "access denied", writing no log, even for a three-line script,
   while `cmd.exe` and `where` run from the same context. The bundled `node.exe`
   runs correctly there even with CJK in its path, so the helper is a Node script.
   That also keeps the app's path in a UTF-8 `config.json` sidecar rather than inside
   a `.ps1`/`.cmd`, which Windows PowerShell 5.1 decodes as ANSI.

The page recovers by comparing a per-process `token`. The gap between the click and
the kill is about 1.2 s, during which the old server still answers, so "reload when
the server responds" would reload straight back into the dying process. Waiting for
a *different* token can only be satisfied by a different process.

## Install

```sh
node tools/install.mjs --profile desktop     # junction + one row in cordis.patch.yml
node tools/uninstall.mjs --profile desktop   # reverses both
```

The patch layer hot-reloads, so the row mounts without a restart — but a running
process keeps the old `entry.js` (Node's ESM cache has no cache-busting), so the
first activation needs one restart.

## Verification

```sh
node verify/verify-install.mjs     # the browser half passes the client-module scan
node verify/verify-relaunch.mjs    # the helper survives killing its own creator's tree
```

`verify-relaunch.mjs` reproduces the production shape with a stand-in process and
touches no running DSH: the stand-in creates the helper through WMI, and the helper
then runs `taskkill /T /F` on the stand-in's tree. If the helper were an ordinary
child of that tree, its own kill would take it down halfway and the log would stop
before `launched`.

---

# 中文文档

侧边栏脚下的一个按钮：点一下，DSH 自己关掉再起来，页面自己恢复。不用再手动关掉窗口、再手动双击图标。

```
侧边栏底部
  ┌──────────────────────────┐
  │  ⟳  重启 DSH             │   ← 第一下：进入确认态（5 秒后自动取消）
  └──────────────────────────┘
  ┌──────────────────────────┐
  │  ⟳  再点一次确认          │   ← 第二下：真的重启
  └──────────────────────────┘
        ↓
  正在重启… → 等待 DSH 回来… → 页面自动刷新
```

---

## 它到底做了什么

DSH 桌面版本体是 Electron：`DeepSeek Harness.exe`（主进程）负责窗口，它派生一个 Host 子进程跑 Web 服务和所有工具调用。**从插件里没有办法让应用自己重启**：

- Electron 主进程确实有 `app.relaunch()`，甚至菜单里就有一项 `restartAppHostMenu`，但它被写死在**开发者菜单**分支里（`...development ? [...] : []`），打包版根本不会显示；
- Host 到 Electron 的 IPC 通道只有三种消息：`shutdown-complete`、退出检查、更新回复。没有"重启"这一种。

所以重启只能由外部完成：**杀掉整棵进程树，再把可执行文件重新拉起来**。这里有两个坑，都踩过并且都测过：

### 坑一：助手进程必须活过它自己要杀的那棵树

杀掉主进程是不够的——Host 子进程会变成孤儿，继续占着 19387 端口，新起来的应用绑不上端口。所以必须 `taskkill /T`（连整棵树一起杀）。但 `/T` 是按父子链走的，**普通 `spawn(..., {detached:true})` 出来的子进程仍然在这条链上**，会跟着一起死。

解法：用 WMI（`Win32_Process.Create`）创建助手进程。WMI 创建出来的进程父进程是 `WmiPrvSE.exe`，**不在被杀的树里**。这一点在本机实测过，也有自动化测试守着（见下）。

### 坑二：WMI 创建出来的 `powershell.exe` 根本起不来

一开始助手是用 PowerShell 写的。实测结果是：WMI 返回成功、进程号也有了，但进程瞬间退出，"拒绝访问"，不写日志、不留输出——哪怕脚本只有三行、只是往文件里追加一行字。同样的环境里 `cmd.exe`、`whoami`、`where` 都正常。

换成本机自带的 `node.exe` 就正常了，**即使它的路径里有中文**。所以助手是一个 Node 脚本（[`lib/relaunch-helper.cjs`](lib/relaunch-helper.cjs)），顺带也把编码问题一起解决了——应用路径是 `D:\AI类型\deepseekharness\DeepSeek Harness.exe`，而 `.ps1` / `.cmd` 里塞中文是危险的：Windows PowerShell 5.1 会把无 BOM 的文件按系统 ANSI 代码页解码，中文可能被改坏、甚至提前结束字符串字面量。

（本来还有一条路是 8.3 短路径，可以绕开中文路径。本机这个卷**没开** 8.3：`%~sI` 原样返回长路径。）

### 坑三：**永远不要用裸名调用系统程序**（这个是真正让按钮失效过的）

这是发布之后才暴露出来的 bug，也是这份文档里最值得记住的一条。

本机**机器级 PATH 有两项是坏的**，从注册表读到的原始值：

```
%Syste;Root%\system32                          ← 分号跑进了变量名里
%SystemRoot%\System32\WindowsPowerShell\v1.0\  ← 同样坏了
```

`%Syste;Root%` 展开后是空的，于是 **System32 实际上不在 PATH 上**。实测：

| 调用方式 | 结果 |
|---|---|
| `spawn('powershell.exe', …)` | ❌ `ENOENT` |
| `spawn('taskkill.exe', …)` | ❌ `ENOENT` |
| `spawn('tasklist.exe', …)` | ❌ `ENOENT` |
| 以上三者用**绝对路径** | ✅ 全部正常 |

所以规则是：**解析系统程序一律走绝对路径**（`SystemRoot` 优先，`windir` 与 `C:\Windows` 回退），绝不写裸名。

两个附带的教训：

- **错误信息里必须带路径和错误码。** 原来的写法是 `powershell 启动失败`，它把 `ENOENT`、`EPERM` 和其他所有原因压成同一句话、还不说是哪个路径 —— 这就是它藏了整整一天的原因。现在会输出 `C:\WINDOWS\...\powershell.exe 启动失败：ENOENT`。
- **测试如果用和产品不同的机制，就测不到产品的 bug。** 原来的 `verify-relaunch.mjs` 自己用裸名调用 PowerShell，而它跑在一个 PATH 尚未损坏的 shell 里，于是**一直通过**；而插件运行在后来才启动、继承坏 PATH 的 Host 进程里，一直失败。那个套件现在改为**和插件完全相同的解析方式**，并且新增了 [`verify/verify-route.mjs`](verify/verify-route.mjs) 直接打插件的 HTTP 路由、不自己拼任何命令行。

进程存活检测也顺势去掉了对 `tasklist` 的依赖，改用 `process.kill(pid, 0)` —— 少依赖一个系统程序，就少一个能被 PATH 弄坏的地方。

### 页面是怎么自己回来的

点重启会把正在服务这个页面的进程杀掉，但**页面本身不会被卸载**，只是连接断了——所以它有机会自己恢复。难点在于：从"点了按钮"到"进程真的被杀"之间有大约 1.2 秒，这期间服务器还在正常应答，如果只是"轮询到服务器有响应就刷新"，会立刻刷新回**旧进程**，看起来像按钮没生效。

所以 Host 每一份响应都带一个只属于本进程的 `token`。页面记住当前 token，重启后**等一个不一样的 token**——不同的 token 只可能来自不同的进程，正好就是它在等的东西。不靠超时猜、不靠计时赌。

初版还额外要求"必须先观察到一次连接失败"才认这个新 token。那个条件后来去掉了，因为它**既没用又有害**：

- **没用**：代码里另有一个分支在 `token` 不同时无条件刷新，所以那个条件从来没真正拦住过什么——注释声称它防住的情况，其实防不住。
- **有害**：应用通常一两秒就回来了，而轮询间隔是 800 毫秒，完全可能**第一次轮询时新进程已经在服务**。要求页面必须亲眼看到那个空档，会把一次顺利的重启变成超时失败。

现在只有一条规则：**token 不同就刷新**。token 是进程的身份，它比"有没有看到断开"可靠得多。

---

## 安装

```sh
node tools/install.mjs --profile desktop
```

做两件事：在 `<profile>/node_modules/` 下建一个目录联接，以及在 `<profile>/cordis.patch.yml` 末尾追加一行 `- insert:`。

补丁层是热加载的，所以**装完不用重启**就会挂上；但浏览器页面要刷新一次才会出现按钮。

卸载：

```sh
node tools/uninstall.mjs --profile desktop
```

两个脚本都用 Node 而不是 PowerShell 写，是刻意的：补丁层是无 BOM 的 UTF-8 而且里面有中文（某个 provider 的 `displayName`），而 PowerShell 5.1 的两个默认行为恰好都会毁掉它（`Get-Content` 按 ANSI 解码、`Set-Content -Encoding utf8` 写出带 BOM）。用 Node 就是按它本来的样子读、按它本来的样子写。

## 验证

```sh
node verify/verify-install.mjs        # 浏览器半边的打包链路能不能被扫描器认下来
node verify/verify-relaunch.mjs       # 助手的"活过自己杀的那棵树"——用替身，不碰正在跑的 DSH
node verify/verify-launch-failure.mjs # 启动失败时，助手要活下来并把原因写进日志
node verify/verify-route.mjs          # 直接打 /restart 路由（dry-run，不会真的重启）——需要 DSH 在跑
```

`verify-route.mjs` 是**最要紧的一个**，因为它测的是产品真正会走的那条路：它通过 HTTP 打插件的路由，**不自己拼任何命令行**（这一点是关键 —— 见上面"坑三"里那条教训）。

它用 `?dryRun=1`：助手被**真实创建**、真实验证目标进程与所有系统程序、真实检查端口，然后**在动手之前停下**。所以它随时可以跑，不会打断你手上正在做的事。

输出长这样：

```
dry run: target alive=true image="DeepSeek Harness.exe" expected="DeepSeek Harness.exe"
dry run: tasklist="C:\WINDOWS\System32\tasklist.exe" taskkill="C:\WINDOWS\System32\taskkill.exe"
dry run: target verified, everything needed is present; a real run would kill and relaunch
```

如果哪一步不对（PATH 坏了、`node.exe` 找不到、目标进程对不上），它会在这里说清楚，而不是等到你按下按钮才发现。

`verify-launch-failure.mjs` 守的是另一条**很容易写错**的路径。`spawn` 启动一个不存在的程序时**不会抛异常** —— 它异步发一个 `'error'` 事件，而 `EventEmitter` 的 `'error'` 事件如果没有监听器，会**直接变成未捕获异常把进程干掉**。所以把 `spawn` 包在 `try/catch` 里是**没用的**：

```js
try { spawn('不存在的.exe') } catch { /* 永远进不来 */ }
```

初版就是这么写的。后果是：三次重试到第三次时助手崩溃，那句 `LAUNCH FAILED - DSH has to be reopened by hand` **永远不会写进日志** —— 恰恰是在最需要它的时刻。现在 `launch()` 监听 `'spawn'`（真的起来了）和 `'error'`（没起来）两个事件，测试让它在真实文件缺失的情况下跑完整个阶梯，断言日志里有三次失败和那句收尾。

`verify-relaunch.mjs` 测的是**助手必须活过它自己要杀的那棵树**。它复刻了真实的形状：一个替身进程自己通过 WMI 创建助手，助手再 `taskkill /T /F` 杀掉替身那棵树。如果助手是那棵树里的普通子进程，它自己的这一刀就会把自己带走，日志会停在半路。测试不额外加任何强制手段 —— 那一刀就是真的那一刀。

## 已知边界

- **需要 DSH `0.2.0-rc.2` 或更新的版本** —— 这是本插件的开发与验证版本，也是它声称能用的最低版本。这个要求在 `package.json` 里以 `peerDependencies` 声明（`@deepseek-ai/dsh-host-webserver` 是注册路由所需，`@deepseek-ai/dsh-client-ui-slots` 是按钮挂载所需的底部槽位）。DSH 在导入插件前会核对——所以旧版本会**明确拒绝安装并给出原因**，而不是装上一个画不出来的按钮。

  需要说明的是：这个下限是"在哪个版本上测过"的陈述，**不是**对每个更早构建内部缺了哪个 API 的断言——那些版本我手上没有，无法核对。真正被验证过的是范围本身：我把 DSH 自己那行判定逻辑拿真实的 `semver` 7.8.5 复现跑过，下表每一行都是**跑出来的结果**，不是读代码推断的。

  范围写的是 `^0.2.0-rc.2`（即 `>=0.2.0-rc.2 <0.3.0`），DSH 用 `semver.satisfies(运行时版本, 范围, { includePrerelease: true })` 判定。实测结果：`0.2.0-rc.1` **装不上**，`0.2.0-rc.2` 正常，后续的 `0.2.0-rc.3` / `0.2.0` / `0.2.1` 都可以，`0.3.0` 会因上界被挡下（新的次版本需要重新确认）。被挡下不是崩溃：只会有一行说明是哪个插件、哪个版本、哪个 peer 不匹配；确实想装可以用 `dsh plugin allow-version` 显式豁免。
- **只支持 Windows 桌面版。** 判断依据是 Host 与 Electron 之间有没有 IPC 通道（`process.connected`）。命令行跑的 `dsh web` 没有这条通道，按钮会拒绝执行并说明原因——在那里"杀掉父进程"等于杀掉你的终端。
- **重启会中断正在跑的任务。** 这是强杀，没有优雅退出：所以按钮要点两下，第二下才是真的。
- **第一次装完需要手动重启一次 DSH。** 补丁层会热加载，但**运行中的进程持有旧的 `entry.js`**——Node 的 ESM 缓存不带 cache-busting，重新挂载同一个包名拿到的还是旧模块。这一次之后按钮才真正生效。
- 助手目录 `%DSH_HOME%\restart-helper\` 会留下 `config.json` 和 `relaunch.log`。日志是重启出问题时唯一的现场记录，卸载脚本刻意不删它。
