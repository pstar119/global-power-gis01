# 阶段56-C 进度快照（只读，随时可跑）
#
#   powershell -File scripts\status_56c.ps1
#
# ⚠️ 本机是 Windows PowerShell 5.1（没有 pwsh），所以上面写 `powershell` 而不是 `pwsh`。
#    本文件必须存成 **UTF-8 with BOM**：PS 5.1 对无 BOM 的 UTF-8 会按 ANSI 解析，
#    中文注释会把引号配错、直接报语法错（本阶段已实测踩到）。
#
# 为什么要有它：抓取要跑几小时，而我（AI）的会话/后台作业**不保证一直在**。
# 这个脚本只读本地文件，不联网、不改任何东西，所以任何时候跑都安全。

$ErrorActionPreference = "Continue"
Set-Location "J:\Projects\global-power-gis"

# 让中文在控制台正确显示（PS 5.1 默认走 GBK 代码页，中文/符号会变问号）。
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }
# Python 子进程的输出也按 UTF-8 解（否则中文全变 ??）
$env:PYTHONIOENCODING = "utf-8"

Write-Host "=== 阶段56-C 进度快照  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan

# ---- 1. 进程是否还在跑 ----
$rec = Get-Content data/_jobs.json -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
if ($rec) {
  $alive = (Get-Process -Id $rec.pid -ErrorAction SilentlyContinue) -ne $null
  Write-Host ("`n[编排进程] PID={0} 启动={1} 存活={2}" -f $rec.pid, $rec.started, $alive)
}
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
      Where-Object { $_.CommandLine -like '*backfill_plant_areas*' }
if ($py) { Write-Host ("[抓取子进程] PID={0} 运行中" -f $py.ProcessId) }
else { Write-Host "[抓取子进程] 未在运行（可能已完成或已停止）" }

# ---- 2. 各区域面层状态（读覆盖标记 + 产物）----
Write-Host "`n[各区域面层]" -ForegroundColor Cyan
$py2 = @'
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location('f','scripts/fetch_osm_power.py')
m = importlib.util.module_from_spec(spec); sys.modules['f']=m; spec.loader.exec_module(m)
order = ['huadong','huazhong','huanan','huabei','dongbei','xinan','xibei',
         'mn','sea-mainland','ca','ru-far','yrd','zhejiang','kp-kr']
tot=0; done=0
for r in order:
    cov = m.load_bucket_coverage('data/osm', r)
    marked = 'plant_areas' in cov
    n = m.count_features_in(m.geom_path('data/osm', r, 'power', 'plant_areas'))
    n = max(n, 0)
    if marked: done += 1
    tot += n
    print('  %-14s %-6s %6d 个面' % (r, '完成' if marked else '待补', n))
print('  ---- 已完成区域 %d/14，面要素合计 %d' % (done, tot))
'@
$py2 | python -
Write-Host "`n[当前阶段]" -ForegroundColor Cyan
$c = Get-Content data/_c_backfill_all.txt -Encoding UTF8 -ErrorAction SilentlyContinue
if ($c) {
  $cur = $c | Select-String -Pattern "^=== 回填面层" | Select-Object -Last 1
  Write-Host ("  正在处理：{0}" -f $cur)
  $last = $c | Select-String -Pattern "^\[\d+/\d+\]" | Select-Object -Last 1
  Write-Host ("  最新块：{0}" -f $last)
} else { Write-Host "  (还没有抓取日志)" }

# 编排链：能让"现在卡在哪一步"一目了然（见 run_backfill_56c.ps1 的 Note-Step）
$chain = "data/_jobs_chain.json"
if (Test-Path $chain) {
  Write-Host "`n[编排链 最近 6 条]" -ForegroundColor Cyan
  Get-Content $chain -Encoding UTF8 | Select-Object -Last 6 | ForEach-Object {
    try {
      $e = $_ | ConvertFrom-Json
      $kids = ($e.children | ForEach-Object { "$($_.name)#$($_.pid)" }) -join " "
      Write-Host ("  {0}  {1,-14} {2}  {3}" -f $e.at, $e.step, $e.status, $kids)
    } catch { Write-Host ("  " + $_) }
  }
}

# ---- 3. 核心区归档 & 失败即止状态 ----
Write-Host "`n[核心区归档]" -ForegroundColor Cyan
$arch = Get-Item src-tauri/resources/maps/osm_grid.pmtiles -ErrorAction SilentlyContinue
if ($arch) {
  Write-Host ("  {0} 字节  改动时间 {1}" -f $arch.Length, $arch.LastWriteTime)
  Write-Host "  （7,465,373 = 旧版无面层；重建后会变大）"
}
Write-Host "`n[编排日志尾部]" -ForegroundColor Cyan
Get-Content data/_c_t1_backfill.log -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 4
