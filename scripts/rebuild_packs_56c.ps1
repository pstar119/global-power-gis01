# 阶段56-C：只做 prepare + build，重建 12 个区域包（**不抓取**）
#
#   powershell -File scripts\rebuild_packs_56c.ps1
#
# 为什么需要它：现有 12 个区域包是在 plant_area 存在**之前**切的，
# 所以它们里面没有面层 —— 单靠 `run_pipeline` 补面层不会更新包，
# 而重跑整条 pipeline 会触发 fetch（即使有覆盖标记，仍会发大量请求、且很慢）。
# 本脚本只跑本地的两步，参数与 `run_pipeline.mjs:489/510-519` **逐字一致**：
#   prepare : --name <r> --out-dir public/osm --out-name <r>_power
#   build   : --name <r> --in public/osm/<r>_power.geojson --out data/packs/osm-<r>.pmtiles
#             --max-features-per-tile 20000 --cap-below-zoom 8
#
# ⚠️ 必须 **逐区域循环**，不能用 `--name` 逐个合并成一次：每个区域的产物名不同。
# ⚠️ prepare 依赖 `data/osm/<r>_power_plant_areas.geojson` 存在；缺失则跳过并报错
#    （绝不静默切一个没有面层的包）。

$ErrorActionPreference = "Continue"
Set-Location "J:\Projects\global-power-gis"

$regions = @(
  "huadong","huazhong","huanan","huabei","dongbei","xinan","xibei",
  "mn","sea-mainland","ca","ru-far","kp-kr"
)

$log = "data/_c_rebuild_packs.log"
function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

Log "=== 重建 12 个区域包（prepare+build，不抓取）==="
$fail = 0
foreach ($r in $regions) {
  $in = "data/osm/${r}_power_plant_areas.geojson"
  if (-not (Test-Path $in)) {
    Log "[$r] 跳过：缺少 $in（面层没补完，绝不切一个没有面层的包）"
    $fail++
    continue
  }

  Log "[$r] prepare ..."
  node scripts/prepare_osm_geojson.mjs --name $r --out-dir public/osm --out-name "${r}_power" *>> "data/_c_rebuild_${r}.log"
  if ($LASTEXITCODE -ne 0) { Log "[$r] prepare 失败 exit=$LASTEXITCODE"; $fail++; continue }

  Log "[$r] build ..."
  node scripts/build_pmtiles.mjs --name $r `
      --in "public/osm/${r}_power.geojson" `
      --out "data/packs/osm-${r}.pmtiles" `
      --max-features-per-tile 20000 --cap-below-zoom 8 *>> "data/_c_rebuild_${r}.log"
  if ($LASTEXITCODE -ne 0) { Log "[$r] build 失败 exit=$LASTEXITCODE"; $fail++; continue }

  $sz = [math]::Round((Get-Item "data/packs/osm-${r}.pmtiles").Length / 1MB, 2)
  Log "[$r] 完成  ${sz} MB"
}

if ($fail -eq 0) {
  Log "=== 12 个区域包全部重建完成 ==="
} else {
  Log "=== 有 $fail 个区域未完成（见上面日志）—— 不要继续后续步骤 ==="
  exit 1
}
