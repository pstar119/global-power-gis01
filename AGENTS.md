# AGENTS.md — global-power-gis

## 绝对禁止：在这个会话里批量结束 `node.exe` / `powershell`

**DSH Harness 自己就是一个 `node.exe`。** 在会话内批量结束 `node` 进程，会连带杀掉正在运行你的那个
Harness，表现是：会话瞬间断开、桌面端弹出修复页并提示

```
Harness stopped unexpectedly (exit code 4294967295 (0xFFFFFFFF))
```

随后整台应用进入安全模式，正在跑的工作全部中断。

这不是假设：本项目已因此连续翻车两次（2026-09-26 20:13:56 与 20:15:25，两次都是正常的 web profile
启动被本项目自己的会话打断；两次都是在 `Stop-Process -Force` 之后约 1 秒，Harness 进程消失）。

### 不要这样写（一次都不要）

```powershell
Get-Process node,powershell -ErrorAction SilentlyContinue | Stop-Process -Force   # 连 Harness 一起杀
foreach($id in @(1234,5678)){ Stop-Process -Id $id -Force }                       # PID 列表里可能就有 Harness
taskkill /F /IM node.exe                                                          # 同上
```

坑在于：`Get-Process node` 的输出里既有后台抓取进程，也有 Harness。把 PID 抄进一个硬编码列表再
逐个杀，就是直接杀 Harness——2026-09-26 那次列表里的 PID 正是当次 Harness 的 PID。

### 要清理后台抓取进程时，按命令行精确匹配

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*run_pipeline.mjs*' -or $_.CommandLine -like '*fetch_osm_power*' } |
  ForEach-Object { Write-Host "kill PID $($_.ProcessId) :: $($_.CommandLine)"; Stop-Process -Id $_.ProcessId -Force }
