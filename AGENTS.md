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
