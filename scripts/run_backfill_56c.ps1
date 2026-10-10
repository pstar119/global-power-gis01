# 阶段56-C：其余 11 个区域的面层补齐（脱离会话运行）
#
# ‼️ 为什么要脱离会话：harness 的后台作业句柄**不跨轮次存活**，会话上下文一重置
#    进程就没了（本阶段已实测踩到一次：跑到 9/64 被杀）。所以这里用 Start-Process
#    起一个独立进程，日志全部落盘，靠文件看进度。
#
# 用法（只需一次）：pwsh -File scripts/run_backfill_56c.ps1
#
# ⚠️ 顺序不能改：先把三个批次跑完（每批内部 fetch→prepare→build 由 run_pipeline 负责，
#    并且它自己会在抓取不完整时拒绝出包），最后才合并/重建核心区归档。
#    核心区的输入是 yrd + zhejiang，两者都属于 huadong ⇒ 必须在第一批跑完之后。

$ErrorActionPreference = "Continue"
$root = "J:\Projects\global-power-gis"
Set-Location $root

$logDir = Join-Path $root "data"
function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Write-Host $line
  Add-Content -Path (Join-Path $logDir "_c_t1_backfill.log") -Value $line -Encoding utf8
}

# ---- 子进程登记（本项目的明文规矩：脱离进程运行时，把自己启动的 PID 记进文件）----
# 为什么需要：编排进程依次起 python / node 子进程，"现在卡在哪一步"光看编排进程看不出来。
# 这里**不改调用方式**（改成 Start-Process -Wait 要重写所有调用点，而这段逻辑只有真跑
# 几小时才验证得到 —— 为了可观测性去动主流程不划算）。改成：每步前后写一条记录，
# 同时把那一刻的 python/node 子进程 PID 抄下来，status_56c.ps1 与停机时都能用。
$chainPath = Join-Path $logDir "_jobs_chain.json"
function Note-Step([string]$name, [string]$status) {
  $kids = @()
  foreach ($n in @('python.exe','node.exe')) {
    $kids += (Get-CimInstance Win32_Process -Filter "Name='$n'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*backfill_plant_areas*' -or $_.CommandLine -like '*merge_osm_regions*' -or $_.CommandLine -like '*prepare_osm_geojson*' -or $_.CommandLine -like '*build_pmtiles*' -or $_.CommandLine -like '*rebuild_and_verify_56c*' -or $_.CommandLine -like '*gen_packs_manifest*' } |
      ForEach-Object { [pscustomobject]@{ name=$n; pid=$_.ProcessId; cmd=($_.CommandLine.Substring(0,[Math]::Min(120,$_.CommandLine.Length))) } })
  }
  $entry = [pscustomobject]@{ step=$name; status=$status; at=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss"); children=$kids }
  Add-Content -Path $chainPath -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
}

Log "=== 阶段56-C 面层补齐开始 ==="

# ‼️ 用**定向补面层**脚本，不要用 run_pipeline 重抓整个区域（2026-09-26 实测）：
#    `run_pipeline` 为"没有完整覆盖标记"的桶会重抓该区域**全部块**，而每块的 power 查询
#    含 `way[power=line]`（华东一块 2000+ 条几何）—— 那正是把 Overpass 打到 504 的请求，
#    实测 1 块 ≈ 4 分钟 ⇒ 934 块要 60 小时以上。
#    而 lines/substations/plants 在上一轮**本来就是完整的**（已打覆盖标记），
#    缺的只有 plant_areas，它的查询极小（一块几十条）⇒ 实测 **36 秒/块**，约 9.3 小时。
#    ⇒ 只补缺的那一层，不重抓已有的三层。
# ‼️ regions 直接字面量，不用变量（2026-09-26 实测：写成变量时在 pwsh -File 下**传成了空**，
#    脚本报 "argument --regions: expected one argument" 并以 exit=2 退出，而外层没查退出码 ⇒
#    接着跑核心区重建、还成功覆盖了归档。这次把字面量写死并逐步校验退出码。）
Log "--- 定向补面层开始 ---"

# 少一个区域缺面层就绝不出包。用**覆盖标记**判断（不是"文件非空"——
# 被中断的抓取会留下非空的部分文件，本阶段已实测踩过）。
function Get-MissingArea($regions) {
  $miss = @()
  foreach ($r in $regions) {
    if (-not (Test-Path "data/osm/${r}_power_plant_areas.geojson")) { $miss += $r; continue }
    $marker = "data/osm/${r}_bucket_coverage.json"
    $has = $false
    if (Test-Path $marker) {
      $j = Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.buckets.PSObject.Properties.Name -contains 'plant_areas') { $has = $true }
    }
    if (-not $has) { $miss += $r }
  }
  return $miss
}

$allRegions = @("huadong","huazhong","huanan","huabei","dongbei","xinan","xibei",
                "mn","sea-mainland","ca","ru-far","yrd","zhejiang")

