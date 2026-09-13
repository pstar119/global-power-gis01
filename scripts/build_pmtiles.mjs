#!/usr/bin/env node
/**
 * 阶段29：把 OSM 电网 GeoJSON 切成 PMTiles（纯 Node.js）
 * ============================================================
 * 背景：本机 WSL 损坏（DISM 0x800f081f 无法修复），也没有 tippecanoe 的
 *      Windows 原生包。所以切片完全在 Node 里做：
 *        geojson-vt  建瓦片索引（零运行时依赖）
 *        vt-pbf      编码 MVT
 *        scripts/lib/pmtiles-writer.mjs  组装 PMTiles v3 容器（阶段26 已验证过的写入器）
 *      不引入 turf.js / d3，也不需要任何 Linux 环境。
 *
 * 输出：src-tauri/resources/maps/osm_grid.pmtiles
 *      前端用 pmtiles 协议 + HTTP Range 直接读，**不做全量几何驻留内存**，
 *      这正是长三角这种量级能流畅加载的关键。
 *
 * 用法：
 *   node scripts/build_pmtiles.mjs --name yrd --estimate-only   # 只统计，不写文件
 *   node scripts/build_pmtiles.mjs --name yrd                   # 真切片
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PMTiles, tileIdToZxy } from "pmtiles";
import {
  COMPRESSION,
  TILE_TYPE,
  buildArchive,
  enumerateBboxTiles,
  verifyArchive,
} from "./lib/pmtiles-writer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  name: "yrd",
  inFile: null,
  out: null,
  /** MVT 图层名。前端靠 "source-layer": 这个值来取数据。 */
  layer: "grid",
  minZoom: 0,
  /** z12 之后交给 MapLibre 过缩放（矢量线过缩放仍清晰），再深一级体积会翻几倍 */
  maxZoom: 12,
  indexMaxZoom: 5,
  tolerance: 3,
  extent: 4096,
  buffer: 64,
  /** 少于这么多要素的瓦片直接丢弃（默认保留所有非空瓦片） */
  minFeatures: 1,
  /**
   * 从这一级（含）开始保留全部属性；低于它只保留 ftype + vclass。
   *
   * 🔴 为什么必须这么做：低级别单张瓦片会把**上万条**要素装进去，而 `osm_id`
   *    几乎每个要素都不同 → MVT 字符串表被撑到上万条唯一值，单瓦片原始体积
   *    实测达到 522 KB（超 500 KB 经验值，解码时会有一次主线程停顿）。
   *    而前端的 filter **只用到 ftype 与 vclass**，`name`/`osm_id` 是给放大后
   *    点选弹窗用的 —— 低级别根本不点选。所以这一步是纯收益、零渲染损失。
   */
  fullPropsFromZoom: 8,
  /** 是否保留 name 属性（低级别瓦片里它会撑大字符串表，关掉可显著减体积） */
  keepNames: true,
  /**
   * 属性白名单之外的字段一律丢掉；MVT 只支持 string/number/bool。
   *
   * 🔴 阶段42 修复：原先漏了 `plant_source`。
   *    `prepare_osm_geojson.mjs` 的 KEEP_PROPS 里**有** plant_source，
   *    所以上游 prepared geojson 是带的；但本文件的白名单没收录它，
   *    `cleanProps` 就在这一步把它丢掉了 ⇒ **OSM 电厂的 plant_source
   *    从未进入任何瓦片**，前端「能源来源」那一行成了死代码
   *    （表现是静默不显示，不报错，所以很久没被发现）。
   *
   * ⚠️ 这里是**第二道**属性白名单：上游 prepare 收一次、这里再收一次。
   *    以后加字段必须**两处都改**，否则就会重演这个 bug。
   *    各 ftype 实际上会带的字段见 prepare_osm_geojson.mjs 的 KEEP_PROPS。
   */
  keepProps: [
    "ftype",
    "vclass",
    "voltage_kv",
    "name",
    "osm_id",
    "line_kind",
    "substation_kind",
    "plant_source",
  ],
  /**
   * 低级别单瓦片**要素数上限**；0 = 不封顶（默认）。
   *
   * 为什么需要它（阶段38 实测）：z0~z6 只有几张瓦片，而要素数随数据量**线性增长**、
   * 瓦片数**不增长**。核心区包 25,611 要素时最大单瓦片 283.8 KB（安全），
   * 华东可选包 93,559 要素时最大单瓦片就涨到 **922.9 KB（z4，48,533 个要素）**，
   * 超过了 MapLibre 的 500 KB 经验上限，解码时会有一次主线程停顿。
   * 全国合并后会到 20 万+ 要素，只会更糟，所以必须在本阶段解决。
   *
   * ⚠️ 默认 **0（关闭）**，保证核心区归档 osm_grid.pmtiles 的行为**一个字节不变**，
   *    阶段29~37 的全部验收结论继续成立。只在生产全国可选包时显式开启。
   */
  maxFeaturesPerTile: 0,
  /** 只对低于该级别的瓦片做封顶（高级别本来就一张瓦片几个要素） */
  capBelowZoom: 8,
  estimateOnly: false,
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--name") cfg.name = next();
    else if (a === "--in") cfg.inFile = next();
    else if (a === "--out") cfg.out = next();
    else if (a === "--layer") cfg.layer = next();
    else if (a === "--minzoom") cfg.minZoom = Number(next());
    else if (a === "--maxzoom") cfg.maxZoom = Number(next());
    else if (a === "--index-maxzoom") cfg.indexMaxZoom = Number(next());
    else if (a === "--tolerance") cfg.tolerance = Number(next());
    else if (a === "--extent") cfg.extent = Number(next());
    else if (a === "--buffer") cfg.buffer = Number(next());
    else if (a === "--min-features") cfg.minFeatures = Number(next());
    else if (a === "--full-props-from") cfg.fullPropsFromZoom = Number(next());
    else if (a === "--no-names") cfg.keepNames = false;
    else if (a === "--max-features-per-tile") cfg.maxFeaturesPerTile = Number(next());
    else if (a === "--cap-below-zoom") cfg.capBelowZoom = Number(next());
    else if (a === "--estimate-only") cfg.estimateOnly = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/build_pmtiles.mjs [选项]",
          "",
          "  --name <n>           数据名（默认 yrd），用于推导输入/输出路径",
          "  --in <path>          输入 GeoJSON（默认 public/osm/<name>_power.geojson）",
          "  --out <path>         输出 PMTiles（默认 src-tauri/resources/maps/osm_grid.pmtiles）",
          "  --layer <id>         MVT 图层名（默认 grid）",
          "  --maxzoom <n>        最深切片级别（默认 12，再深体积翻倍）",
          "  --index-maxzoom <n>  geojson-vt 内部索引级别（默认 5）",
          "  --tolerance <n>      简化容差（默认 3，越大越小越糊）",
          "  --extent <n>         瓦片网格精度（默认 4096）",
          "  --buffer <n>         瓦片边缘缓冲（默认 64）",
          "  --min-features <n>   丢弃要素数少于 n 的瓦片（默认 1）",
          "  --full-props-from <n> 从第 n 级起保留全部属性（默认 8，低于它只留 ftype+vclass）",
          "  --no-names           丢弃 name 属性以减小体积",
          "  --max-features-per-tile <n>  低级别单瓦片要素数封顶（默认 0 = 不封顶）",
          "  --cap-below-zoom <n> 只对低于该级别的瓦片封顶（默认 8）",
          "  --estimate-only      只统计瓦片数与体积，不写文件",
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  cfg.inFile = cfg.inFile ?? `public/osm/${cfg.name}_power.geojson`;
  // ⚠️ 默认输出名是写死的 `osm_grid.pmtiles`：用别的 --name 生成时必须显式 --out，
  //    否则会把已装好的那个区域的归档**静默覆盖掉**（实测踩过：浙江盖掉了长三角）。
  //    多区域命名约定：--out src-tauri/resources/maps/osm-<region>.pmtiles
  if (!cfg.out) {
    cfg.out = "src-tauri/resources/maps/osm_grid.pmtiles";
    if (cfg.name !== "yrd") {
      console.warn(
        `⚠️  未指定 --out，将写入默认归档 ${cfg.out}；当前 --name=${cfg.name}，\n` +
          `    如果那里已有其它区域的数据，会被覆盖。多区域请显式指定，例如：\n` +
          `    --out src-tauri/resources/maps/osm-${cfg.name}.pmtiles`,
      );
    }
  }
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));

