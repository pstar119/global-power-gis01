#!/usr/bin/env node
/**
 * 阶段28：把 OSM 提取出来的三个 GeoJSON 合并、裁剪成一个**前端直接可用的静态文件**。
 *
 * 用法：
 *   node scripts/prepare_osm_geojson.mjs                    # 默认处理 smoketest
 *   node scripts/prepare_osm_geojson.mjs --name yrd          # 处理长三角
 *   node scripts/prepare_osm_geojson.mjs --name yrd --out-name yrd_power
 *
 * 输入：data/osm/<name>_power_{lines,substations,plants}.geojson   （由 fetch_osm_power.py 产出）
 * 输出：public/osm/<out-name>.geojson + <out-name>_meta.json
 *
 * ============================================================
 * 为什么不是「直接复制」
 * ============================================================
 * 1. **合并成一个 FeatureCollection**：MapLibre 的一个 GeoJSON source 就能装下点 + 线，
 *    前端用 `filter` 分成若干图层渲染即可 —— 不必建三个 source，图层面板和显隐逻辑也简单得多。
 *    代价是必须给每个要素加一个判别字段 `ftype`（line / substation / plant / railway / pipeline），
 *    否则前端没法区分线该用 line 图层还是 circle 图层。
 *    ‼️ 阶段43 起铁路与管道也进同一个 FeatureCollection，**依然只有一个 source、一个 MVT 图层**，
 *       前端靠 ftype 分图层。这是刻意的：多一个 source 就多一份瓦片请求与缓存。
 * 2. **裁属性**：只留渲染与点选真正要用的字段。属性是 GeoJSON 体积的大头之一，
 *    裁完能省下可观体积（尤其长三角那个量级）。
 * 3. **坐标降精度到 6 位小数**（约 0.11 m）：远高于任何缩放级别的可视精度，
 *    但能显著减少文本体积。
 * 4. **自校验**：坐标越界、几何为空、缺 vclass 的要素在这里就剔掉并计数，
 *    而不是等地图上出现「一条横穿地球的直线」再去查。
 *
 * ⚠️ 输出目录 `public/osm/` 已加入 .gitignore —— OSM 数据不进 Git。
 *    代价是全新克隆没有它，所以前端做了优雅降级（加载失败只提示，不影响底图）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeLines } from "./lib/merge-lines.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  name: "smoketest",
  inDir: "data/osm",
  outDir: "public/osm",
  outName: null, // 默认 <name>_power
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--name") cfg.name = next();
    else if (a === "--in-dir") cfg.inDir = next();
    else if (a === "--out-dir") cfg.outDir = next();
    else if (a === "--out-name") cfg.outName = next();
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: node scripts/prepare_osm_geojson.mjs [选项]",
          "",
          "  --name <n>      输入文件前缀（默认 smoketest），读取 <in-dir>/<n>_power_*.geojson",
          "  --in-dir <p>    输入目录（默认 data/osm）",
          "  --out-dir <p>   输出目录（默认 public/osm）",
          "  --out-name <n>  输出文件前缀（默认 <name>_power）",
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  cfg.outName ??= `${cfg.name}_power`;
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));

/** 每个 ftype 保留的属性白名单。`vclass` 必须保留 —— 前端的分档 filter 全靠它。
 *
 * ⚠️ 这是**第一道**白名单，第二道在 `build_pmtiles.mjs` 的 `keepProps`。
 *    两处都改才算改完 —— 阶段42 就是因为只改了这一处，导致 plant_source
 *    在切片时被静默丢掉（打包后前端拿不到该字段，而校验脚本当时假装通过）。
 *    新增 ftype 时请同时检查 `build_pmtiles.mjs`。
 *
 * 阶段56-A1（2026-09-24）两处改动：
 *   ① 删除 `railway` / `pipeline`（铁路与油气管道整体撤销，用户决定只做电力）；
 *   ② **扩容电力属性**：这些都是抓取阶段早就拿到、却被本白名单丢掉的字段
 *      （`ref` / `operator` / `cables` / `wires` / `circuits` / `plant_output`），
 *      所以扩容是**零抓取成本**的 —— 中间产物里本来就有，重跑本脚本即可生效。
 *      ⚠️ 不要往这里加 `frequency`：A1 **不重抓**，本轮产物里根本没有它，
 *         加了只会让校验脚本报"属性缺失"的假失败（它属 A2 的补抓范围）。
 */
