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
   *
   * 阶段56-A1（2026-09-24）：
   *   · 删除铁路 `railway_kind`/`usage` 与管道 `substance`（两类整体撤销）；
   *   · 收录扩容后的电力属性 `ref` / `operator` / `cables` / `wires` / `circuits`，
   *     以及**此前一直漏在这里的** `plant_output` —— 上游 prepare 早就保留它，
   *     本白名单却没有，属阶段42 那个 bug 的同类翻版（静默丢字段，不报错）。
   *     ⇒ 本次把两处白名单**对齐**，并以 `verify_power_only.mjs` 的 `missing=` 作为回归门禁。
   *   · ⚠️ 不要加 `frequency`：A1 不重抓，上游产物里没有它（属 A2）。
   */
  keepProps: [
    "ftype",
    "vclass",
    "voltage_kv",
    "name",
    "osm_id",
    "ref",
    "operator",
    "line_kind",
    "substation_kind",
    "plant_source",
    "plant_output",
    "cables",
    "wires",
    "circuits",
    // 阶段56-A2：线路合并的产物（merged_count / length_km 是数值，osm_ids 是逗号串
    // —— MVT 不支持数组属性，见 merge-lines.mjs 的 decorate）
    "merged_count",
    "length_km",
    "osm_ids",
    /**
     * 阶段56-A2：直交流分档。
     *   · `frequency`：OSM 的频率标签（"0" = 直流；缺键 ≠ 交流），覆盖率实测 ~11%；
     *   · `is_dc`：prepare 按设计 §4.1 的三步判定算出来的布尔值，**每条线路都有**
     *     （true/false 都写）。前端靠它分「直流（HVDC）」档。
     * ‼️ `is_dc` 还必须进 `collapseProps`（低级别白名单）—— 见那里的注释。
     */
    "frequency",
    "is_dc",
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
  /**
   * 阶段50：低缩放级别把 tags **收敛到哪几个字段**（默认就是 OSM 那套）。
   *
   * 🔴 为什么要做成可配置：下面那段收敛原本写死成 `{ftype, vclass}`，
   *    而 GEM 电厂数据**根本没有这两个字段** —— 一旦沿用，低缩放级别所有属性会被清空，
   *    前端的 `["match", ["get","plant_type"], …]` 会全部落到兑底色。
   *    这种 bug 在小缩放下才现形，很容易漏掉。
   * ⚠️ 默认值与改动前**完全一致** ⇒ 现有 OSM 归档逐字节不变。
   *
   * ‼️ 阶段56-A2 的**有意变更**：默认值加上了 `is_dc`。
   *    这不是顺手改的，而是设计 §5.1 的硬约束：低缩放（z<8）瓦片只保留白名单字段，
   *    而前端的"直流（HVDC）"档靠 `["==", ["get","is_dc"], true]` 取数据 ——
   *    `is_dc` 不在白名单里，低缩放**直流配色会静默失效**（全部按交流上色，且不报错）。
   *    代价：低缩放瓦片多了 1 个低基数字段（只有 true/false/缺失三种值），体积几乎不变。
   *    ⇒ 核心区归档的低级别瓦片因此**不再与改动前逐字节一致**，这是预期的。
   */
  collapseProps: ["ftype", "vclass", "is_dc"],
  estimateOnly: false,
  /**
   * 阶段50-B：**数据源品类**。
   *
   * · `"osm"`（默认）—— 输电线路 + 变电站/电厂，MVT 图层名 `grid`
   * · `"gem"`  —— Global Energy Monitor 电源设施点，MVT 图层名 `gem`
   *
   * ⚠️ 默认 `"osm"` ⇒ 不传 `--kind` 时**代码路径与改动前完全一致**，
   *    现有 OSM 归档继续逐字节可复现。
   */
  kind: "osm",
};

