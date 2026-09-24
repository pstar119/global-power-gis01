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
 *       data/osm/<region>_power_converters.geojson  ← 阶段56-A2（可缺，缺了只警告）
 *       data/osm/<region>_dc_tags.json              ← 阶段56-A2（way_id→frequency，可缺）
 * 输出：data/osm/<name>_power_{lines,substations,plants,converters}.geojson
 *       data/osm/<name>_dc_tags.json
 * 之后照常：prepare_osm_geojson.mjs → build_pmtiles.mjs
 *
 * 零新增依赖：只用 Node 标准库。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["lines", "substations", "plants", "converters"];
/**
 * 允许缺失的 kind（缺失只警告，不中断）。
 *
 * ‼️ 只有 `converters` 能进这里：它来自 A2 的补抓通道，可能没跑过；
 *    而三个电力 kind 缺失说明抓取/命名出了问题，**必须响亮失败**
 *    （静默少一类 = 归档里凭空少掉一整层要素，而 prepare 不会报错）。
 */
const OPTIONAL_KINDS = new Set(["converters"]);

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
  let missing = 0;
  for (const region of inputs) {
    const p = resolve(outDir, `${region}_power_${kind}.geojson`);
    let fc;
    try {
      fc = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      if (OPTIONAL_KINDS.has(kind)) {
        console.warn(`  ⚠️ ${kind}：读不到 ${p}（${e.code ?? e.message}）—— 跳过该输入`);
        missing++;
        continue;
      }
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
  if (OPTIONAL_KINDS.has(kind) && missing === inputs.length) {
    console.warn(
      `  ⚠️ ${kind}：**所有**输入都缺这个文件 ⇒ **不写空文件**（写了会让 prepare 以为"这一层就是空的"，` +
        `与"补抓没跑过"再也分不出来）。补抓后重跑本脚本即可。`,
    );
    continue;
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

/**
 * 阶段56-A2：直流标签也要合并 —— 它是 `way_id → frequency` 映射，与几何无关，
 * 按 key 求**并集**即可（同一个 way 在多个区域里出现时值必然相同；不同则计数并保留先到的，
 * 因为那两种写法只可能来自 OSM 数据本身在两次抓取之间被编辑过）。
 *
 * ⚠️ `complete` 是各输入 complete 的**逻辑与**：只要有一块没抓到，
 *    合并结果就是"覆盖不完整" —— 否则 prepare 会把覆盖空洞当完整覆盖用。
 */
const dcOut = resolve(outDir, `${name}_dc_tags.json`);
const dcAll = new Map();
let dcConflicts = 0;
let dcComplete = true;
let dcMissing = 0;
for (const region of inputs) {
  const p = resolve(outDir, `${region}_dc_tags.json`);
  if (!existsSync(p)) {
    console.warn(`  ⚠️ dc_tags：读不到 ${p} —— 跳过该输入（该区域的 frequency 判定会退化为拓扑）`);
    dcMissing++;
    continue;
  }
  const data = JSON.parse(readFileSync(p, "utf8"));
  const tags = data?.tags;
  if (!tags || typeof tags !== "object") {
    console.error(`❌ ${p} 里没有 tags 映射（不是补抓通道的产物）`);
    process.exit(1);
  }
  if (data.complete === false) dcComplete = false;
  for (const [k, v] of Object.entries(tags)) {
    const prev = dcAll.get(k);
    if (prev === undefined) dcAll.set(k, v);
    else if (prev !== v) dcConflicts++;
  }
}
if (dcAll.size) {
  writeFileSync(
    dcOut,
    JSON.stringify({
      name,
      source: "merge_osm_regions.mjs（并集，来自 " + inputs.join("+") + "）",
      merged_inputs: inputs,
      inputs_missing: dcMissing,
      complete: dcComplete && dcMissing === 0,
      conflicts_kept_first: dcConflicts,
      count: dcAll.size,
      note: "way_id -> OSM frequency 标签（原样字符串）。缺键 ≠ 交流；complete=false 时直流判定是降级的。",
      tags: Object.fromEntries(dcAll),
    }),
    "utf8",
  );
  console.log(
    `  ${"dc_tags".padEnd(12)} ${String(dcAll.size).padStart(7)} 个 way 带 frequency   ` +
      `冲突 ${dcConflicts}   complete=${dcComplete && dcMissing === 0}`,
  );
} else {
  console.warn("  ⚠️ dc_tags：一个输入都没有 ⇒ 不写 core 的标签文件（prepare 会退化为拓扑判定）");
}

console.log(`合计   : ${total} 个要素（去重丢弃 ${dupTotal} 条）`);
console.log(`\n下一步 : node scripts/prepare_osm_geojson.mjs --name ${name}`);
