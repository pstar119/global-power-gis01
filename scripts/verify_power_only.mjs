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
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { verifyArchive, tileX, tileY, zxyToTileId } from "./lib/pmtiles-writer.mjs";

const FORBIDDEN_FTYPES = ["railway", "pipeline"];
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
];

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>");
  process.exitCode = 2;
} else {
  const ext = extname(path).toLowerCase();
  const ftypes = new Map();
  const propHits = new Map(EXPECTED_LINE_PROPS.map((k) => [k, 0]));
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
      }
    }
    const bad = [...ftypes.keys()].filter((k) => FORBIDDEN_FTYPES.includes(k));
    const missing = [...propHits.keys()].filter((k) => propHits.get(k) === 0);
    console.log(`forbidden ftypes: ${bad.length ? bad.join(", ") : "(none)"}`);
    console.log(`prop coverage: lines=${lineTotal} missing=${missing.length ? missing.join(",") : "(none)"}`);
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