# 🔁 补面层重试：Overpass 会瞬时 504 ⇒ 失败块拿不到覆盖标记。每轮只补还没标记的区域
#   （脚本内部会跳过已完成的），最多 6 轮。这样"失败即止"仍然成立，但不会因为
#   一轮瞬时故障就让整条链整晚停在这里。
$maxRounds = 6
for ($round = 1; $round -le $maxRounds; $round++) {
  $missing = Get-MissingArea $allRegions
  if ($missing.Count -eq 0) { Log "所有 13 个区域的面层都已标记完整覆盖"; break }
  Log ("第 {0}/{1} 轮：待补 {2} 个区域 -> {3}" -f $round, $maxRounds, $missing.Count, ($missing -join ","))
  $arg = ($missing -join ",")
  Note-Step "backfill-r$round" "start:$arg"
  python -u scripts/backfill_plant_areas.py --regions $arg *>> (Join-Path $logDir "_c_backfill_all.txt")
  Log ("第 {0} 轮 exit={1}" -f $round, $LASTEXITCODE)
  Note-Step "backfill-r$round" ("exit:" + $LASTEXITCODE)
}

$missing = Get-MissingArea $allRegions
if ($missing.Count -gt 0) {
  Log ("❌ 补面层未成功，仍缺：" + ($missing -join ", "))
  Log "   ⇒ **跳过核心区与区域包重建**，绝不用残缺数据切包/覆盖已交付归档。"
  Log "   排查：data/_c_backfill_all.txt（Overpass 是否长期不可用？重跑本脚本会继续续补）"
  exit 1
}

# ---- 核心区归档重建（必须在 yrd/zhejiang 补完之后）----
foreach ($need in @("yrd","zhejiang")) {
  if (-not (Test-Path "data/osm/${need}_power_plant_areas.geojson")) {
    Log "❌ 核心区输入缺失：${need}_power_plant_areas.geojson ⇒ 停止（merge 一定会失败）"
    exit 1
  }
}
Log "=== 核心区归档重建开始 ==="
Note-Step "core-merge" "start"
node scripts/merge_osm_regions.mjs --name core --inputs yrd,zhejiang *>> (Join-Path $logDir "_c_t1_core.txt")
$code = $LASTEXITCODE
Log ("merge exit={0}" -f $code)
Note-Step "core-merge" ("exit:$code")
if ($code -ne 0) {
  Log "❌ 核心区合并失败（exit=$code）⇒ 停止，不覆盖 osm_grid.pmtiles。"
  Log "   常见原因：yrd/zhejiang 缺 _power_plant_areas.geojson（说明补面层没跑到它们）。"
  exit 1
}

Note-Step "core-prepare" "start"
node scripts/prepare_osm_geojson.mjs --name core --out-dir public/osm --out-name core_power *>> (Join-Path $logDir "_c_t1_core.txt")
$code = $LASTEXITCODE
Log ("prepare exit={0}" -f $code)
Note-Step "core-prepare" ("exit:$code")
if ($code -ne 0) { Log "❌ prepare 失败 ⇒ 不覆盖归档"; exit 1 }

Note-Step "core-build" "start"
node scripts/build_pmtiles.mjs --kind osm --name core `
    --in public/osm/core_power.geojson `
    --out src-tauri/resources/maps/osm_grid.pmtiles *>> (Join-Path $logDir "_c_t1_core.txt")
$code = $LASTEXITCODE
Log ("build exit={0}" -f $code)
Note-Step "core-build" ("exit:$code")
if ($code -ne 0) { Log "❌ build 失败"; exit 1 }

Log "=== 核心区归档已重建。下一步：重建 12 个区域包 + 门禁（自动接上）==="

# 区域包也要重建：现有 12 个包是在 plant_area 存在**之前**切的，里面没有面层。
# 只补数据不重切包 ⇒ 地图上仍然看不到面（而且 verify_pack 的新断言会红）。
# 用独立脚本跑，靠**退出码**判断成败（不能看输出里有没有"通过"字样）。
powershell -NoProfile -File scripts/rebuild_and_verify_56c.ps1
$code = $LASTEXITCODE
Log ("rebuild+verify exit={0}" -f $code)
Note-Step "rebuild-verify" ("exit:$code")
if ($code -ne 0) { Log "❌ 区域包重建/门禁未全过 ⇒ 停止（不要上传）"; exit 1 }

# 清单最后更新：它引用每个包的 sha256/体积，必须在包全部重建**之后**跑。
Note-Step "manifest" "start"
node scripts/gen_packs_manifest.mjs *>> (Join-Path $logDir "_c_t1_core.txt")
$code = $LASTEXITCODE
Log ("gen_packs_manifest exit={0}" -f $code)
if ($code -ne 0) { Log "❌ 清单生成失败"; exit 1 }

Log "=== 全部结束（面层 + 核心区 + 12 包 + 门禁 + 清单）==="
Log "剩余（需用户明确确认）：node scripts/upload_packs.mjs --yes，然后 verify_packs.mjs --remote"