```

先打印命中的 PID **和命令行**，确认目标是自己启动的抓取脚本，再杀；只杀单个已确认的 PID。

### 更稳的做法

- 长任务优先交给自己的后台作业工具（`job_list` / `job_output` / `job_kill`）管理，不要用
  `Start-Process` 把进程甩出去、之后再靠"杀残留"收尾。
- 确实需要脱离进程运行时，把自己启动的 PID 记进一个自己管理的文件（例如 `data/_jobs.json`），
  之后只按这个文件里的 PID 停进程。

### 看到 `0xFFFFFFFF` 怎么判断

`exit code 4294967295 (0xFFFFFFFF)` 就是 `-1`，是 Windows `TerminateProcess(h, -1)` 的退出码，
也正是 PowerShell `Stop-Process -Force`（.NET `Process.Kill()`）留下的签名。

**看到它基本可以断定"进程是被杀的，不是自己崩的"**，而且不会有崩溃转储、也不会有 WER 事件记录。
排查方向是：谁执行了 `Stop-Process` / `taskkill`，而不是去翻插件和配置。

## 构建产物必须复制出项目树再运行（Low 完整性标签）

`J:\Projects\global-power-gis` 整棵树被 DSH 沙箱**常驻**打了 Windows **Low 完整性强制标签**
（mandatory label + 能力 SID 的允许 ACE）。Windows 按 **exe 文件自带的标签**决定进程的完整性级别，
所以在这棵树里构建出来的 `src-tauri\target\release\bundle\nsis\*.exe` 与
`src-tauri\target\release\global-power-gis.exe` 都以 **Low IL** 启动，写不进 `K:\`、`%APPDATA%`、
`HKCU`、桌面（Medium 及以上）——实测症状：

- NSIS 安装报 `无法打开要写入的文件: "K:\Global Power GIS\global-power-gis.exe"`（`File` 那一步）；
- 直接从树里跑 release exe，应用写不了 `%APPDATA%\com.pstar119.globalpowergis\` 的数据库与 packs 目录。

**规矩：构建完先导出，再从树外运行/安装。**

```powershell
& 'D:\Node,js\node.exe' scripts/export-release.mjs            # 最新 NSIS 包 → 桌面
& 'D:\Node,js\node.exe' scripts/export-release.mjs K:\Installers
& 'D:\Node,js\node.exe' scripts/export-release.mjs --exe       # 连 release exe 一起导出
```

复制不会带走源文件的强制标签，新文件继承目标目录的标签，所以树外那份一定是干净的
（脚本会自己用 `icacls` 复核并打印 sha256）。

标签是 DSH 沙箱按设计常驻的——它的文档写明「工作区 ACE、拒绝项与标签按设计常驻（复用缓存，
绝不撤销）」，且**手工 `icacls` 清理会以 `ERROR_NONE_MAPPED`（1332）失败**，所以不要试图去掉它；
要么用 DSH 自己的回收路径，要么就按上面的导出流程走。

## 环境速查与省时节奏（别再每次重新试错）

### 一条命令的入口：`scripts/dev/*.mjs`（不要裸用 `npm` / PowerShell）

```powershell
& 'D:\Node,js\node.exe' scripts/dev/verify.mjs         # 快路径：类型检查 ×2 + 单元测试（约 3 秒）
& 'D:\Node,js\node.exe' scripts/dev/verify.mjs --rust  # 再加上 cargo check / clippy -D warnings / test（分钟级）
& 'D:\Node,js\node.exe' scripts/dev/test.mjs           # 只跑 scripts/**/*.test.mjs
& 'D:\Node,js\node.exe' scripts/dev/package.mjs        # 打包（tauri build）并自动导出到项目树外
```

也可以用 npm 脚本：`npm run verify` / `npm run verify:rust` / `npm run test` / `npm run package`。

### 工具链绝对路径（都不在 PATH 该在的位置）

| 工具 | 路径 / 用法 |
| --- | --- |
| node / npm | `D:\Node,js\node.exe` / `D:\Node,js\npm.cmd` |
| cargo | `%USERPROFILE%\.cargo\bin\cargo.exe`（**不在 PATH**） |
| git | `D:\Git\cmd\git.exe`，对本仓库必须加 `-c safe.directory=J:/Projects/global-power-gis` |
| python | `D:\pyrhon3.12\python.exe`（没有 `sqlite3` 命令） |

### 为什么不能直接 `npm run tauri build`（node 垫片）

DSH Harness 启动时把 `%APPDATA%\dsh-desktop\harness\.desktop-bin`（内含 `node.cmd` / `pnpm.cmd`，
指向 `F:\DSH Desktop\DSH Desktop.exe`）**动态前置**到进程 PATH 的第一项，实测顺序是
`[垫片, F:\DSH Desktop] + Machine PATH + USER PATH`。于是 `node_modules/.bin/tauri.cmd` 解析到的
`node` 是 Electron 主程序，报错：

```text
error: unrecognized subcommand 'F:\DSH Desktop\DSH Desktop.exe'
```

- 临时解法：`$env:PATH = 'D:\Node,js;' + $env:PATH`，再 `& 'D:\Node,js\npm.cmd' run tauri build`。
- **改 Machine / USER PATH 没用**（垫片是运行时前置的）——`scripts/dev/env.mjs` 的 `childEnv()`
  在 spawn 之前把真 node 目录放到**子进程** PATH 第一位，这才是正解。

### PowerShell 5.1 的坑（能少用就少用）

- **不要写裸的 `--- 标题 ---` 当分隔行**：会被当命令解析，ParserError 让**整段脚本一行都不执行**。
- 读退出码不要走管道：`cmd | Select-Object -Last 5` 之后 `$LASTEXITCODE` 已经不是 cmd 的了；
  要么重定向到文件再读，要么用 `scripts/dev/*.mjs`（node 里拿得到真实退出码）。
- `.ps1` 被执行策略拦：用 `iex (Get-Content -Raw '<path>')` 绕；`-Raw` 默认按 ANSI 解码，中文要 `-Encoding UTF8`。
- 控制台按 GBK 解码 node 的 UTF-8 输出 ⇒ 中文乱码。**`scripts/dev/*.mjs` 的控制台标签一律 ASCII**，
  就是为了这个。

### 时间预算（实测）

| 动作 | 实测耗时 | 什么时候做 |
| --- | --- | --- |
| `scripts/dev/verify.mjs`（快路径） | ~3 秒 | 每次改完代码 |
| `cargo check` / `clippy` | 数秒~1 分钟 | 改 Rust 时 |
| `cargo build --release`（纯重新链接） | 分钟级 | **只在要出包时** |
| `npm run tauri build`（前端 + Rust + NSIS） | 约 3~5 分钟 | 出安装包时，一次跑完 |

⇒ 节奏固定为「改代码 → `verify.mjs` → 攒够一批 → `package.mjs` 一次出包」，不要改一行打一次包。

### 加依赖前先读要求（血泪）

`cargo add tauri-plugin-single-instance` 看似无害，但它最新版清单写着 `tauri = "2.12"`，
一解析就把整个 tauri 栈从 2.11.5 顶到 2.12.3（Cargo.lock 87 行 version 变动，连 wry 一起换）。
**规矩**：先看目标 crate 的 `[dependencies.<核心库>] version`，再用 `=x.y.z` 精确锁；上例最终锁成
`tauri-plugin-single-instance = "=2.4.0"`，Cargo.lock 只多 16 行。