const KEEP_PROPS = {
  line: ["osm_id", "name", "ref", "operator", "vclass", "voltage_kv", "line_kind", "cables", "wires", "circuits", "merged_count", "length_km", "osm_ids"],
  substation: ["osm_id", "name", "operator", "vclass", "voltage_kv", "substation_kind"],
  plant: ["osm_id", "name", "vclass", "voltage_kv", "plant_source", "plant_output"],
};

/**
 * 输入文件表。`power: true` 的条目参与电压分档，缺 `vclass` 会被补成 unknown。
 *
 * 阶段56-A1：只剩电力三类。铁路/管道两条已删除 —— 它们的中间产物仍留在 `data/osm/`
 * 作为历史记录，但**不再进入归档**（本表是唯一的入口，删掉即彻底不参与）。
 */
const FILES = [
  { ftype: "line", src: (n) => `${n}_power_lines.geojson`, power: true },
  { ftype: "substation", src: (n) => `${n}_power_substations.geojson`, power: true },
  { ftype: "plant", src: (n) => `${n}_power_plants.geojson`, power: true },
];

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** 坐标合法性：经纬度都要在范围内、且是有限数 */
function coordsValid(geometry) {
  const check = (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90;
  if (geometry.type === "Point") return check(geometry.coordinates);
  if (geometry.type === "LineString") return geometry.coordinates.length >= 2 && geometry.coordinates.every(check);
  if (geometry.type === "MultiLineString") return geometry.coordinates.length > 0 && geometry.coordinates.every((ls) => ls.length >= 2 && ls.every(check));
  if (geometry.type === "Polygon") return geometry.coordinates.length > 0 && geometry.coordinates.every((r) => r.length >= 3 && r.every(check));
  return false;
}

function roundCoords(geometry) {
  const r = (c) => [round6(c[0]), round6(c[1])];
  if (geometry.type === "Point") return { type: "Point", coordinates: r(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(r) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((ls) => ls.map(r)) };
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(r)) };
  return geometry;
}

