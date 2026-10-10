# 阶段56-C：重建 12 个区域包 → 跑三道门禁（串起来，可无人值守）
#
#   powershell -File scripts\rebuild_and_verify_56c.ps1
#
# 为什么要有它：补面层要跑几小时，而 AI 的会话/后台作业**不保证一直在**。
# 把"重建 + 门禁"做成一个脚本，抓取一结束就能自动接上，不必等人回来点。
#
# ⚠️ 失败即止：任一区域 prepare/build 失败就**不继续**（避免切出半成品包还去上传）。
# ⚠️ 门禁判据用的是**退出码**，不是输出里有没有"通过"字样。

$ErrorActionPreference = "Continue"
Set-Location "J:\Projects\global-power-gis"

$regions = @(
  "huadong","huazhong","huanan","huabei","dongbei","xinan","xibei",
  "mn","sea-mainland","ca","ru-far","kp-kr"
)

$log = "data/_c_rebuild_verify.log"
function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

Log "=== 阶段56-C：重建 12 个区域包 + 门禁 ==="

# ---------- 0) 前置校验：**所有**输入先检查一遍 ----------
# ‼️ 为什么要有这一步：原来是在循环里逐个检查，结果前 5 个区域已经白重建了
#    （37.9 s）才发现第 6 个（xinan）没有面层产物 —— 每次试跑都白做一遍重活。
#    先全量检查，缺一个就 <1s 退出。
$missing = @()
foreach ($r in $regions) {
  if (-not (Test-Path "data/osm/${r}_power_plant_areas.geojson")) { $missing += $r }
}
if ($missing.Count -gt 0) {
  Log ("缺少面层产物的区域（" + $missing.Count + " 个）：" + ($missing -join ", "))
  Log "⇒ 立即停止。绝不用残缺数据切包；等 backfill_plant_areas.py 把面层补齐后重跑本脚本。"
  exit 1
}
Log "前置校验通过：12 个区域的面层产物都在。"

# ---------- 1) 重建 ----------
$built = @()
foreach ($r in $regions) {
  node scripts/prepare_osm_geojson.mjs --name $r --out-dir public/osm --out-name "${r}_power" *>> "data/_c_rebuild_${r}.log"
  if ($LASTEXITCODE -ne 0) { Log "[$r] prepare 失败 exit=$LASTEXITCODE"; exit 1 }
  node scripts/build_pmtiles.mjs --name $r --in "public/osm/${r}_power.geojson" `
      --out "data/packs/osm-${r}.pmtiles" `
      --max-features-per-tile 20000 --cap-below-zoom 8 *>> "data/_c_rebuild_${r}.log"
  if ($LASTEXITCODE -ne 0) { Log "[$r] build 失败 exit=$LASTEXITCODE"; exit 1 }
  $sz = [math]::Round((Get-Item "data/packs/osm-${r}.pmtiles").Length / 1MB, 2)
  Log "[$r] 重建完成 ${sz} MB"
  $built += $r
}

# ---------- 2) 门禁 ----------
$fails = @()
foreach ($r in $built) {
  # (a) 中间产物 geojson（按 ftype 判定）
  node scripts/verify_power_only.mjs "data/osm/${r}_power_plant_areas.geojson" *>> "data/_c_gate_${r}.log"
  if ($LASTEXITCODE -ne 0) { $fails += "$r/areas-geojson"; Log "[$r] 门禁 a 失败" }
  # (b) prepare 产物 geojson（含全部 ftype，线字段最全）
  node scripts/verify_power_only.mjs "public/osm/${r}_power.geojson" *>> "data/_c_gate_${r}.log"
  if ($LASTEXITCODE -ne 0) { $fails += "$r/prepared-geojson"; Log "[$r] 门禁 b 失败" }
  # (c) 归档门禁（含新增的 plant_area 断言）
  node scripts/verify_pack.mjs "data/packs/osm-${r}.pmtiles" *>> "data/_c_gate_${r}.log"
  if ($LASTEXITCODE -ne 0) { $fails += "$r/pack"; Log "[$r] 门禁 c 失败" }
  if (-not ($fails -match "^$r/")) { Log "[$r] 三道门禁全过" }
}

if ($fails.Count -eq 0) {
  Log "=== 12 个区域包：重建 + 三道门禁 全部通过 ==="
  Log "下一步（需人工）：node scripts/gen_packs_manifest.mjs；上传需用户确认。"
} else {
  Log ("=== 有门禁未过：" + ($fails -join ", "))
  exit 1
}