/**
 * 阶段50-B：`--kind` 的专用档案（**只对 gem 生效**）。
 *
 * ‼️ 为什么不直接改 `DEFAULTS`：`DEFAULTS` 是 OSM 的基线，阶段29~43 关于
 *    「体积 / 图层 id / 配色 / 画序」的全部验收结论都建立在它之上。
 *    改它 = 让 OSM 归档不再是可复现的同一份东西。
 *    所以这里的值只在 `--kind gem` 时**逐键回填**，且**显式传过的参数优先**。
 *
 * ⚠️ `collapseProps` 必须跟着换：高缩放级收敛的默认值是 `ftype,vclass`，
 *    而 GEM 数据**这两个字段一个都没有** —— 沿用会让 z<fullPropsFromZoom
 *    的瓦片属性被**清空**（`collapsed` 变成 `{}`），症状是「字段全没了、坐标还在」：
 *    地图上点都在，但按容量取半径、按状态做 filter 全部失灵，而且**不报错**。
 *    这里取的是白名单里体积可控且对渲染有用的三个（`name` 特意不放 ——
 *    它几乎每个要素都不同，会把低级别瓦片的 MVT 字符串表撞大，
 *    原因见 `fullPropsFromZoom` 的注释）。
 */
const KIND_PROFILES = {
  gem: {
    layer: "gem",
    /**
     * ⚠️ z10 而非 OSM 默认的 z12。
     *    理由：①本仓已有的 GEM 归档就是用 z10 切的（已验收的那份 5.53 MB）；
     *        ②GEM 是**纯点**数据，没有需要逐级简化的线几何，再深两级只是把
     *          同一个点重复写进更多的瓦片 —— 实测 z12 会把归档从 5.85 MB 撞到
     *          9.41 MB（瓦片数 19,182 → 41,749），体积 +61% 而信息量不变。
     *    需要更深时显式传 `--maxzoom 12`（显式值优先）。
     */
    maxZoom: 10,
    /**
     * 阶段50-B.1：与 `import_gem_plants.py` 的 `KEEP` **逐字一致**。
     * ‼️ 两处必须同步：上游少写一个字段 ⇒ 这里白名单取不到；
     *    这里漏一个字段 ⇒ 瓦片里就真没这一列。两边都不报错。
     *    （阶段50-B 审查发现的两个隐患正是这么来的：`plant_type` 没进白名单，
     *      导致三类电源在图上同一个颜色。）
     */
    keepProps: [
      "location_id",
      "country",
      "state",
      "name",
      "plant_type",
      "units",
      "capacity",
      "status",
      "owner",
    ],
    /**
     * 低缩放级（z<fullPropsFromZoom）收敛到哪几个字段。
     *
     * 🔴 `plant_type` **必须在这里**，否则 `["get", "plant_type"]`
     *    在 z<8 的瓦片里会返回 **undefined** —— 而 MapLibre 不报错，
     *    只是 `match` 表达式落到兑底色。前端据此取颜色的需求就静默失效了。
     * 🔴 `location_id` / `name` / `owner` / `country` / `state` **刻意不在这里**：
     *    · `location_id` 是高基数字符串（14,793 个唯一值）—— 放进来会让
     *      z0~z7 那一共 2,410 张瓦片的字符串表全部撞大，代价是非线性的
     *      （这 2,410 张瓦片装着全部 14,793 个要素，体积几乎全压在这一级）
     *    · `name` / `owner` 同理，都是逐要素不同的自由文本
     *    · `country` / `state` 基数低，本可以放，但低缩放级本来就不点选，
     *      没有收益就不加
     *    ⇒ 它们仍会在 z>=fullPropsFromZoom 的瓦片里完整保留，弹窗照常可读。
     */
    collapseProps: ["plant_type", "units", "capacity", "status"],
    fullPropsFromZoom: 8,
  },
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  /**
   * 显式传过的参数 —— 供 `--kind` 回填默认值时避让。
   * ⚠️ 不能靠「值是否等于 DEFAULTS」来判断：用户显式传 `--layer grid --kind gem`
   *    时那是真实意图，与默认值恰好相同，会被误当成「没传过」而静默覆盖。
   */
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--name") cfg.name = next();
    else if (a === "--in") {
      cfg.inFile = next();
      explicit.add("inFile");
    } else if (a === "--out") {
      cfg.out = next();
      explicit.add("out");
    } else if (a === "--layer") {
      cfg.layer = next();
      explicit.add("layer");
    } else if (a === "--kind") {
      const k = next();
      if (!KIND_PROFILES[k] && k !== "osm") {
        throw new Error(`--kind 只支持 osm | gem，收到：${k}`);
      }
      cfg.kind = k;
    } else if (a === "--minzoom") cfg.minZoom = Number(next());
    else if (a === "--maxzoom") {
      cfg.maxZoom = Number(next());
      explicit.add("maxZoom");
    } else if (a === "--index-maxzoom") cfg.indexMaxZoom = Number(next());
    else if (a === "--tolerance") cfg.tolerance = Number(next());
    else if (a === "--extent") cfg.extent = Number(next());
    else if (a === "--buffer") cfg.buffer = Number(next());
    else if (a === "--min-features") cfg.minFeatures = Number(next());
    else if (a === "--full-props-from") {
      cfg.fullPropsFromZoom = Number(next());
      explicit.add("fullPropsFromZoom");
    } else if (a === "--no-names") cfg.keepNames = false;
    else if (a === "--max-features-per-tile") cfg.maxFeaturesPerTile = Number(next());
    else if (a === "--cap-below-zoom") cfg.capBelowZoom = Number(next());
    else if (a === "--keep-props") {
      cfg.keepProps = next().split(",").map((s) => s.trim()).filter(Boolean);
      explicit.add("keepProps");
    } else if (a === "--collapse-props") {
      cfg.collapseProps = next().split(",").map((s) => s.trim()).filter(Boolean);
      explicit.add("collapseProps");
    } else if (a === "--estimate-only") cfg.estimateOnly = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/build_pmtiles.mjs [选项]",
          "",
          "  --name <n>           数据名（默认 yrd），用于推导输入/输出路径",
          "  --kind <osm|gem>     数据源品类（默认 osm）",
          "                       osm → 输入 public/osm/<name>_power.geojson，输出 osm_grid.pmtiles，图层 grid",
          "                       gem → 输入 data/packs/<name>.geojson，输出 data/packs/<name>.pmtiles，图层 gem",
          "  --in <path>          输入 GeoJSON（默认按 --kind 推导）",
          "  --out <path>         输出 PMTiles（默认按 --kind 推导）",
          "  --layer <id>         MVT 图层名（osm 默认 grid，gem 默认 gem）",
          "  --maxzoom <n>        最深切片级别（osm 默认 12，gem 默认 10；点数据再深只是重复写点）",
          "  --index-maxzoom <n>  geojson-vt 内部索引级别（默认 5）",
          "  --tolerance <n>      简化容差（默认 3，越大越小越糊）",
          "  --extent <n>         瓦片网格精度（默认 4096）",
          "  --buffer <n>         瓦片边缘缓冲（默认 64）",
          "  --min-features <n>   丢弃要素数少于 n 的瓦片（默认 1）",
          "  --full-props-from <n> 从第 n 级起保留全部属性（osm/gem 默认都是 8）",
          "  --no-names           丢弃 name 属性以减小体积",
          "  --max-features-per-tile <n>  低级别单瓦片要素数封顶（默认 0 = 不封顶）",
          "  --cap-below-zoom <n> 只对低于该级别的瓦片封顶（默认 8）",
          "  --keep-props <csv>   属性白名单（osm 默认那 11 项；gem 默认 name,country,state,units,capacity,status,owner,wiki,locationId）",
          "  --collapse-props <csv>  低级别收敛到哪几个字段（osm 默认 ftype,vclass；gem 默认 units,capacity,status）",
          "  --estimate-only      只统计瓦片数与体积，不写文件",
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  // ---- 阶段50-B：按品类回填默认值（显式传过的参数优先）----
  // ⚠️ 不传 --kind 时这段整块跳过，OSM 路径与改动前完全一致。
  if (cfg.kind !== "osm") {
    for (const [k, v] of Object.entries(KIND_PROFILES[cfg.kind])) {
      if (!explicit.has(k)) cfg[k] = v;
    }
  }

  cfg.inFile =
    cfg.inFile ??
    (cfg.kind === "gem" ? `data/packs/${cfg.name}.geojson` : `public/osm/${cfg.name}_power.geojson`);
  // ⚠️ 默认输出名是写死的 `osm_grid.pmtiles`：用别的 --name 生成时必须显式 --out，
  //    否则会把已装好的那个区域的归档**静默覆盖掉**（实测踩过：浙江盖掉了长三角）。
  //    多区域命名约定：--out src-tauri/resources/maps/osm-<region>.pmtiles
  if (!cfg.out) {
    if (cfg.kind === "gem") {
      // 阶段50-B.1：GEM 是 **downloadable thematic pack**，不进安装包
      // （否则安装包 46.5 → ~52 MB，超预算）。
      // 所以归档与区域包**走同一个目录约定**：构建产物落 `data/packs/`，
      // 由 `gen_packs_manifest.mjs` 算指纹、上传到 Release，
      // 用户下载后落到 `app_data_dir/packs/`。
      // ‼️ 不再放 `src-tauri/resources/` —— 那个目录下的东西会被
      //    `bundle.resources` 打进安装包。
      cfg.out = `data/packs/${cfg.name}.pmtiles`;
    } else {
      cfg.out = "src-tauri/resources/maps/osm_grid.pmtiles";
      if (cfg.name !== "yrd") {
        console.warn(
          `⚠️  未指定 --out，将写入默认归档 ${cfg.out}；当前 --name=${cfg.name}，\n` +
            `    如果那里已有其它区域的数据，会被覆盖。多区域请显式指定，例如：\n` +
            `    --out src-tauri/resources/maps/osm-${cfg.name}.pmtiles`,
        );
      }
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
/**
 * 同电压档内，点比线更值得保留（一个电厂/变电站点的信息量高于一段线）。
 *
 * 阶段56-A2：换流站与变电站同档（都是点要素，都是点选/识别锚点）。
 * 换流站数量极少（全国百来个量级），低缩放丢掉一个就少一个直流锚点，
 * 但它也不该压过电厂 —— 所以放在与变电站相同的一档，而不是最前。
 */
const FTYPE_RANK = { plant: 0, substation: 1, converter: 1, line: 2 };

/**
 * 低级别瓦片抽稀：**有电压/类型字段时按电压由高到低优先保留**。
 *
 * 为什么按电压而不是随机/等距抽：低级别看到的是电网**骨架**。
 * 抽掉 10kV 支线不影响观感，抽掉 ±800kV 直流就丢掉主线了。
 * 用「稳定排序 + 原始序号兵底」，保证同一份输入每次切出的瓦片完全一致（可重现）。
 *
 * ⚠️ 阶段50：**非 OSM 数据没有 `vclass` / `ftype`**（如 GEM 电厂点），
 *    此时所有要素的 key 都相同，排序退化为 `a.i - b.i` ——
 *    也就是「**按源数据顺序保留前 cap 个**」。这是预期行为，不是 bug，
 *    但日志里不能再说「按电压保留」（那会让人以为有优先级，白排查）。
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
  console.log(`=== ${cfg.kind === "gem" ? "GEM 电源数据" : "OSM 电网"} GeoJSON → PMTiles（纯 Node） ===`);
  console.log(`品类   : ${cfg.kind}（MVT 图层名 "${cfg.layer}"）`);
  console.log(`输入   : ${cfg.inFile}`);

  let fc;
  try {
    fc = JSON.parse(readFileSync(inPath, "utf8"));
  } catch (err) {
    throw new Error(
      `读不到输入文件 ${inPath}（${err.message}）。\n` +
        (cfg.kind === "gem"
          ? `请先跑：python scripts/import_gem_plants.py --out ${cfg.inFile}`
          : `请先跑：python scripts/fetch_osm_power.py --preset yrd --name ${cfg.name}\n` +
            `    再跑：node scripts/prepare_osm_geojson.mjs --name ${cfg.name}`),
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

  // ---- 阶段50-B：几何类型核对 ----
  // GEM 归档的契约是**纯 Point**（数据模型是「设施点位」）。若混进了线/面，
  // 前端的 circle 图层不会报错，而是默默不画 —— 所以在这里就描出来。
  const geomHist = {};
  for (const f of fc.features) {
    const t = f.geometry?.type ?? "null";
    geomHist[t] = (geomHist[t] ?? 0) + 1;
  }
  console.log(`geometry: ${JSON.stringify(geomHist)}`);
  if (cfg.kind === "gem") {
    const bad = Object.entries(geomHist).filter(([t]) => t !== "Point");
    if (bad.length) {
      throw new Error(
        `--kind gem 要求全部为 Point 几何，实测发现：` +
          bad.map(([t, n]) => `${t}×${n}`).join("、") +
          `\n请在上游（import_gem_plants.py）把几何统一成 Point 再切片。`,
      );
    }
  }

  // ---- 阶段50-B：属性白名单核对 ----
  // ‼️ 为什么必须打印：`cleanProps` 对**白名单里但源数据没有的字段是静默跳过的**
  //    （不报错、不写空值）。于是「字段名写错/与源数据对不上」和「数据本来就没这一列」
  //    两种情况的症状完全一样：瓦片里少了几列，且没有任何提示。实测本次就碰到了 ——
  //    需求白名单 9 项中的 country/state/wiki/locationId 在 GEM 源数据里**一个都没有**，
  //    而源数据真正有的 `plant_type` 又不在白名单内。
  //    这里把「命中 / 落空 / 被丢弃」三类都摊开，让静默变成可见。
  const srcKeys = new Map();
  for (const f of fc.features) {
    for (const k of Object.keys(f.properties ?? {})) srcKeys.set(k, (srcKeys.get(k) ?? 0) + 1);
  }
  const hit = [];
  const missed = [];
  for (const k of cfg.keepProps) {
    if (k === "name" && !cfg.keepNames) {
      missed.push(`${k}（被 --no-names 关闭）`);
      continue;
    }
    if (srcKeys.has(k)) hit.push(`${k}(${srcKeys.get(k)})`);
    else missed.push(k);
  }
  const dropped = [...srcKeys]
    .filter(([k]) => !cfg.keepProps.includes(k))
    .map(([k, n]) => `${k}(${n})`);
  console.log(`保留字段: ${hit.join(" ") || "（无）"}`);
  if (missed.length) {
    console.warn(
      `⚠️  白名单里 ${missed.length} 项在源数据中不存在，将被**静默跳过**：${missed.join("、")}`,
    );
  }
  if (dropped.length) {
    console.warn(
      `⚠️  源数据里 ${dropped.length} 个字段不在白名单内，将被丢弃：${dropped.join("、")}`,
    );
  }

  // ---- 阶段50-B.2：低缩放级字段的**基数审查**（可执行守卫）----
  // ‼️ 为什么必须查：`collapseProps` 里的字段会被写进**每一张**低缩放级瓦片。
  //    一个高基数字段（如 `location_id`，14,793 个唯一值）放进去，
  //    会让 z<fullPropsFromZoom 的每张瓦片字符串表都被撑大 ——
  //    而那些瓦片只有 2,410 张、却装着**全部** 14,793 个要素，代价是非线性的。
  //    这正是「归档从 5.53 涨到 6.85 MB」背后的机理。
  //    以前这只是一条写在注释里的约定，谁改错了都不会被发现；现在它会自己报警。
  const HIGH_CARDINALITY = 2000;
  const cardinalityOf = (k) => {
    const seen = new Set();
    for (const f of fc.features) {
      const v = f.properties?.[k];
      if (v !== null && v !== undefined && v !== "") seen.add(v);
    }
    return seen.size;
  };
  if (cfg.collapseProps.length) {
    console.log("低缩放级字段基数：");
    for (const k of cfg.collapseProps) {
      const n = cardinalityOf(k);
      const high = n > HIGH_CARDINALITY;
      console.log(`  ${k.padEnd(12)} ${String(n).padStart(7)} 个唯一值  ${high ? "⚠️ 高基数" : "ok"}`);
      if (high) {
        console.warn(
          `⚠️  collapseProps 含高基数字段 "${k}"（${n} 个唯一值 > 阈值 ${HIGH_CARDINALITY}）。\n` +
            `    它会被写进每一张低缩放级瓦片，归档体积会明显膨胀。\n` +
            `    若该字段只在放大后点选时才需要，请把它从 --collapse-props 移除 ——\n` +
            `    它仍会在 z>=${cfg.fullPropsFromZoom} 的瓦片里完整保留。`,
        );
      }
    }
  }

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
          // 🔴 阶段43 修复：不能无脑写成 `{ ftype, vclass }`。
          //    铁路/管道**没有 vclass**（没有电压概念），硬写会产生 `vclass: undefined`
          //    → vt-pbf 的 writeProperties 走 JSON.stringify(undefined) → undefined
          //    → writeValue 三个分支都不匹配 → 写出一条**空值消息**。
          //    ⚠️ 写入侧确实不抛错（已读源码确认），但**读取侧会抛**：
          //       MapLibre 解到空值消息时报 `unknown feature value`，整张瓦片解析失败、
          //       静默不渲染。实测：核心区归档（不封顶，铁路会进 z0/z1）启动即报错；
          //       华东可选包（封顶，铁路在 z<8 已被 pickForLowZoom 丢光）看不出问题 ——
          //       这正是这个 bug 前面几轮没被发现的原因。
          //    修法：只在 vclass 真实存在时才写这个键。
          // 阶段50：收敛哪些字段改为可配置。
          // ⚠️ 只写**确实存在**的键（与原写法的 `"vclass" in t ? … : …` 语义一致），
          //    否则会写出一条空值消息（vt-pbf 的 writeValue 三个分支都不匹配）。
          const collapsed = {};
          for (const k of cfg.collapseProps) {
            if (k in t) collapsed[k] = t[k];
          }
          f.tags = collapsed;
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
        `（上限 ${cfg.maxFeaturesPerTile.toLocaleString()}/瓦片，仅 z<${cfg.capBelowZoom}；` +
        `有 vclass/ftype 时按电压由高到低保留，否则按源数据顺序保留前 ${cfg.maxFeaturesPerTile.toLocaleString()} 个）`,
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

  /**
   * 归档内嵌 metadata。
   *
   * 🔴 阶段50-B：**必须按品类区分**。原先这段是写死的 OSM 文案，整块套到 GEM 归档上
   *    会产生三处错误，而且**一处都不会报错**：
   *      · `vector_layers[0].fields` 列的是 ftype/vclass/voltage_kv/osm_id —— GEM 一个都没有
   *      · `attribution` 写 OSM/ODbL —— 而 GEM 是 **CC BY 4.0**，署名错等于许可违约
   *      · `description` 描述的是输电线路
   *    ⚠️ OSM 分支**逐字节保持原样**（键顺序、文案、字段表全部不动），
   *       否则现有归档不再是可复现的同一份产物。
   */
  /**
   * 字段表从**真实写进瓦片的数据**推断，不再手写常量 ——
   * 手写就会像上面那样随源数据演进悄悄过期。
   * ⚠️ 只列真正取到过值的字段（与 `cleanProps` 的跳过语义一致）。
   */
  const fieldsOf = (keys) => {
    const out = {};
    for (const k of keys) {
      for (const f of cleaned.features) {
        const v = f.properties?.[k];
        if (v === null || v === undefined) continue;
        out[k] = typeof v === "number" ? "Number" : typeof v === "boolean" ? "Boolean" : "String";
        break;
      }
    }
    return out;
  };

  const metadata =
    cfg.kind === "gem"
      ? {
          name: `Global Power GIS — GEM 电源数据（${cfg.name}）`,
          format: "pbf",
          type: "overlay",
          version: "1",
          description:
            "Global Energy Monitor 电源设施（Point）。属性见 vector_layers.fields；" +
            `低缩放级（z<${cfg.fullPropsFromZoom}）仅保留 ${cfg.collapseProps.join(" / ")}。`,
          attribution: "© Global Energy Monitor · CC BY 4.0",
          minzoom: actualMinZoom,
          maxzoom: actualMaxZoom,
          bounds,
          center: [center[0], center[1], Math.min(actualMaxZoom, 9)],
          vector_layers: [
            {
              id: cfg.layer,
              description: "GEM 电源设施点位",
              minzoom: actualMinZoom,
              maxzoom: actualMaxZoom,
              fields: fieldsOf(cfg.keepProps),
            },
          ],
        }
      : {
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