function main() {
  console.log("=== 阶段28：准备前端可用的 OSM 静态 GeoJSON ===");
  console.log(`输入前缀 : ${cfg.name}`);
  console.log(`输出     : ${cfg.outDir}/${cfg.outName}.geojson`);
  console.log();

  const features = [];
  const perType = {};
  const perClass = {};
  let dropped = 0;
  let droppedNoVclass = 0;

  for (const { ftype, src, power } of FILES) {
    const srcPath = resolve(ROOT, cfg.inDir, src(cfg.name));
    if (!existsSync(srcPath)) {
      // 电力三个文件缺失是真问题（会抛错），铁路/管道缺失只是「没抓」——只警告
      if (power) console.warn(`⚠️  跳过（不存在）：${srcPath}`);
      else console.log(`  ${ftype.padEnd(11)} （未提供 ${src(cfg.name)}，跳过）`);
      continue;
    }
    const fc = JSON.parse(readFileSync(srcPath, "utf8"));
    if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
      throw new Error(`${srcPath} 不是合法的 FeatureCollection`);
    }

    const keep = KEEP_PROPS[ftype];
    if (!keep) throw new Error(`FILES 里的 ftype=${ftype} 没在 KEEP_PROPS 里定义白名单`);
    let kept = 0;
    for (const f of fc.features) {
      const g = f?.geometry;
      if (!g || !coordsValid(g)) {
        dropped++;
        continue;
      }
      const props = f.properties ?? {};
      if (power && props.vclass == null) {
        // 没有 vclass 就没法分档，前端只能当「未知」——这里补上而不是丢弃
        droppedNoVclass++;
        props.vclass = "unknown";
      }
      const slim = { ftype };
      if (props.vclass != null) slim.vclass = props.vclass;
      for (const k of keep) {
        if (k === "vclass") continue;
        const v = props[k];
        if (v !== undefined && v !== null && v !== "") slim[k] = v;
      }
      features.push({ type: "Feature", properties: slim, geometry: roundCoords(g) });
      kept++;
      if (power) perClass[props.vclass] = (perClass[props.vclass] ?? 0) + 1;
    }
    perType[ftype] = kept;
    const size = (statSync(srcPath).size / 1048576).toFixed(2);
    console.log(`  ${ftype.padEnd(11)} 读入 ${String(fc.features.length).padStart(6)}  保留 ${String(kept).padStart(6)}  （源文件 ${size} MB）`);
  }

  // ---- 阶段56-A2：把「按杆塔切碎」的线路合并成完整线路 ----
  // ‼️ 只对 `ftype === "line"` 做：变电站/电厂是点，铁路/管道已撤销。
  //    规则与全部局限写在 `lib/merge-lines.mjs` 头部（**合并结果不作电气证据**）。
  const lineFeats = features.filter((f) => f.properties.ftype === "line");
  const otherFeats = features.filter((f) => f.properties.ftype !== "line");
  let mergeStats = null;
  let mergedFeatures = features;
  if (lineFeats.length) {
    const r = mergeLines(lineFeats);
    mergeStats = r.stats;
    mergedFeatures = [...otherFeats, ...r.features];
  }

  if (mergedFeatures.length === 0) {
    throw new Error(
      `没有任何要素可写。请先运行：python scripts/fetch_osm_power.py --bbox 121.0,31.0,121.6,31.5 --grid 2x2 --name ${cfg.name}`,
    );
  }

  const outDir = resolve(ROOT, cfg.outDir);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${cfg.outName}.geojson`);
  writeFileSync(
    outPath,
    JSON.stringify({ type: "FeatureCollection", features: mergedFeatures }),
  );

  const outMb = statSync(outPath).size / 1048576;
  console.log();
  console.log("=== 结果 ===");
  console.log(`要素总数 : ${mergedFeatures.length}`);
  if (mergeStats) {
    const pct = mergeStats.input ? ((1 - mergeStats.output / mergeStats.input) * 100).toFixed(1) : "0";
    const dLen =
      mergeStats.lengthBeforeKm > 0
        ? Math.abs(mergeStats.lengthAfterKm - mergeStats.lengthBeforeKm) / mergeStats.lengthBeforeKm
        : 0;
    console.log(
      `线路合并 : ${mergeStats.input} → ${mergeStats.output} 条（减少 ${pct}%），` +
        `最长链路 ${mergeStats.maxChain} 段，总长 ${mergeStats.lengthAfterKm.toFixed(0)} km（长度守恒差 ${(dLen * 100).toFixed(3)}%）`,
    );
    if (dLen >= 0.001) console.warn("⚠️ 合并前后长度差 ≥0.1%，超出验收口径，请检查合并规则");
    if (mergeStats.brokenChains > 0 && dLen >= 0.001) {
      console.warn(
        `⚠️ 合并中有 ${mergeStats.brokenChains} 次"接不上而断开"，**且长度差 ≥0.1%** —— ` +
          `这才是方向对齐出了问题（历史缺陷曾因此丢掉 9.5% 总长），请核对 lib/merge-lines.mjs 的起步定向`,
      );
    } else if (mergeStats.brokenChains > 0) {
      // 长度守恒仍成立 ⇒ 这些断开是安全的：未消费的段由兜底循环原样单独输出，不丢长度。
      console.log(
        `ℹ️ 合并中有 ${mergeStats.brokenChains} 次主动断开（复杂拓扑，如环+支），` +
          `已按原样单独输出，长度守恒未受影响`,
      );
    }
  }
  for (const [k, v] of Object.entries(perType)) {
    if (k === "line" && mergeStats) {
      console.log(`  ${k.padEnd(11)} ${mergeStats.output}（合并前 ${mergeStats.input}）`);
    } else {
      console.log(`  ${k.padEnd(11)} ${v}`);
    }
  }
  if (Object.keys(perClass).length) {
    console.log("电压分档（仅电力） :");
    for (const cls of ["735+", "500-734", "220-499", "<220", "unknown"]) {
      if (perClass[cls]) console.log(`  ${cls.padEnd(11)} ${perClass[cls]}`);
    }
  }
  if (dropped) console.log(`剔除非法几何 : ${dropped} 个`);
  if (droppedNoVclass) console.log(`补 vclass=unknown : ${droppedNoVclass} 个（源里缺 voltage 标签）`);
  console.log(`输出体积 : ${outMb.toFixed(2)} MB`);

  const meta = {
    generated_at: new Date().toISOString(),
    sourcePrefix: cfg.name,
    featureCount: features.length,
    byType: perType,
    byVoltageClass: perClass,
    dropped,
    droppedNoVclass,
    outputFile: `${cfg.outDir}/${cfg.outName}.geojson`,
    outputSizeMb: Number(outMb.toFixed(2)),
    attribution: "© OpenStreetMap contributors (ODbL)",
  };
  const metaPath = join(outDir, `${cfg.outName}_meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`meta     : ${cfg.outDir}/${cfg.outName}_meta.json`);
  console.log();
  console.log("✅ 完成。前端会从 /osm/ 下按同路径读取（Vite 会把 public/ 复制到 dist/）。");
  return 0;
}

if (!cfg) {
  // --help
} else {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exitCode = 1;
  }
}
