#!/usr/bin/env node
/**
 * 把多个区域的抓取产物合并成**一片**归档源数据（按 `osm_id` 去重）。
 *
 * 为什么需要它：前端是**单 source 架构**（`OSM_SOURCE = "osm-grid"`，5 个电压档图层 +
 * 变电站/电厂点 + 点击热区全挂在它上面）。多个归档同时加载要复制整套图层，改动面很大；
 * 而"核心区"本来就连成一片，合并成一个文件即可做到**零重叠、零缝隙**。
 *
 * 用法：
 *   node scripts/merge_osm_regions.mjs --name core --inputs yrd,zhejiang
 * 输入：data/osm/<region>_power_{lines,substations,plants}.geojson
 * 输出：data/osm/<name>_power_{lines,substations,plants}.geojson
 * 之后照常：prepare_osm_geojson.mjs → build_pmtiles.mjs
 *
 * 零新增依赖：只用 Node 标准库。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["lines", "substations", "plants"];

const args = process.argv.slice(2);
let name = "core";
let inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name") name = args[++i];
  else if (args[i] === "--inputs") inputs = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
}
if (!inputs.length) {
  console.error("❌ 需要 --inputs，例如 --inputs yrd,zhejiang");
  process.exit(2);
}

const outDir = resolve(ROOT, "data/osm");
mkdirSync(outDir, { recursive: true });

console.log("=== 合并区域 → " + name + " ===");
console.log("输入   : " + inputs.join(", "));

let total = 0;
let dupTotal = 0;
for (const kind of KINDS) {
  const seen = new Set();
  const feats = [];
  let dup = 0;
  for (const region of inputs) {
    const p = resolve(outDir, `${region}_power_${kind}.geojson`);
    let fc;
    try {
      fc = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`❌ 读不到 ${p}：${e.message}`);
      process.exit(1);
    }
    for (const f of fc.features ?? []) {
      const id = f?.properties?.osm_id ?? null;
      if (id) {
        if (seen.has(id)) {
          dup++;
          continue;
        }
        seen.add(id);
      }
      feats.push(f);
    }
  }
  const out = resolve(outDir, `${name}_power_${kind}.geojson`);
  const body = JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: feats,
  });
  writeFileSync(out, body, "utf8");
  console.log(
    `  ${kind.padEnd(12)} ${String(feats.length).padStart(7)} 个要素   去重丢弃 ${String(dup).padStart(5)}   ${(Buffer.byteLength(body) / 1048576).toFixed(2)} MB`,
  );
  total += feats.length;
  dupTotal += dup;
}

console.log(`合计   : ${total} 个要素（去重丢弃 ${dupTotal} 条）`);
console.log(`\n下一步 : node scripts/prepare_osm_geojson.mjs --name ${name}`);
