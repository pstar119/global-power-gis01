/**
 * 阶段56-A1：断言"只有电力"。
 *
 * 为什么必须是脚本而不是肉眼：本次要删掉两类已发布数据（铁路、油气管道），
 * 而"删干净了没有"有两个易漏点 —— ① prepare 的合并表、② 切片的图层/属性白名单。
 * 只看一处会留下一半，且**不会报错**（图层里没有要素，只是什么都不画）。
 *
 * 检查职责（**不要过度声称**）：
 *   · `<file>.geojson` —— 权威内容检查：无 railway/pipeline 的 ftype + 电力属性齐备
 *   · `<file>.pmtiles` —— 结构检查：可读回、非空、含预期 MVT 图层名 `grid`
 *     （归档内所有 ftype 同在 `grid` 一层，图层名抓不到铁路/管道；内容由 GeoJSON 门禁保证）
 *
 * 用法：node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>
 * 退出码：0 = 通过；1 = 发现问题；2 = 用法错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyArchive, tileX, tileY, zxyToTileId } from "./lib/pmtiles-writer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_FTYPES = ["railway", "pipeline"];
/**
 * 线路必须出现的字段。
 *
 * 阶段56-A2 新增两项：
 *   · `is_dc` —— prepare 的三步判定结果，**每条线路都有**（true/false 都写），必须齐备；
 *   · `frequency` —— 只在补抓跑过、且该区域确有频率标签时才会出现（实测全国覆盖 ~11%）。
 *     ‼️ 所以它是否进入必查清单**取决于同区域的 `dc_tags` 产物是否存在且非空** ——
 *     写死会让"没跑补抓"与"跑了但这条真没有"两种情况的症状混在一起（假失败）。
 */
const EXPECTED_LINE_PROPS = [
  "osm_id",
  "name",
  "ref",
  "operator",
  "vclass",
  "voltage_kv",
  "line_kind",
  "circuits",
  "cables",
  "wires",
  "is_dc",
];
const DC_DEPENDENT_PROPS = ["frequency"];

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>");
  process.exitCode = 2;
} else {
  const ext = extname(path).toLowerCase();
  const ftypes = new Map();
  /**
   * `frequency` 是否列入必查 —— 依据是**同区域的 dc_tags 产物存在且非空**（A2 的补抓跑过没有）。
   * 名字从文件名推：`<name>_power.geojson` / `osm-<name>.pmtiles`；核心区归档 `osm_grid.pmtiles`
   * 对应的名字是 `core`（它的 dc_tags 由 `merge_osm_regions.mjs` 合并产出）。
   */
  const stem = basename(path).replace(/\.(geojson|pmtiles)$/i, "");
  const dcName = stem === "osm_grid" ? "core" : stem.replace(/^osm-/, "").replace(/_power$/, "");
  const dcPath = resolve(ROOT, "data", "osm", `${dcName}_dc_tags.json`);
  let dcSource = false;
  try {
    dcSource = existsSync(dcPath) && (JSON.parse(readFileSync(dcPath, "utf8")).count ?? 0) > 0;
  } catch {
    dcSource = false;
  }
  const propHits = new Map(
    [...EXPECTED_LINE_PROPS, ...(dcSource ? DC_DEPENDENT_PROPS : [])].map((k) => [k, 0]),
  );
  let lineTotal = 0;
  let pass = false;
  let extra = "";

  if (ext === ".geojson") {
    const fc = JSON.parse(readFileSync(path, "utf8"));
    for (const f of fc.features ?? []) {
      const p = f.properties ?? {};
      const t = p.ftype ?? "(none)";
      ftypes.set(t, (ftypes.get(t) ?? 0) + 1);
      if (t === "line") {
        lineTotal++;
        for (const k of EXPECTED_LINE_PROPS) if (p[k] !== undefined) propHits.set(k, propHits.get(k) + 1);
        for (const k of DC_DEPENDENT_PROPS) if (p[k] !== undefined) propHits.set(k, propHits.get(k) + 1);
      }
    }
    const bad = [...ftypes.keys()].filter((k) => FORBIDDEN_FTYPES.includes(k));
    const missing = [...propHits.keys()].filter((k) => propHits.get(k) === 0);
    console.log(`forbidden ftypes: ${bad.length ? bad.join(", ") : "(none)"}`);
    console.log(
      `prop coverage: lines=${lineTotal} missing=${missing.length ? missing.join(",") : "(none)"}` +
        `${dcSource ? "" : `（frequency 未列入必查：找不到 ${dcPath}）`}`,
    );
    pass = bad.length === 0 && missing.length === 0;
  } else if (ext === ".pmtiles") {
    // 从归档 bbox 推 z6/z8 的若干 tileId 抽样；verifyArchive 内部用 MemorySource，Node 下可用
    const headerBuf = readFileSync(path).subarray(0, 127);
    const minLon = headerBuf.readInt32LE(102) / 1e7;
    const minLat = headerBuf.readInt32LE(106) / 1e7;
    const maxLon = headerBuf.readInt32LE(110) / 1e7;
    const maxLat = headerBuf.readInt32LE(114) / 1e7;
    const sampleIds = [];
    for (const z of [6, 8]) {
      for (let x = tileX(minLon, z); x <= tileX(maxLon, z) && sampleIds.length < 40; x += 2) {
        for (let y = tileY(maxLat, z); y <= tileY(minLat, z) && sampleIds.length < 40; y += 2) {
          sampleIds.push(zxyToTileId(z, x, y));
        }
      }
    }
    const r = await verifyArchive(path, { sampleIds, layerNames: ["grid"] });
    const withGrid = r.checked.filter((c) => c.layers.includes("grid")).length;
    console.log(`forbidden ftypes: (n/a for archive — 内容由对应的 geojson 检查)`);
    console.log(
      `archive: readback ok=${r.ok} missing=${r.missing} gridTiles=${withGrid} z${r.header.minZoom}-${r.header.maxZoom}`,
    );
    pass = r.ok > 0 && withGrid > 0;
    extra = "（归档结论以结构可读 + 含 grid 层为准）";
  } else {
    console.error(`不支持的扩展名: ${ext}`);
    process.exitCode = 2;
  }

  if (!process.exitCode) {
    console.log(`verdict: ${pass ? "PASS" : "FAIL"}${extra}`);
    if (!pass) process.exitCode = 1;
  }
}