// ============================================================
// 低级别抽稀
// ============================================================
/** 电压档优先级：数字越小越先保留 */
const VCLASS_RANK = { "735+": 0, "500-734": 1, "220-499": 2, "<220": 3, unknown: 4 };
/** 同电压档内，点比线更值得保留（一个电厂/变电站点的信息量高于一段线） */
const FTYPE_RANK = { plant: 0, substation: 1, line: 2 };

/**
 * 低级别瓦片抽稀：**按电压由高到低**优先保留。
 *
 * 为什么按电压而不是随机/等距抽：低级别看到的是电网**骨架**。
 * 抽掉 10kV 支线不影响观感，抽掉 ±800kV 直流就丢掉主线了。
 * 用「稳定排序 + 原始序号兜底」，保证同一份输入每次切出的瓦片完全一致（可重现）。
 */
function pickForLowZoom(features, cap) {
  const ranked = features.map((f, i) => {
    const t = f.tags ?? {};
    const vr = VCLASS_RANK[t.vclass] ?? 5;
    const fr = FTYPE_RANK[t.ftype] ?? 3;
    return { f, i, key: vr * 10 + fr };
  });
  ranked.sort((a, b) => a.key - b.key || a.i - b.i);
  return ranked.slice(0, cap).map((r) => r.f);
}

// ============================================================
// 属性清洗：MVT 只支持 string / number / bool
// ============================================================
function cleanProps(props) {
  const out = {};
  for (const k of cfg.keepProps) {
    if (k === "name" && !cfg.keepNames) continue;
    const v = props?.[k];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const inPath = resolve(ROOT, cfg.inFile);
  const outPath = resolve(ROOT, cfg.out);
  console.log("=== 阶段29：OSM 电网 GeoJSON → PMTiles（纯 Node） ===");
  console.log(`输入   : ${cfg.inFile}`);

  let fc;
  try {
    fc = JSON.parse(readFileSync(inPath, "utf8"));
  } catch (err) {
    throw new Error(
      `读不到输入文件 ${inPath}（${err.message}）。\n` +
        `请先跑：python scripts/fetch_osm_power.py --preset yrd --name ${cfg.name}\n` +
        `    再跑：node scripts/prepare_osm_geojson.mjs --name ${cfg.name}`,
    );
  }
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error(`${inPath} 不是合法的 FeatureCollection`);
  }
  console.log(`要素数 : ${fc.features.length.toLocaleString()}`);

  // ---- 统计 + 抽样诊断（看不见数据分布就没法判断体积是否合理） ----
  const ftypeHist = {};
  const vclassHist = {};
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let vertexCount = 0;
  for (const f of fc.features) {
    const p = f.properties ?? {};
    ftypeHist[p.ftype ?? "?"] = (ftypeHist[p.ftype ?? "?"] ?? 0) + 1;
    vclassHist[p.vclass ?? "?"] = (vclassHist[p.vclass ?? "?"] ?? 0) + 1;
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === "Point" ? [[g.coordinates]] : g.type === "LineString" ? [g.coordinates] : g.coordinates;
    for (const ring of rings) {
      for (const c of ring) {
        vertexCount++;
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
    }
  }
  const bounds = [minLon, minLat, maxLon, maxLat];
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  console.log(`坐标点 : ${vertexCount.toLocaleString()}`);
  console.log(`范围   : ${minLon.toFixed(3)},${minLat.toFixed(3)} → ${maxLon.toFixed(3)},${maxLat.toFixed(3)}`);
  console.log(`ftype  : ${JSON.stringify(ftypeHist)}`);
  console.log(`vclass : ${JSON.stringify(vclassHist)}`);

  // ---- 清洗属性后交给 geojson-vt ----
  const cleaned = {
    type: "FeatureCollection",
    features: fc.features
      .filter((f) => f.geometry)
      .map((f) => ({ type: "Feature", properties: cleanProps(f.properties), geometry: f.geometry })),
  };

  // geojson-vt 5.x 把工厂函数改成了 class（必须 new），3.x 是普通函数；
  // 两种写法都能兼容：3.x 的函数会显式 return 一个对象，用 new 调用拿到的仍是那个对象。
  const gvMod = await import("geojson-vt");
  const GeoJSONVT = gvMod.default ?? gvMod;
  const vtpbfMod = await import("vt-pbf");
  const vtpbf = vtpbfMod.default ?? vtpbfMod;

  const t0 = Date.now();
  const indexOptions = {
    maxZoom: cfg.maxZoom,
    indexMaxZoom: cfg.indexMaxZoom,
    tolerance: cfg.tolerance,
    extent: cfg.extent,
    buffer: cfg.buffer,
  };
  let index;
  try {
    index = new GeoJSONVT(cleaned, indexOptions);
  } catch (err) {
    if (!/without 'new'/.test(String(err))) throw err;
    index = GeoJSONVT(cleaned, indexOptions);
  }
  console.log(`\ngeojson-vt 建索引完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

  // ---- 逐级别枚举并生成瓦片 ----
  const candidates = enumerateBboxTiles({ bbox: bounds, minZoom: cfg.minZoom, maxZoom: cfg.maxZoom });
  const tiles = new Map();
  const perZoomWritten = new Map();
  const perZoomBytes = new Map();
  let emptySkipped = 0;
  let tooFewSkipped = 0;
  let rawBytes = 0;
  let encoded = 0;
  // 低级别瓦片会把全部要素装进去，单瓦片体积是「会不会糊住客户端」的关键指标，
  // 必须实测而不是估。MapLibre 对超大瓦片的解码会在主线程上卡一下。
  let widest = { rawSize: 0, gzSize: 0, z: -1, x: -1, y: -1, features: 0 };
  // 低级别封顶的统计：必须报出来，否则「体积极限通过」会掩盖「要素被丢了 90%」。
  let cappedTiles = 0;
  let droppedFeatures = 0;
  const t1 = Date.now();

  for (let z = cfg.minZoom; z <= cfg.maxZoom; z++) {
    let written = 0;
    let bytes = 0;
    for (const tileId of candidates.perZoom.get(z) ?? []) {
      // tileId 是 Hilbert 序，回推 z/x/y —— 用官方实现，避免自己写错
      const [tz, tx, ty] = tileIdToZxy(tileId);
      let tile = index.getTile(tz, tx, ty);
      if (!tile || tile.features.length === 0) {
        emptySkipped++;
        continue;
      }
      if (tile.features.length < cfg.minFeatures) {
        tooFewSkipped++;
        continue;
      }
      // ---- 低级别单瓦片要素数封顶（默认关闭，见 DEFAULTS 里的说明）----
      // ⚠️ 用「换新对象」而不是就地改 tile.features：geojson-vt 会**缓存瓦片**，
      //    就地 splice 会污染缓存（与下面改 tags 同一个坑）。
      if (
        cfg.maxFeaturesPerTile > 0 &&
        tz < cfg.capBelowZoom &&
        tile.features.length > cfg.maxFeaturesPerTile
      ) {
        const kept = pickForLowZoom(tile.features, cfg.maxFeaturesPerTile);
        droppedFeatures += tile.features.length - kept.length;
        cappedTiles++;
        tile = { ...tile, features: kept };
      }
      // 低级别只保留 ftype + vclass（见 fullPropsFromZoom 的说明）。
      // ⚠️ 用「换成新对象」而不是在原来的 tags 上 delete：geojson-vt 会缓存瓦片，
      //    且高层级切片出来的要素可能与被缓存的低层级要素**共享同一个 tags 对象**，
      //    就地 delete 会污染高层级数据。
      if (tz < cfg.fullPropsFromZoom) {
        for (const f of tile.features) {
          const t = f.tags ?? {};
          f.tags = { ftype: t.ftype, vclass: t.vclass };
        }
      }
      // 🔴 必须显式指定 version: 2。
      //    vt-pbf 源码里 `options.version` 的默认值是 **1**（index.js: `writeVarintField(15, layer.version || 1)`），
      //    而 MapLibre 拿到 v1 会打警告：
      //      Vector tile source "osm-grid" layer "grid" does not use vector tile spec v2
      //        and therefore may have some rendering errors.
      //    这个坑不看开发日志根本发现不了（地图上只是「什么都不显示」）。
      const buf = Buffer.from(
        vtpbf.fromGeojsonVt({ [cfg.layer]: tile }, { version: 2, extent: cfg.extent }),
      );
      const gz = gzipSync(buf);
      if (buf.length > widest.rawSize) {
        widest = { rawSize: buf.length, gzSize: gz.length, z: tz, x: tx, y: ty, features: tile.features.length };
      }
      tiles.set(tileId, gz);
      rawBytes += buf.length;
      bytes += gz.length;
      written++;
      encoded++;
      if (encoded % 500 === 0) console.log(`  …已编码 ${encoded} 张`);
    }
    perZoomWritten.set(z, written);
    perZoomBytes.set(z, bytes);
  }
  const genSec = (Date.now() - t1) / 1000;

  console.log(`\n瓦片生成完成（${genSec.toFixed(1)} 秒）`);
  console.log("  级别   写出瓦片      压缩后体积");
  for (let z = cfg.minZoom; z <= cfg.maxZoom; z++) {
    const n = perZoomWritten.get(z) ?? 0;
    const b = perZoomBytes.get(z) ?? 0;
    console.log(`  z${String(z).padEnd(4)} ${String(n).padStart(8)}  ${(b / 1024).toFixed(1).padStart(10)} KB`);
  }
  console.log(`  空瓦片跳过 : ${emptySkipped.toLocaleString()}`);
  console.log(`  过稀疏跳过 : ${tooFewSkipped.toLocaleString()}`);
  if (cfg.maxFeaturesPerTile > 0) {
    console.log(
      `  低级别封顶 : ${cappedTiles.toLocaleString()} 张瓦片被截断，共丢弃 ${droppedFeatures.toLocaleString()} 个要素` +
        `（上限 ${cfg.maxFeaturesPerTile.toLocaleString()}/瓦片，仅 z<${cfg.capBelowZoom}；按电压由高到低保留）`,
    );
  }
  console.log(
    `  最大单瓦片 : ${(widest.rawSize / 1024).toFixed(1)} KB 原始 / ${(widest.gzSize / 1024).toFixed(1)} KB gzip` +
      `（z${widest.z}/${widest.x}/${widest.y}，${widest.features} 个要素）`,
  );
  if (widest.rawSize > 500 * 1024) {
    console.log(
      "  ⚠️ 有瓦片超过 500 KB（MapLibre 的经验上限）。低级别瓦片把全部要素都装进去了，" +
        "需要降低 --maxzoom 或加抽稀策略。",
    );
  }
  console.log(
    `  合计       : ${tiles.size.toLocaleString()} 张瓦片，` +
      `MVT 原始 ${(rawBytes / 1048576).toFixed(2)} MB → gzip ${(
        [...perZoomBytes.values()].reduce((a, b) => a + b, 0) / 1048576
      ).toFixed(2)} MB（压缩比 ${(rawBytes / Math.max(1, [...perZoomBytes.values()].reduce((a, b) => a + b, 0))).toFixed(1)}x）`,
  );

  if (tiles.size === 0) throw new Error("一张瓦片都没生成，检查输入数据是否为空或 bbox 是否合理");

  if (cfg.estimateOnly) {
    console.log("\n[试算模式] 未写任何文件。");
    return;
  }

  // ---- 组装归档 ----
  const realZooms = [...perZoomWritten.entries()].filter(([, n]) => n > 0).map(([z]) => z);
  const actualMinZoom = Math.min(...realZooms);
  const actualMaxZoom = Math.max(...realZooms);

  const metadata = {
    name: `Global Power GIS — OSM 电网（${cfg.name}）`,
    format: "pbf",
    type: "overlay",
    version: "1",
    description:
      "OSM 输电线路与变电站/电厂。属性 ftype=line|substation|plant，vclass 为电压分档（735+ / 500-734 / 220-499 / <220 / unknown）。",
    attribution: "© OpenStreetMap contributors (ODbL)",
    minzoom: actualMinZoom,
    maxzoom: actualMaxZoom,
    bounds,
    center: [center[0], center[1], Math.min(actualMaxZoom, 9)],
    vector_layers: [
      {
        id: cfg.layer,
        description: "OSM 电网要素（线 + 点混合，靠 ftype 区分）",
        minzoom: actualMinZoom,
        maxzoom: actualMaxZoom,
        fields: {
          ftype: "String",
          vclass: "String",
          voltage_kv: "Number",
          name: "String",
          osm_id: "String",
        },
      },
    ],
  };

  const archive = buildArchive({
    tiles,
    metadataBuf: Buffer.from(JSON.stringify(metadata), "utf8"),
    tileType: TILE_TYPE.Mvt,
    tileCompression: COMPRESSION.Gzip,
    bounds,
    center: [Math.min(actualMaxZoom, 9), center[0], center[1]],
    minZoom: actualMinZoom,
    maxZoom: actualMaxZoom,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, archive.buf);
  console.log(`\n已写出      : ${cfg.out}`);
  console.log(
    `体积        : ${(statSync(outPath).size / 1048576).toFixed(2)} MB（其中叶子目录 ${archive.leafCount} 个）`,
  );

  // ---- 自校验 ----
  console.log("\n用官方 pmtiles 包回读校验…");
  const sampleIds = [];
  for (const z of [actualMinZoom, Math.min(actualMaxZoom, 9), actualMaxZoom]) {
    for (const id of tiles.keys()) {
      if (tileIdToZxy(id)[0] === z) {
        sampleIds.push(id);
        break;
      }
    }
  }
  const v = await verifyArchive(outPath, { sampleIds, layerNames: [cfg.layer] });
  console.log(
    `回读 header : z${v.header.minZoom}-${v.header.maxZoom}，tileType=${v.header.tileType}，` +
      `tileCompression=${v.header.tileCompression}，addressed=${v.header.numAddressedTiles.toLocaleString()}`,
  );
  if (v.missing) console.log(`  ⚠️ 有 ${v.missing} 张抽样瓦片回读不到`);

  // 再用 @mapbox/vector-tile 真正解码，确认真是合法 MVT（vt-pbf 自带的依赖，不额外安装）
  const { VectorTile } = await import("@mapbox/vector-tile");
  const pbfMod = await import("pbf");
  const Pbf = pbfMod.default ?? pbfMod;
  const raw = readFileSync(outPath);
  const pm = new PMTiles(
    new (class {
      getBytes(offset, length) {
        return Promise.resolve({
          data: raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + length),
        });
      }
      getKey() {
        return "verify";
      }
    })(),
  );
  for (const id of sampleIds) {
    const [z, x, y] = tileIdToZxy(id);
    const r = await pm.getZxy(z, x, y);
    if (!r) continue;
    const vt = new VectorTile(new Pbf(new Uint8Array(r.data)));
    const layer = vt.layers[cfg.layer];
    if (!layer) throw new Error(`抽样瓦片 z${z}/${x}/${y} 里没有图层 ${cfg.layer}，归档内容不对`);
    const first = layer.feature(0);
    console.log(
      `  z${z}/${x}/${y}  图层=${cfg.layer} 要素=${layer.length}  首要素类型=${first.type} ` +
        `属性=${JSON.stringify(first.properties)}`,
    );
  }
  console.log(`\n✅ 完成：${tiles.size.toLocaleString()} 张瓦片，回读校验通过。\n`);
}

if (!cfg) {
  // --help
} else {
  main().catch((err) => {
    console.error(`\n❌ ${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
}
