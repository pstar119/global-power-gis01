import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
// 阶段47：把「数据来源」链接交给系统默认浏览器打开。
// ⚠️ 这不是新增依赖：插件早已接线（lib.rs 已 init、capabilities 里的 opener:default
//    已含 allow-open-url + allow-default-urls，npm 包也一直在 package.json 里）。
import { openUrl } from "@tauri-apps/plugin-opener";
// 阶段26：读取随安装包分发的离线底图。
// convertFileSrc 把本地绝对路径转成 `asset://localhost/...`（实现了真正的 HTTP Range）；
// resolveResource 把相对资源路径解析成绝对路径（随安装包分发的 $RESOURCE 目录）。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { onPackInstalled, packKeyFromFile } from "../lib/packEvents";
import { resolveResource } from "@tauri-apps/api/path";
import type { FeatureCollection, LineString, Point } from "geojson";
// 仅用命名导入：maplibre-gl 的类型声明不提供 default export
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  ScaleControl,
  addProtocol,
  type GeoJSONSource,
  type LayerSpecification,
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { FUEL_FALLBACK_COLOR, FUEL_LEGEND, fuelColor, fuelLabel } from "../lib/fuel";
// 阶段50-B：只借类型，不引运行时。品类枚举的**唯一定义点**在 packs.ts，
// 避免 MapPage 这份本地 PackEntry 与共享版再漂移出一套自己的字面量。
import type { PackKind } from "../lib/packs";
// 阶段27：离线中文字形的 `font-faces` 清单（由 scripts/fetch_glyphs.mjs 生成）
import { BASEMAP_FONT_FACES, BASEMAP_FONT_FAMILY } from "../lib/basemapFonts.generated";
import {
  MAX_HIGHLIGHT_POINTS,
  buildBoundsSql,
  buildHighlightSql,
  viewportChanged,
  type ConversationTurn,
  type MapCommand,
  type ParsedQuery,
  type PlantFocus,
  type QueryContext,
  type ViewportBbox,
} from "../lib/nlq";
import { type Theme, onThemeChange, readTheme } from "../lib/theme";
import { downloadCsv } from "../lib/csvExport";
import MapQueryBox from "../components/MapQueryBox";
import StatsDashboard from "../components/StatsDashboard";
import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

/**
 * GEM 层在图层面板上的开关名（阶段48-A 引入，50-C.2-A 改名）。
 *
 * ‼️ 50-C.2-A：`"GEM 煤炭数据"` → `"GEM 发电设施"`。
 *    理由：归档里的 `plant_type` 有 coal / oil-gas / bioenergy **三类**，
 *    叫“煤炭数据”会把油气、生物质两类说成煤，属**事实性错误**。
 *
 * ⚠️ 必须声明在 `LAYER_SWATCH` **之前** —— 那个表拿它当键。
 *    `const` 在模块求值阶段有暂时性死区，声明顺序反了会在**运行时**直接抛
 *    `Cannot access 'GEM_PLANT_LAYER_NAME' before initialization`，
 *    而 TypeScript **查不出来**（它只做类型检查，不关心求值顺序）。
 */
const GEM_PLANT_LAYER_NAME = "GEM 发电设施";

/**
 * 阶段50-C.2-A：**旧的开关名**，只为迁移保留，**不参与渲染**。
 *
 * ‼️ 为什么不能删：「不要删除旧中文 key」。
 *    它可能已经外流到：旧版本的 `visibleLayers` 快照、外部链接/脚本、
 *    或未来加的「面板状态持久化」。只要它存在一天，就必须能被读懂。
 *    （本文件当前的 `visibleLayers` 是纯内存 state，**没有**持久化，
 *      所以这条迁移今天只是防御性的 —— 但一旦加持久化就是必需的。）
 */
const GEM_PLANT_LAYER_NAME_LEGACY = "GEM 煤炭数据";

/**
 * 阶段50-C.3-A：**旧开关名 → 当前开关名** 的迁移表。
 *
 * ‼️ 方向与 C.2-A 的旧表相反（那时是「当前 → 旧」、在每个读取点反查）。
 *    改成这个方向后，`normalizeLayerKeys` 在入口一次转换就完事，
 *    下游（`visibleLayers.includes(...)` / 面板 / `LAYER_SWATCH`）
 *    再也不需要知道存在旧名。
 */
const LAYER_KEY_MIGRATIONS: Record<string, string> = {
  [GEM_PLANT_LAYER_NAME_LEGACY]: GEM_PLANT_LAYER_NAME,
};

/**
 * 阶段50-C.3-A：把一份图层开关列表**规范化**。
 *
 * 做两件事：
 *   ① 旧 key → 当前 key（查 `LAYER_KEY_MIGRATIONS`）
 *   ② 去重（新旧 key 同时出现时会撞成两项）
 *
 * ‼️ 为什么必须有这一层：只要 `visibleLayers` 里残留一个旧 key，
 *    `includes(GEM_PLANT_LAYER_NAME)` 就会**静默**返回 false ——
 *    表现为「面板里开关是打开的、地图上却什么都没有」。不报错、不警告。
 */
function normalizeLayerKeys(names: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const next = LAYER_KEY_MIGRATIONS[name] ?? name;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

/**
 * 图层开关左侧色块的颜色 —— 让开关本身充当图例，不必再单独解释一遍。
 * 电厂用渐变表示「按燃料多色」，而不是给一个会误导人的单色。
 */
const LAYER_SWATCH: Record<string, string> = {
  电厂: "conic-gradient(#9aa0a6, #f5a524, #4daafc, #5ee39b, #b07cf5, #9aa0a6)",
  变电站: "#3fd0c9",
  输电线路: "#8b96a8",
  // 阶段48-A / 50-C.2-A：GEM 层是**实心彩色圆**，按 `plant_type` 三色
  //    （coal / oil-gas / bioenergy，见 addGemPlantLayers 的 `gemFuelColor`）。
  //    所以色块用 conic 三色饼：既表达了「三种燃料」，又是地图上填色的直接缩略。
  //    ‼️ 50-C.2-A 之前这里还要写一大段解释「空心环 vs 三色饼」的矛盾 ——
  //       圆改成实心后，图例与地图不再打架，那段解释随之删除。
  [GEM_PLANT_LAYER_NAME]: `conic-gradient(${fuelColor("Coal")} 0 33.3%, ${fuelColor("Gas")} 33.3% 66.6%, ${fuelColor("Biomass")} 66.6% 100%)`,
};

/**
 * 阶段48-A：GEM（Global Energy Monitor）发电设施数据层。
 *
 * ‼️ 与 WRI 是**两个独立数据源**，不是替换关系：
 *    · WRI = 电站级、只有在运、全球全燃料
 *    · GEM = 电站级聚合、含拟建/在运/退役/取消的**全生命周期**
 *    两边现在都是实心圆（GEM 略大一圈），所以同位置会看到「大圆套小圆」。
 *    ⇒ 阶段50-C.2-A 起不再有「实心点 + 空心环」那种形状区分 ——
 *      两个数据集靠 **颜色 + 大小 + 透明度** 区分，这是本次迁移有意的取舍。
 *
 * ‼️ **默认关闭**（不在 visibleLayers 初始值里）：归档实测 14,793 个点，
 *    默认打开会压住用户真正想看的东西。另外它还带来一个好处 ——
 *    数据是**首次开启时才加载**的，不开的用户不会为它付任何开销。
 *
 * 许可：CC BY 4.0（要求署名，见弹窗与数据源 attribution）。
 *
 * ⚠️ 阶段50-C.1 / C.2-A：GEM 的**通道 id 只剩 `GEM_PLANT_SOURCE` 这一个**
 *    （同段后面还有署名串与许可 URL 两个非 id 常量）。
 *    原来的 `gem-coal` GeoJSON 源、`gem-coal-rings` 与 `gem-coal-planned-halo`
 *    两个图层已整体删除 —— GEM 现在只有**一条**通道：PMTiles vector。
 *    那两个图层原本承担的填色/线宽/双环编码，已全部由
 *    `addGemPlantLayers` 里那一个 circle 图层接管。
 */
const GEM_PLANT_SOURCE = "gem-pmtiles";
const GEM_PLANT_ATTRIBUTION = "GEM 发电设施 © Global Energy Monitor CC BY 4.0";
const GEM_PLANT_LICENSE_URL = "https://globalenergymonitor.org/creative-commons-license/";

/** 状态中文名。只用实测到的 4 个值，不编造第五个。 */
const GEM_STATUS_LABEL: Record<string, string> = {
  operating: "在运",
  retired: "已退役",
  cancelled: "已取消",
  planned: "拟建/在建",
};

/**
 * 阶段50-C：GEM 的 **PMTiles** 通道（**唯一**通道）。
 * ‼️ 旧的 GeoJSON/SQLite 通路（建图期空源 + `loadGemPlants()` + `setData` 注入）
 *    已在 50-C.0 / 50-C.1 删除 —— 两者**不再并存**。
 *
 * ‼️ 阶段50-C 自审更正：旧版这里写的是「id 全部另起一套、不复用 `GEM_PLANT_*`，
 *    因为两者是两条独立的数据通路」—— **该说法已失效**：
 *      · 50-C.1 删掉旧通道后 GEM 只剩**一条**通路（与本文件上方的说明互相矛盾）；
 *      · `gemPmtilesSourceId()` **就是直接返回 `GEM_PLANT_SOURCE`**，并没有另起一套。
 *    现在真正“另起一套”的只有 `source-layer` —— 那是归档内部的 MVT 图层名，
 *    由切片器决定，与 MapLibre 样式里的 source/layer id 是**两回事**。
 *
 * ⚠️ `GEM_PMTILES_SOURCE_LAYER` 必须与切片时 `--kind gem` 的 `--layer` 一致。
 *    实测（把归档解开逐层打印）：`build_pmtiles.mjs --kind gem` 产出的归档里
 *    唯一的 MVT 图层名就是 `gem`。写错了**不会报错** —— source-layer 对不上时
 *    MapLibre 只是「什么都不画」，是典型的静默失败。
 *
 * ⚠️ 图层 id 用固定值而不是 `--<key>` 后缀：GEM 是**单一全球包**，
 *    加后缀会变成 `gem-plants--gem-plants` 这种毫无意义的 id。
 */
const GEM_PMTILES_SOURCE_LAYER = "gem";

/**
 * 阶段50-B：GEM 的 source id / layer id **统一走函数出口**（不再直接引常量）。
 *
 * ⚠️ 无参数 —— GEM 在清单里只会有 ≤ 1 条 `kind: "gem"`，所以 id 不加 key 后缀。
 *    将来真出现多个 thematic 包时，**只改这两个函数**即可，
 *    调用点已全部集中（addGemPlantLayers / removeGemPlantLayers / 生命周期 effect / 开关 effect）。
 *
 * ‼️ 与 `source-layer` 是两回事，不要混：
 *    · 这里是 **MapLibre 样式里的 source / layer id**（自己起的名）
 *    · `source-layer` 是**归档内部的 MVT 图层名**，必须是 `"gem"`，
 *      且必须与 `build_pmtiles.mjs --kind gem` 的 `--layer` 一致
 *    · 归档里的 MVT 图层名**不是** `gem-plants`（那是本地文件名的部分，
 *      旧归档用过这个名字，但当前 builder 输出的是 `gem`）
 */
function gemPmtilesSourceId(): string {
  // ‼️ 阶段50-C.1：直接引常量，不再写第二个字面量 ——
  //    两处各写一遍时，改一处漏一处会让“新增 vector 源”与“删旧 geojson 源”
  //    落在不同的 id 上，而那种错误是**静默**的（图层只是什么都不画）。
  return GEM_PLANT_SOURCE;
}

/** GEM 的 MapLibre 图层 id（注意：不是 source-layer，见上方说明） */
function gemPlantsLayerId(): string {
  return "gem-plants";
}

/**
 * 阶段26：真实离线底图。
 *
 * 文件由 `node scripts/fetch_basemap.mjs` 从 Protomaps 公开的行星 PMTiles 归档里
 * 切出（全球 z0-z4 + 中国中东部 z5-z8，实测 1107 个瓦片 / 31.76 MB），
 * 并已加入 `.gitignore`（可完整重建的派生产物，不进 Git）。
 *
 * 🔴 为什么必须用 Tauri 的 asset 协议，而不是 `public/` 下的相对路径：
 * 32 MB 的归档**绝不能整包读进内存**，pmtiles 必须能按需发 HTTP Range 请求。
 * 阶段11 实测 `public/` 下的文件由 `tauri.localhost`（内嵌资源协议）提供，
 * 而它**不实现 Range**：收到 `Range: bytes=0-16383` 仍返回 200 + 全量正文，
 * 且不带 Content-Length / Content-Range。pmtiles 的 FetchSource 会据此判定
 * 「后端不支持字节服务」并抛错，表现为底图只剩一层近黑的背景色。
 * `asset.localhost` 是为本地文件设计的协议，实现了真正的 Range。
 */
const BASEMAP_RESOURCE = "maps/basemap.pmtiles";

/** 底图数据源 id */
const BASEMAP_SOURCE = "basemap";

/**
 * 地名标签图层 id。
 * 它必须压在所有电力图层（线路/变电站/电厂/聚合/高亮）**之上**，
 * 否则 3.5 万个电厂点会把文字盖得看不见 —— 建图后在 load 回调里用 moveLayer 提到最顶。
 */
const BASEMAP_LABEL_LAYER_ID = "basemap-place-labels";

/**
 * ⚠️ 底图是 Protomaps 的 ODbL Produced Work，**署名 OpenStreetMap 是法律要求**，
 * 这段文字不能删。它与 WRI 电厂数据的署名分开挂：底图挂底图源，
 * WRI 的 CC BY 4.0 署名挂到电厂数据源上（见 PLANTS_SOURCE 的 addSource）。
 */
const BASEMAP_ATTRIBUTION =
  "底图 © Protomaps (ODbL) · © OpenStreetMap contributors";

/** 无法加载底图时给用户的提示（文件缺失 / 协议不支持 Range） */
const BASEMAP_MISSING_NOTICE =
  "未找到离线底图，地图只显示背景色。请先运行 node scripts/fetch_basemap.mjs 生成底图。";

const INITIAL_CENTER: [number, number] = [0, 20];
const INITIAL_ZOOM = 1.5;

/** 必须与 src-tauri/src/lib.rs 里的 DB_URL 一致 */
const DB_URL = "sqlite:global_power_gis.db";

/** 电厂数据源 id（聚合图层与单点图层共用同一个 source） */
const PLANTS_SOURCE = "power-plants";
/** 聚合圆的图层 id */
const CLUSTER_LAYER_ID = "power-plant-clusters";
/** 单个电厂的图层 id */
const PLANT_LAYER_ID = "power-plant-points";

/**
 * 高亮图层的 source / layer id。
 * ⚠️ 它必须是**独立的数据源**且 `cluster: false`：主数据源开了聚合，
 *    在聚合级别下单个点根本不存在，也就无从高亮；而 cluster 是 source
 *    创建时的属性，无法动态开关。
 */
const HIGHLIGHT_SOURCE = "highlight-points";
const HIGHLIGHT_LAYER_ID = "highlight-points";

/**
 * 阶段21：变电站与输电线路。
 *
 * ⚠️ 图层堆叠顺序很关键：输电线路必须加在**点图层之下**，
 *    否则灰色线条会横穿彩色电厂点与变电站点，视觉噪声极大。
 *    实际顺序由 addLayer 的调用次序决定（后加的在上面），
 *    即：底图 → OSM 输电线路 → OSM 变电站 → 演练数据（现为空）→ 电厂 → 聚合 → 高亮 → 地名标签。
 */
const SUBSTATIONS_SOURCE = "substations-data";
const SUBSTATIONS_LAYER_ID = "substation-points";
const LINES_SOURCE = "transmission-lines-data";
const LINES_LAYER_ID = "transmission-lines";

/**
 * 输电线路的「点击热区」图层。
 *
 * 视觉线宽只有 1~2.6px，鼠标几乎点不中。这里在同一条线之上再叠一层
 * **完全透明**的粗线（14px）专门用来接事件 —— 把「视觉表现」与「命中区域」
 * 解耦，既不用为了可点击而把线画粗（会破坏按电压分级的视觉设计）。
 *
 * MapLibre 的命中测试只看图层是否 visible、要素是否在视口内，**不看透明度**，
 * 所以 line-opacity: 0 依然能收到 click。
 */
const LINES_HIT_LAYER_ID = "transmission-lines-hit";
const LINES_HIT_WIDTH = 14;

/** 变电站统一用青蓝色（不按电压上色：燃料配色盘已被 15 种燃料占满，再加一套会和图例打架） */
const SUBSTATION_COLOR = "#3fd0c9";
/** 输电线路用中性灰，在 #101418 深底上可见但不抢眼 */
const LINE_COLOR = "#8b96a8";

/**
 * 阶段28：真实 OSM 电网数据（上海小样本）。
 *
 * 数据来源分两级（阶段29 起）：
 *   1. **首选：本地 PMTiles 归档**（`resources/maps/osm_grid.pmtiles`）。
 *      长三角量级的要素（上万条线路、几十万个坐标点）如果全量驻留内存，
 *      首帧和每次 relayout 都会卡；切成矢量瓦片后交给 MapLibre 按需 Range 读取，
 *      与底图走同一条通路。
 *   2. **回退：小样本 GeoJSON**（`public/osm/smoketest_power.geojson`）。
 *      归档缺失时（新克隆还没跑切片脚本）退回它，前端不至于一片空白。
 *      GeoJSON 走 fetch，`connect-src 'self'` 已覆盖，不需要 asset 协议；
 *      （`asset` 协议管的是「前端包之外的本地文件」，两条路别混。）
 * 两种来源用**完全相同的图层 ID 与 filter 语义**，切换对上层开关无感。
 */
const OSM_SOURCE = "osm-grid";
/** 首选来源：本地 PMTiles 归档（scripts/build_pmtiles.mjs 生成） */
const OSM_GRID_RESOURCE = "maps/osm_grid.pmtiles";
/** 归档里的 MVT 图层名，必须与 build_pmtiles.mjs 的 --layer 一致 */
const OSM_GRID_SOURCE_LAYER = "grid";
/** 回退来源：上海小样本 */
const OSM_DATA_URL = "/osm/smoketest_power.geojson";
const OSM_ATTRIBUTION = "电网数据 © OpenStreetMap contributors (ODbL)";

/**
 * 线路按电压分档：**一个 source、每个档位一个图层**。
 *
 * 为什么不是「一个图层 + match 表达式上色」：下一阶段要加「电压等级复选框列表」，
 * 分档独立成层时开关只需 setLayoutProperty，而用 match 的话得改 filter 表达式，
 * 复杂度高且容易写错。层级多一点换来开关实现简单，这笔买卖划算。
 *
 * 线宽按 zoom 插值（z11 起达到标称值），否则低级别 3px 的线会把整片区域糊死。
 * `unknown` 单独一层且**默认隐藏** —— 实测 22% 的线路根本没有 voltage 标签，
 * 把它们归进任何一档都是误导；留给用户主动勾选。
 */
const OSM_LINE_TIERS: ReadonlyArray<{
  id: string;
  vclass: string;
  color: string;
  width: number;
}> = [
  { id: "osm-line-735", vclass: "735+", color: "#e879f9", width: 3 },
  { id: "osm-line-500", vclass: "500-734", color: "#f59e0b", width: 2 },
  { id: "osm-line-220", vclass: "220-499", color: "#4daafc", width: 1.5 },
  { id: "osm-line-lt220", vclass: "<220", color: "#6b7280", width: 0.8 },
  { id: "osm-line-unknown", vclass: "unknown", color: "#8b96a8", width: 1 },
];

/**
 * 阶段40：线路图层的**加层顺序**（自下而上）。
 *
 * ‼️ 为什么必须存在这个数组：MapLibre 是**先加的在下**，
 *    而 `queryRenderedFeatures` / 绘制都只看得到上层。
 *    原先两个建层函数都直接遍历 `OSM_LINE_TIERS`（735+ → 500 → 220 → <220 → unknown），
 *    于是**最后加的 `<220` 画在最上面** —— 低电压灰线盖住了 735kV 粉线。
 *    对电网 GIS 来说这是画序颠倒：电压越高越该醒目。
 *
 * 反转后上层关系为：unknown < <220 < 220-499 < 500-734 < **735+（最顶）**。
 * ⚠️ 只改「加层先后」，**图层 id、filter、配色、线宽全部不变**。
 * ⚠️ `addOsmGridLayers` 与 `addPackLayers` **必须都用这个数组**，
 *    否则核心区与区域包的画序会不一致，接缝处会出现「同一条线两种层级」。
 */
const OSM_LINE_TIERS_BOTTOM_UP: readonly (typeof OSM_LINE_TIERS)[number][] = [
  ...OSM_LINE_TIERS,
].reverse();

/**
 * 阶段40：视野统计的自适应节流参数。
 *
 * 基准延迟 350ms（用户拍板的「300ms 一档」的量级）；
 * 一旦上一次统计耗时 >= 80ms，下一次延迟拉到 900ms ——
 * 即「热点区域里等用户真正停下来再算」。
 *
 * ⚠️ 这只是降低**发生频率**，不减少单次阻塞（实测单次可达 128.9ms）。
 *    要真正砍掉单次耗时，得减少「一次查询跨了多少个图层」——
 *    因为成本结构是「固定 34ms + 每要素 1.7µs」，固定部分占主导。
 */
const STATS_DEBOUNCE_MS = 350;
const STATS_SLOW_MS = 80;

/**
 * 阶段48：左侧「当前视野」列表里单独列出的燃料种类数，其余归并为「其他 N 类」。
 * 与看板的「只显示最常用的 6 类」同一个思路：长尾不占版面。
 */
const TOP_FUEL_ROWS = 5;
const STATS_SLOW_DEBOUNCE_MS = 900;
const OSM_SUBSTATION_LAYER_ID = "osm-substations";
const OSM_PLANT_LAYER_ID = "osm-plants";

/**
 * 阶段34：`osm-grid` 输电线路的**透明点击热区**图层 id。
 *
 * ⚠️ 为什么必须另建一层：视觉线宽在低缩放级别下会被收得很细
 *    （z4 只有标称值的 0.3 倍，735kV 档才 0.9px），拿视觉层当热区几乎点不中。
 * ⚠️ 它与阶段22 那个热区（`LINES_HIT_LAYER_ID`）**不是同一份数据**：
 *    那个绑在数据库 GeoJSON 演示线上，这个绑在真实 PMTiles 切片上 ——
 *    地图上看得见的彩色线是后者，这正是之前「看得见、点不着」的根因。
 */
const OSM_LINES_HIT_LAYER_ID = "osm-lines-hit";
/** 点击热区宽度（屏幕像素）：14px 鼠标/手指都能稳定命中，又不会误吞相邻线路 */
const OSM_LINES_HIT_WIDTH = 14;

/**
 * 阶段43：其他基础设施 —— 铁路干线 与 油气长输管道。
 *
 * 抓取口径（已实测、不是猜的）：
 *  铁路 `way[railway=rail]["service"!~"."]` —— 排除侧线/站线/场线。
 *      阶段43 实测（长三角 12 格全量）：侧线占 railway=rail 的 38.3% 条数、
 *      **70% 的坐标点数**。城市轨道（subway/light_rail/tram/...）**不入库**：
 *      用户判定地铁轻轨对电网骨干的视觉干扰大于价值（长三角为 2,999 条 / 73,452 点）。
 *  管道 `way[man_made=pipeline]["substance"~"^(gas|oil)$"]` —— 全量仅 85 条。
 *      ⚠️ 长三角油气总里程 2,540 km 里，单条「西气东输」占 2,378 km（93.6%），
 *      所以这个图层视觉上会是「一根横穿全国的线 + 少量短线」，属于数据本身特征。
 *
 * 两个图层都**默认关闭**（不在 visibleLayers 初始值里），且**置于电力图层下方**：
 * 它们是背景参照物，不该与电压分级的线条争夺注意力。
 *
 * ‼️ 铁路用**虚线**是刻意的：只有虚线才能在低缩放级别下与四档电压线一眼可分，
 *    而且它不占用任何一档电压的颜色。
 */
const OSM_RAILWAY_LAYER_ID = "osm-railways";
/**
 * 铁路展示色：**低饱和中性灰**。
 * 它必须既能当背景参照物，又绝不能与四档电压色争注意力；配合
 * `line-dasharray`（见 addRailwayLayer）在低缩放级别下与电压线一眼可分。
 */
const OSM_RAILWAY_COLOR = "#9c9c9c";
const OSM_PIPELINE_LAYER_ID = "osm-pipelines";
/**
 * 管道展示色：**低饱和暗紫**。
 * 与铁路同属「背景基础设施」，刻意避开任何一档电压色，也不使用高亮色。
 */
const OSM_PIPELINE_COLOR = "#b98c9f";

/** 面板上的两个开关名。刻意**不并进 `LAYERS`** —— 那个数组同时是「默认可见」清单。 */
const INFRA_LAYERS = ["铁路", "油气管道"] as const;
const INFRA_SWATCH: Record<string, string> = {
  铁路: OSM_RAILWAY_COLOR,
  油气管道: OSM_PIPELINE_COLOR,
};

/**
 * 阶段45：图层面板的**分组制**。
 *
 * ❗ 折叠是**纯 UI 行为** —— 收起一个组不会改变任何图层的可见性。
 *    否则用户收起「基础设施」时铁路会跟着消失，看起来像 bug。
 *
 * ⚠️ 用户描述里说「四个组」但只列了三个（电力设施 / 基础设施 / 环境与底图），
 *    这里按**实际列出的三个**实现。电压分级被归入「电力设施」组内，
 *    因为它本来就是输电线路的子项，单独成组会与主开关重复。
 */
interface LayerGroupDef {
  id: string;
  label: string;
  /** 默认是否展开 */
  defaultOpen: boolean;
  /** 预留分组：只显示说明文字，不含真实开关 */
  placeholder?: string;
}
const LAYER_GROUPS: readonly LayerGroupDef[] = [
  { id: "power", label: "电力设施", defaultOpen: true },
  { id: "infra", label: "基础设施", defaultOpen: false },
  {
    id: "env",
    label: "环境与底图",
    defaultOpen: false,
    placeholder: "后续接入：洪水风险区、数据中心等上下文图层。",
  },
];

/**
 * 阶段39：区域数据包（可选包）—— 按视口动态加载。
 *
 * 背景：全国 7 个大区被切成 7 个独立归档（`data/packs/osm-<region>.pmtiles`，共 116 MB），
 * **刻意不进安装包**（否则安装包从 ~54 MB 涨到 ~170 MB）。它们由
 * `scripts/install_packs.mjs` 投放到 `$RESOURCE/packs/`，靠 asset 协议按 Range 读取。
 *
 * 三条已定的策略（每条都有代价，记在这里免得以后被"优化"掉）：
 *  1. **核心区优先**：视口中心落在核心区覆盖矩形内时，只显示核心区包（随安装包分发的那份），
 *     不叠加区域包。代价：长三角用不到华东包更全的数据（93,559 对 25,611 要素）。
 *     换来的是行为可预期 —— 打开就有数据，不依赖用户是否装了可选包。
 *  2. **z ≥ 6 才加载**：更低缩放时视口覆盖半个中国，此时"按重叠面积取前 2 个"会让用户
 *     看到 2 个区域有数据、其余空白，看起来像坏了。低缩放保持现状。
 *  3. **同时最多 2 个**：每个包 = 1 个 source + 7 个图层。上限 2 → 最多 14 个额外图层。
 *     不能再多，MapLibre 的样式规模与每帧查询开销都会明显上升。
 *
 * ⚠️ 区域包之间**存在重叠**（已实测：华东与华北在鲁冀交界的瓦片逐字节相同，
 *    都在 z12/3388/1595）。MapLibre 的 vector source 不支持按 bbox 裁剪，
 *    所以同时激活两个包时，接缝处会重复绘制 —— 同色同位置，视觉无差异，
 *    代价只是多一倍瓦片请求。这是取舍，不是 bug。
 */
interface PackEntry {
  key: string;
  label: string;
  provinces?: string;
  bbox: [number, number, number, number];
  file: string;
  features?: number | null;
  sizeMb?: number | null;
  /**
   * 阶段50-B：数据包品类 —— **按生命周期分**，不是按内容分。
   *
   * · `"region"` / 缺省 —— 区域包：按视口选举、最多 2 个、随视野增删（MVT 图层名 `grid`）
   * · `"gem"`             —— thematic / global overlay：全球单一图层，
   *                          由图层开关控制，**不参与视口选举**（MVT 图层名 `gem`）
   *
   * ⚠️ 类型是**可选的**（不是需求里写的必填）：旧清单没有这个字段，
   *    而它又是从 `res.json()` 强转过来的 —— 标成必填不会阻止任何东西，
   *    只会让“缺省”这个真实存在的情况在类型上不可表达。
   *    运行时一律用 `=== "gem"` 判定，缺失自然落到 region 分支。
   */
  kind?: PackKind;
}
interface PacksManifest {
  core: { label: string; resource: string; bbox: [number, number, number, number] };
  packs: PackEntry[];
}

const PACKS_MANIFEST_URL = "/packs_manifest.json";
/** 低于该级别不加载区域包 */
const PACK_MIN_ZOOM = 6;
/** 同时激活的区域包上限 */
const PACK_MAX_ACTIVE = 2;

/**
 * 区域图层 id：在原 id 后加 `--<region>` 后缀。
 * ‼️ **现有图层 id 一个都不改** —— 只是给区域包新增带后缀的平行图层。
 *    这样阶段29~38 关于 `osm-line-735` 等 id 的全部结论仍然成立。
 */
function packLayerId(base: string, key: string): string {
  return `${base}--${key}`;
}

/** 一个区域包对应的全部图层 id（配色与 filter 与核心区完全一致） */
function packLayerIds(key: string) {
  return {
    lines: OSM_LINE_TIERS.map((t) => packLayerId(t.id, key)),
    substations: packLayerId(OSM_SUBSTATION_LAYER_ID, key),
    plants: packLayerId(OSM_PLANT_LAYER_ID, key),
    railways: packLayerId(OSM_RAILWAY_LAYER_ID, key),
    pipelines: packLayerId(OSM_PIPELINE_LAYER_ID, key),
    hit: packLayerId(OSM_LINES_HIT_LAYER_ID, key),
  };
}

/** 视口与包 bbox 的交集面积（度²）；0 表示不相交 */
function bboxOverlapArea(view: ViewportBbox, pack: readonly number[]): number {
  const [w, s, e, n] = pack;
  const ow = Math.max(view.minLon, w);
  const os = Math.max(view.minLat, s);
  const oe = Math.min(view.maxLon, e);
  const on = Math.min(view.maxLat, n);
  if (oe <= ow || on <= os) return 0;
  return (oe - ow) * (on - os);
}

/** 点是否落在矩形内（用于「视口中心是否已被核心区覆盖」的判定） */
function bboxContainsPoint(box: readonly number[], lon: number, lat: number): boolean {
  const [w, s, e, n] = box;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/**
 * 阶段30：电压分级开关的显示文案。
 * 键直接用 `vclass` 取值 —— 与 `OSM_LINE_TIERS`、以及瓦片属性一一对应，
 * 不需要任何映射表，也不会出现「开关名对不上图层」的错位。
 */
const TIER_LABEL: Record<string, string> = {
  "735+": "735kV 以上",
  "500-734": "500-734kV",
  "220-499": "220-499kV",
  "<220": "220kV 以下",
  unknown: "电压未知",
};

/** 全部分级的键（含 unknown） */
const LINE_TIER_KEYS: readonly string[] = OSM_LINE_TIERS.map((t) => t.vclass);

/**
 * 默认开启的分级。
 *
 * - 「电压未知」默认关闭：实测长三角有 7,917 条线路没有 `voltage` 标签（约 35%），
 *   把它们归进任何一档都是误导，所以单独一档、留给用户主动勾选。
 * - 「220kV 以下」阶段40 起也**默认关闭**（用户拍板）。两个依据：
 *   1. UX：它要素最多、在全局视角下干扰视线，低压线路本来也不是看图时的重点。
 *   2. 实测（已用 CDP 在同一热点对照 6 次取均值）：
 *      开着 77.3ms / 线路段 21,513；关掉 65.2ms / 线路段 13,888。
 *      即**要素数 −35%、耗时 −16%**。
 *      ⚠️ 省下的耗时远小于要素降幅，说明成本结构 ≈ 固定开销 34ms + 每要素 1.7µs，
 *      **固定部分才是大头**，单靠关这一档治不了本。若日后要继续压，
 *      应先攻「一次查询跨了多少个图层」，而不是继续减要素。
 */
const DEFAULT_ON_TIERS: readonly string[] = OSM_LINE_TIERS
  .filter((t) => t.vclass !== "unknown" && t.vclass !== "<220")
  .map((t) => t.vclass);

/** 归档与小样本都拿不到时的提示 */
const OSM_MISSING_NOTICE =
  "未找到 OSM 电网数据。生成顺序：python scripts/fetch_osm_power.py --preset yrd → " +
  "node scripts/prepare_osm_geojson.mjs --name yrd → node scripts/build_pmtiles.mjs --name yrd";

/** 只拿到了小样本时的提示（不是错误，但要说清楚数据范围） */
const OSM_FALLBACK_NOTICE =
  "未找到离线电网瓦片（osm_grid.pmtiles），当前只显示上海小样本。" +
  "运行 node scripts/build_pmtiles.mjs 可切出长三角全量瓦片。";

/**
 * 执行查询后的最低缩放级别。
 *
 * fitBounds 只能限制 maxZoom，**没有 minZoom**。而「全球前10大电厂」
 * 这类结果本就散布在全球，bbox 会撑到接近整个地球，fitBounds 算出来的
 * 级别很低 —— 点是看见了，但容量差异（半径分级）在那一级几乎看不出来。
 * 所以在飞行结束后兜一次底。
 */
const MIN_COMMAND_ZOOM = 2.2;

/** 阶段32：点击结果行定位时的目标缩放（只放大不缩小，见 applyCommand 的 focus 分支） */
const FOCUS_ZOOM = 11;

/** Popup 里展示的字段（来自 GeoJSON properties） */
type PlantProperties = {
  name: string;
  country: string | null;
  capacity: number | null;
  fuel: string | null;
  color: string;
  /**
   * 阶段46：由迁移 006 + 重新导入 WRI 提供的元数据。
   * ⚠️ 全部为可选：老库（未重跑导入）里这几列是 NULL，
   *    而且旧版的 GeoJSON 属性里根本没有这几个键。
   */
  year?: number | null;
  owner?: string | null;
  source?: string | null;
  /** 阶段47：该条记录的原始出处链接（用于渲染可点击的「数据来源」） */
  url?: string | null;
};

/** 变电站要素的属性。voltage 参与半径分级，缺失时为 0（落在 step 第一档）。 */
type SubstationProperties = {
  name: string;
  country: string | null;
  voltage: number;
};

/**
 * 输电线路要素的属性。
 *
 * ⚠️ 字段名必须与**数据来源**对齐，这里要同时兼容两条路径：
 *   · PMTiles 切片（`scripts/build_pmtiles.mjs` 的 keepProps）
 *     → `voltage_kv` / `vclass` / `line_kind` / `osm_id` / `name`
 *   · 数据库演示线（阶段22 的 SQL 已把 voltage_kv 映射成 voltage）→ `name` / `voltage`
 *   🔴 曾经的 bug：只读 `props.voltage`，而真实切片里根本没有这个字段名
 *      （有的是 `voltage_kv`）⇒ 每条线路的 Popup 都显示「未知」。
 */
type LineProperties = {
  name?: string;
  /** PMTiles 路径：原始电压数值（kV） */
  voltage_kv?: number;
  /** 数据库演示线路径：已由 SQL 映射为 voltage */
  voltage?: number;
  /** 电压档位：735+ / 500-734 / 220-499 / <220 / unknown */
  vclass?: string;
  /** OSM 的 power=line / cable / minor_line 等 */
  line_kind?: string;
  osm_id?: string;
};

/** 线路类型 → 中文。OSM 里 power=line 是架空线、power=cable 是地下电缆。 */
const LINE_KIND_LABEL: Record<string, string> = {
  line: "架空线",
  cable: "电缆",
  minor_line: "分支线",
};

function formatLineKind(kind?: string): string {
  if (!kind) return "未提供";
  return LINE_KIND_LABEL[kind] ?? kind;
}

/**
 * 阶段46：字段缺失时的**统一**占位符。
 *
 * ⚠️ 为什么全应用只留一个常量：此前缺失值有三种写法（"未提供" / "未知" / 空串），
 *    用户无法区分「数据源没填」与「我们渲染丢了」。统一成 "--" 后语义唯一：
 *    **这个字段没有值**，且它不会被当成 0 参与任何求和。
 */
const MISSING = "--";

/**
 * 阶段47：只有 http/https 才允许变成可点击链接。
 *
 * `url` 来自外部数据集（WRI 的 CSV），**必须当作不可信输入**：
 * 上游被污染或录入错误时可能混进 `javascript:` / `file:` 这类协议。
 * Tauri 的 opener 插件本身有 `allow-default-urls` 兜底（只放行 mailto/tel/http/https），
 * 但**在渲染层再挡一道** —— 这样即使将来为了别的功能放宽插件权限，
 * 这里也不会变成一个漏洞。校验不过就退回纯文本，不报错、不丢字段。
 */

/**
 * 阶段47-1：**已知失效的来源站点**（实测确认，不是猜测）。
 *
 * `endcoal.org` 曾长期是 Global Coal Plant Tracker (GCPT) 的官网。实测
 * （2026-09-16）：该域名已过期，访问会 302 到 `/lander` —— **GoDaddy 的域名停放页**
 * （页面上写着「免费停放，由 GoDaddy.com 提供。获得此域名」）。
 * 也就是说，点了「数据来源」的用户会看到一个卖域名的页面。
 *
 * ‼️ 这里**只做降级、不做映射**（用户拍板）：不会把 GCPT 改指到 GEM 或任何别处 ——
 *    WRI 记录的出处确实就是当年的 endcoal.org，改指别处等于篡改数据溯源的真实性。
 *    命中本名单的 URL 一律退回**纯文本**，标签文字原样保留。
 *    也**不为此引入域名映射表**：这里只有「哪些站点已经死了」这一个事实。
 *
 * 📊 影响面实测（2026-09-16，全库 34,936 座；带链接记录 34,039 条）：
 *    `endcoal.org` 共 1,100 条（3.2%），且与 `source='GCPT'` 的记录
 *    **完全重合**（1100 = 1100，双向一致）⇒ 其余 96.8% 的溯源链接照旧可点。
 *
 * ⚠️ 按**主机名**而不是按 source 标签判断：将来 WRI 若把 url 修好指向新站，
 *    链接会自动恢复可用，不需要再动代码。
 */
const DEAD_SOURCE_HOSTS: readonly string[] = ["endcoal.org"];

function safeSourceUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;

  // 阶段47-1：已知失效的站点 → 退回纯文本（原因见 DEAD_SOURCE_HOSTS 上方注释）
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (DEAD_SOURCE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return undefined;
  }
  return trimmed;
}

/**
 * 用原生 DOM 构建 Popup 内容。
 *
 * ⚠️ 刻意**不用 `setHTML()`**：电厂名称来自外部数据集，拼 HTML 字符串会有
 *    注入风险。这里一律走 `textContent`（由浏览器自动转义）。
 * ⚠️ 样式用 CSS Modules 的类名（它在运行时就是个字符串），因此 Popup 的
 *    外观与其它悬浮面板完全一致，不需要为它另写一套全局 CSS。
 */
function buildPlantPopup(
  props: PlantProperties,
  point?: readonly [number, number],
): HTMLElement {
  return buildPopupFrame(
    props.name,
    "未命名电厂",
    [
      { label: "国家/地区", value: props.country || MISSING },
      {
        label: "燃料类型",
        value: props.fuel ? fuelLabel(props.fuel) : MISSING,
        // 燃料那一行在文字前加一个与地图同色的色块，和图例形成呼应
        swatch: props.fuel ? props.color : undefined,
      },
      {
        label: "装机容量",
        value: props.capacity == null ? MISSING : `${props.capacity} MW`,
      },
      // 阶段46：以下三行是本次新增的「多行详情」。
      // ‼️ 年份与所有者由迁移 006 + 重跑导入提供；
      //    尚未回填时一律显示 "--"，而**不是**「未知」或直接隐藏。
      //    理由："--" 能分清「数据没填」与「我们没导入」；
      //    兜底成「未知」会把后者伪装成前者，正是这次要修的 bug 的隐藏方式。
      {
        label: "投产年份",
        value: props.year == null ? MISSING : `${props.year} 年`,
      },
      { label: "所有者", value: props.owner || MISSING },
      {
        label: "坐标",
        value: point ? formatLngLat(point as [number, number]) : MISSING,
      },
      // 阶段47：数据来源做成**可点击链接**（交给系统默认浏览器打开）。
      // 专业 GIS 的溯源能力：看到一条数据要能一路点回原始出处。
      // 这也正是 WRI 的 CC BY 4.0 署名要求落到界面上的形态。
      // ⚠️ 取不到合法 URL 时只渲染纯文本，不会变成一个点不动的死链接。
      {
        label: "数据来源",
        value: props.source || MISSING,
        link: safeSourceUrl(props.url),
      },
    ],
  );
}

/** 变电站 Popup：名称 / 国家 / 电压等级 */
function buildSubstationPopup(props: SubstationProperties): HTMLElement {
  return buildPopupFrame(props.name, "未命名变电站", [
    { label: "国家/地区", value: props.country || "未知" },
    { label: "电压等级", value: formatVoltage(props.voltage), swatch: SUBSTATION_COLOR },
  ]);
}

/**
 * 从线要素里取出**一条**折线的坐标。
 *
 * ⚠️ 切片里的线可能是 `LineString`，也可能是 `MultiLineString`（实测两者都有）。
 *    只认 LineString 的后果是：多段线**静默点不到**（点了没反应，也不报错），
 *    而且拿多段线去算锚点会得到 NaN。
 *    MultiLineString 取**最长的那一段**作为代表，起点/终点/弹窗锚点都用它。
 */
function longestLineCoords(geometry: {
  type: string;
  coordinates?: unknown;
}): Array<[number, number]> {
  const asLine = (v: unknown) => v as Array<[number, number]>;
  if (geometry.type === "LineString") {
    return asLine(geometry.coordinates);
  }
  if (geometry.type === "MultiLineString") {
    const parts = (geometry.coordinates as unknown[]).map(asLine);
    let best: Array<[number, number]> = [];
    for (const part of parts) {
      if (part.length > best.length) best = part;
    }
    return best;
  }
  return [];
}

/**
 * 阶段36：把 MapLibre 的弹窗元素从地图容器搬到 `.viewport` 这一层（与左侧面板同级）。
 *
 * ⚠️ 为什么不能只给弹窗加 z-index：`.mapContainer` 是 `position:absolute; z-index:0` ——
 *    它自己就是一个**堆叠上下文**，作为它后代的弹窗 z-index 再大，也只能在这个上下文内部排序，
 *    永远压不过兄弟节点上的浮动面板（`.layerPanel` z-index:1、AI 工作台 z-index:2）。
 *    反过来把 `.mapContainer` 提到面板之上也不行：不透明的画布会把面板整个盖掉。
 * ⚠️ 为什么搬家不改位置：`.mapContainer` 是 `inset:0`，与 `.viewport` 的原点完全重合，
 *    所以 MapLibre 写在元素上的 `transform: translate(...)` 不需要任何换算。
 * 幂等：已经在目标父节点里就什么都不做；关闭时 MapLibre 自己 `remove()`，与父节点无关。
 */
function liftPopup(popup: Popup, overlay: HTMLElement | null | undefined): void {
  if (!overlay) return;
  const el = popup.getElement();
  if (el && el.parentElement !== overlay) overlay.appendChild(el);
}

/**
 * 输电线路 Popup：名称 / 电压等级 / 起止点。
 * 起止点从 geometry 的 LineString 坐标读取，不需要额外查询数据库。
 */
function buildLinePopup(
  props: LineProperties,
  coords: ReadonlyArray<[number, number]>,
): HTMLElement {
  const [start, end] = coords;
  // ⚠️ 两条数据路径的电压字段名不同，必须都认（见 LineProperties 的说明）
  const kv = props.voltage_kv ?? props.voltage ?? 0;
  const tier = props.vclass ? TIER_LABEL[props.vclass] : undefined;
  // 有精确值就「735 kV（735kV 以上）」，只有档位就显示档位，都没有才是「未知」
  const voltageText = kv ? `${kv} kV${tier ? `（${tier}）` : ""}` : (tier ?? "未知");

  const rows: PopupRow[] = [
    { label: "电压等级", value: voltageText, swatch: LINE_COLOR },
    { label: "线路类型", value: formatLineKind(props.line_kind) },
    { label: "起点", value: start ? formatLngLat(start) : "未提供" },
    { label: "终点", value: end ? formatLngLat(end) : "未提供" },
  ];

  // 标题兜底（用户拍板）：有 name 用 name；没 name 但有电压 → 「未命名线路」；
  // 两者都没有 → 「输电线路（电压未知）」
  const fallback = kv || tier ? "未命名线路" : "输电线路（电压未知）";

  return buildPopupFrame(
    props.name ?? "",
    fallback,
    rows,
    props.osm_id ? `OSM ID ${props.osm_id}` : undefined,
  );
}
/**
 * Popup 的一行：标签 + 值，可选的色块用于与图例呼应。
 * 阶段47：新增 `link` —— 该行会渲染成一个可点击按钮，点击后交给系统浏览器打开。
 */
type PopupRow = { label: string; value: string; swatch?: string; link?: string };

/**
 * 三种要素（电厂 / 变电站 / 输电线路）共用的 Popup 骨架。
 *
 * ⚠️ 一律走 `textContent`，**绝不用 `setHTML()`**。电厂名称来自外部数据集，
 *    拼 HTML 字符串会有注入风险；`textContent` 由浏览器自动转义。
 * ⚠️ 样式用 CSS Modules 的类名（运行时就是个字符串），所以 Popup 的外观
 *    与其它悬浮面板完全一致，不需要另写一套全局 CSS。
 */
function buildPopupFrame(
  title: string,
  fallbackTitle: string,
  rows: readonly PopupRow[],
  meta?: string,
): HTMLElement {
  const root = document.createElement("div");
  root.className = styles.popup;

  const heading = document.createElement("h3");
  heading.className = styles.popupTitle;
  heading.textContent = title || fallbackTitle;
  root.appendChild(heading);

  const list = document.createElement("dl");
  list.className = styles.popupList;

  for (const row of rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;

    const dd = document.createElement("dd");

    if (row.link) {
      // 阶段47：可点击的溯源链接。
      //
      // ⚠️ 为什么用 <button> 而**不是** <a href>：
      //    Tauri 的 WebView 里点 <a href="https://…"> 会让 **WebView 自己导航过去**
      //    （整个窗口变成那个网页，应用等于挂了）。而这里要做的是「交给系统浏览器打开」
      //    —— 那是一个**动作**，不是导航，所以语义上本来就该是 button。
      //    正文只显示短名（避免长 URL 撑破弹窗），完整 URL 放进 title 供悬停查看。
      const link = document.createElement("button");
      link.type = "button";
      link.className = styles.popupLink;
      link.textContent = `${row.value} ↗`;
      link.title = `在默认浏览器中打开：${row.link}`;
      link.addEventListener("click", (ev) => {
        // 阻断冒泡与默认行为：弹窗与地图同层，不阻断的话这次点击
        // 会再触发一遍地图的 click 处理（弹窗被换成另一个要素）。
        ev.preventDefault();
        ev.stopPropagation();
        void openUrl(row.link!).catch((err: unknown) => {
          console.error("[MapPage] 打开来源链接失败", err);
        });
      });
      dd.appendChild(link);
    } else {
      dd.textContent = row.value;
    }

    if (row.swatch) {
      const swatch = document.createElement("span");
      swatch.className = styles.popupSwatch;
      swatch.style.backgroundColor = row.swatch;
      dd.prepend(swatch);
    }

    list.append(dt, dd);
  }

  root.appendChild(list);

  // 阶段34：弱化的元信息（如 OSM ID），放 Popup 最底部，不与主信息抢注意力。
  // 专业 GIS 工具里带底层 ID 对排查数据问题很关键。
  if (meta) {
    const note = document.createElement("p");
    note.className = styles.popupMeta;
    note.textContent = meta;
    root.appendChild(note);
  }

  return root;
}

/** 电压等级文本。0 / null 表示数据缺失，不能显示成 "0 kV"。 */
function formatVoltage(kv: number): string {
  return kv ? `${kv} kV` : "未知";
}

/** 经纬度文本：[经度, 纬度] → "116.4000°E, 39.9000°N"。按半球标注而非直接带负号。 */
function formatLngLat([lon, lat]: [number, number]): string {
  const ew = lon >= 0 ? "E" : "W";
  const ns = lat >= 0 ? "N" : "S";
  return `${Math.abs(lon).toFixed(4)}°${ew}, ${Math.abs(lat).toFixed(4)}°${ns}`;
}

/**
 * MW → GW 文本，固定一位小数。
 * ⚠️ 口径必须与 `StatsDashboard.tsx` 里的 `formatGw` 一致，否则同一个数字
 *    在两个面板里显示成不同精度，用户会以为其中之一算错了。
 */
function formatGw(mw: number): string {
  return `${(mw / 1000).toLocaleString("zh-CN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GW`;
}

// ==========================================================
// 阶段41：OSM 点要素（变电站 / 电厂）的 Popup 与统一点击处理
// ==========================================================

/**
 * OSM 点要素的属性。
 *
 * ‼️ 字段白名单来自 `scripts/prepare_osm_geojson.mjs` 的 `KEEP_PROPS`：
 *    substation → osm_id / name / vclass / voltage_kv / substation_kind
 *    plant      → osm_id / name / vclass / voltage_kv / plant_source
 *
 * 🔴 本组类型与下面的构建器**只允许**读取表格里的自有字段。
 *    **严禁**读底图（Protomaps / OpenMapTiles）的 schema 字段：
 *    那些只存在于**底图图层**，我们的电力要素里一概没有，
 *    误用会让弹窗静默显示 `undefined`（不报错、不崩溃，最难发现）。
 *    判别一律用自建的 `ftype`。
 */
type OsmPointProperties = {
  /** 自建判别字段：line / substation / plant */
  ftype?: string;
  name?: string;
  vclass?: string;
  voltage_kv?: number;
  substation_kind?: string;
  plant_source?: string;
  osm_id?: string;
};

/**
 * OSM 的 `plant:source`（小写，如 solar / wind / hydro）
 * → `lib/fuel.ts` 的 WRI 键（首字母大写，如 Solar / Wind / Hydro）。
 *
 * ⚠️ 为什么必须有这张表而不能直接查 `FUEL_LABELS`：
 *    `FUEL_LABELS` 的键是 **WRI `primary_fuel`** 的取值（首字母大写），
 *    而 OSM 的 `plant:source` 是全小写的另一套写法。直接查表会**全部落空**，
 *    于是每个电厂都退回英文原名 —— 看起来像“翻译没生效”，实际是键对不上。
 */
const OSM_PLANT_SOURCE_TO_WRI: Record<string, string> = {
  coal: "Coal",
  gas: "Gas",
  oil: "Oil",
  nuclear: "Nuclear",
  hydro: "Hydro",
  wind: "Wind",
  solar: "Solar",
  biomass: "Biomass",
  geothermal: "Geothermal",
  waste: "Waste",
  storage: "Storage",
  cogeneration: "Cogeneration",
  petcoke: "Petcoke",
  tidal: "Wave and Tidal",
  wave: "Wave and Tidal",
};

/**
 * `plant:source` → 中文（可带与图例同色的色块）。
 *
 * - OSM 的值可能是多值（`solar;wind`），拆开分别翻译后用 ` + ` 连接。
 * - 认不出的值**原样返回英文**：那仍是真实数据，比丢掉或写“未知”有价值。
 */
function osmPlantSourceLabel(src?: string): { text: string; swatch?: string } | null {
  if (!src) return null;
  const parts = src.split(";").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const labels = parts.map((p) => {
    const wri = OSM_PLANT_SOURCE_TO_WRI[p.toLowerCase()];
    return wri ? fuelLabel(wri) : p;
  });
  const firstWri = OSM_PLANT_SOURCE_TO_WRI[parts[0]!.toLowerCase()];
  return {
    text: [...new Set(labels)].join(" + "),
    swatch: firstWri ? fuelColor(firstWri) : undefined,
  };
}

/** OSM `substation=*` 取值 → 中文 */
const SUBSTATION_KIND_LABEL: Record<string, string> = {
  transmission: "输电变电站",
  distribution: "配电变电站",
  minor_distribution: "小型配电变电站",
  converter: "换流站",
  compensation: "补偿站",
  traction: "牽引变电站",
  industrial: "工业变电站",
  generation: "发电厂升压站",
};

/**
 * OSM 点要素（变电站 / 电厂）的 Popup。
 *
 * 优雅降级（用户拍板）：
 *  · `name` 缺失 → 「未命名变电站」/「未命名电厂」（按 `ftype` 决定文案）
 *  · `osm_id` 缺失 → **整行隐藏**，绝不显示 undefined
 *  · `vclass` 与 `voltage_kv` 都缺失 → 电压行显示「未知」
 *  · `substation_kind` / `plant_source` 缺失 → 隐藏该行
 */
function buildOsmPointPopup(props: OsmPointProperties): HTMLElement {
  const isSubstation = props.ftype === "substation";
  const rows: PopupRow[] = [];

  // 有精确值就「220 kV（220-499kV）」，只有档位就显示档位，都没有才是「未知」
  const tier = props.vclass ? TIER_LABEL[props.vclass] : undefined;
  const kv = props.voltage_kv;
  const voltageText = kv ? `${kv} kV${tier ? `（${tier}）` : ""}` : (tier ?? "未知");
  rows.push({
    label: "电压等级",
    value: voltageText,
    swatch: isSubstation ? SUBSTATION_COLOR : undefined,
  });

  if (isSubstation) {
    const kind = props.substation_kind;
    if (kind) {
      rows.push({ label: "变电站类型", value: SUBSTATION_KIND_LABEL[kind] ?? kind });
    }
  } else {
    const src = osmPlantSourceLabel(props.plant_source);
    if (src) rows.push({ label: "能源来源", value: src.text, swatch: src.swatch });
  }

  // ‼️ `osm_id` 只在 z>=8 的瓦片里保留（低缩放为压体积被裁掉）。
  //    这里用**属性是否存在**判定，而不是拿 `map.getZoom() >= 8` 去判：
  //    字段是在切片阶段按瓦片级别裁的，z=8 边界上仍可能取到 z7 的父瓦片，
  //    用 zoom 判会与实际取到的瓦片不一致。属性本身就是最可靠的信号。
  const meta = props.osm_id ? `OSM ID ${props.osm_id}` : undefined;

  return buildPopupFrame(
    props.name ?? "",
    isSubstation ? "未命名变电站" : "未命名电厂",
    rows,
    meta,
  );
}

/**
 * 点击热区的**额外外扩半径**（屏幕像素）。
 *
 * 变电站半径 2.5~8px、电厂 3~7px，直接点中很难。
 * `queryRenderedFeatures` 支持传一个**小 bbox** 而不是一个点，
 * 所以这里用它把命中区扩到约 ±7px（即 14x14），**零新增图层**。
 *
 * ‼️ 为什么不另建「热区图层」：那会让每个区域包多 2 个图层，
 *    而区域包图层数已经顶到「不能再多」的上限（见 PACK_MAX_ACTIVE 的说明：
 *    2 个包 = 14 个额外图层，再多 MapLibre 的样式规模与每帧查询开销会明显上升）。
 */
const HIT_BBOX_PAD = 7;

/** `showOsmPointOrLine` 需要的最小事件形状（结构化类型，避免多引一个 maplibre 类型） */
type OsmClickLike = {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
};

/**
 * 阶段41：OSM 点要素 / 线路的**统一**点击处理。
 *
 * ‼️ 为什么必须合并成一处：在此之前有两条独立路径 ——
 *    核心区走 `map.on("click", OSM_LINES_HIT_LAYER_ID, fn)`（layer-scoped），
 *    区域包走地图级 `map.on("click", fn)`。两条路径都用
 *    「命中了点要素就 return」来防止弹窗盖住点，但**都没有真正处理点要素** ——
 *    于是点击变电站/电厂被吞掉后什么都不发生（不报错，只是没反应）。
 *    若只改一条路径，就会出现「核心区能点、区域包点不中」的半修状态。
 *
 * 优先级：**点 > 线**。用 `HIT_BBOX_PAD` 的小 bbox 扩大命中区。
 */
function showOsmPointOrLine(
  map: MapLibreMap,
  e: OsmClickLike,
  opts: { popup: Popup; packKeys: readonly string[] },
): void {
  const { popup, packKeys } = opts;
  const box: [[number, number], [number, number]] = [
    [e.point.x - HIT_BBOX_PAD, e.point.y - HIT_BBOX_PAD],
    [e.point.x + HIT_BBOX_PAD, e.point.y + HIT_BBOX_PAD],
  ];

  const packIds = packKeys.map((k) => packLayerIds(k));
  const osmPointLayers = [
    OSM_PLANT_LAYER_ID,
    OSM_SUBSTATION_LAYER_ID,
    ...packIds.map((i) => i.plants),
    ...packIds.map((i) => i.substations),
  ].filter((id) => !!map.getLayer(id));
  const osmLineLayers = [OSM_LINES_HIT_LAYER_ID, ...packIds.map((i) => i.hit)].filter((id) =>
    !!map.getLayer(id),
  );

  // 数据库演示图层：它们各自有 layer-scoped 处理器（带自己的弹窗）。
  // 这里**只把它们当抑制者** —— 命中了就什么都不做，把机会让给各自处理器，
  // 避免两个弹窗互相覆盖（否则点一个数据库电厂可能被随后的线路弹窗顶掉）。
  const dbPointLayers = [PLANT_LAYER_ID, SUBSTATIONS_LAYER_ID].filter((id) => !!map.getLayer(id));
  // 用 [x, y] 元组而不是直接传 `e.point`：后者在本函数里是结构化类型 {x,y}，
  // 而 MapLibre 的 PointLike 只接受 Point 实例或 [number, number]（实测 TS 报错）。
  if (
    dbPointLayers.length &&
    map.queryRenderedFeatures([e.point.x, e.point.y], { layers: dbPointLayers }).length
  ) {
    return;
  }

  // ---- ① 点优先 ----
  if (osmPointLayers.length) {
    const hit = map.queryRenderedFeatures(box, { layers: osmPointLayers })[0];
    if (hit) {
      // 弹窗挂到要素自身坐标，而不是鼠标位置 —— 鼠标可能在扩大的热区边缘。
      // 几何兼底：理论上点要素只有 Point，但拿不到就退回鼠标位置（总比不弹好）。
      const geom = hit.geometry as { type?: string; coordinates?: [number, number] };
      const at: [number, number] =
        geom?.type === "Point" && Array.isArray(geom.coordinates)
          ? geom.coordinates
          : [e.lngLat.lng, e.lngLat.lat];
      popup
        .setLngLat(at)
        .setDOMContent(buildOsmPointPopup(hit.properties as OsmPointProperties))
        .addTo(map);
      return;
    }
  }

  // ---- ② 退到线路 ----
  if (!osmLineLayers.length) return;
  // 几何兼底：线在切片里有 LineString 与 MultiLineString 两种，都必须接受。
  // 只认前者会让多段线静默点不到。
  const lineFeat = map
    .queryRenderedFeatures(box, { layers: osmLineLayers })
    .find((f) => {
      const t = (f.geometry as { type?: string }).type;
      return t === "LineString" || t === "MultiLineString";
    });
  if (!lineFeat) return;
  const coords = longestLineCoords(lineFeat.geometry);
  if (!coords.length) return;
  // 弹窗挂在线的中点而不是鼠标处：避免点在线段末端时弹窗被视窗裁掉。
  const anchor = coords[Math.floor(coords.length / 2)];
  if (!anchor) return;
  popup
    .setLngLat(anchor.slice() as [number, number])
    .setDOMContent(buildLinePopup(lineFeat.properties as LineProperties, coords))
    .addTo(map);
}

/**
 * 从 SQLite 读取电厂，转成 GeoJSON 供地图渲染。
 *
 * 数据由外部导入脚本写入（见 `scripts/import_wri_plants.py`），
 * 应用本身不产生任何数据，只负责读取与展示。
 *
 * 先 Database.load() 确保插件的连接池已建立，再 db.select(...)。
 */

/** 单种燃料在当前视野内的统计 */
interface FuelStat {
  fuel: string | null;
  count: number;
  /** 该燃料的容量合计（MW）。**全部缺失时为 null**，而不是 0 */
  capacityMw: number | null;
}

interface PlantStatsInBox {
  total: number;
  totalCapacityMw: number;
  /** 因容量缺失而**未计入合计**的座数（要在界面上如实标注） */
  missingCapacity: number;
  byFuel: FuelStat[];
}

/**
 * 阶段48：统计当前视野内**按燃料分组的**电厂座数与装机容量。
 *
 * ‼️ 为什么是 SQL 而不是 `queryRenderedFeatures`：
 *    电厂走的是 **cluster 数据源**，低缩放下 `queryRenderedFeatures` 只能拿到
 *    聚合圆（带 `point_count`），既看不到单个电厂，更**无法按燃料求和容量** ——
 *    聚合体只给一个计数，求和必然错。线路/变电站仍走 `queryRenderedFeatures`
 *    （它们没有聚合），本条只针对电厂。
 *
 * ✅ 一条 GROUP BY 同时给出：分类明细 + 总数 + 总容量 + 缺失容量的座数，
 *    相比原来「一次 COUNT」**往返次数没有增加**。
 * ✅ 走 `idx_power_plants_lat_lon` 索引（实测同类 bbox 查询 0.07ms）。
 * ✅ `SUM()` 天然跳过 NULL —— 正是「容量缺失不纳入求和」的要求，不需要额外分支。
 *
 * ⚠️ 边界值直接插进 SQL：取值来自 `map.getBounds()` 并经 `Number()` 强转，
 *    是纯数字而非用户输入，没有注入面。
 */
async function loadPlantStatsInBox(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<PlantStatsInBox> {
  const db = await Database.load(DB_URL);
  const w = Number(west);
  const s = Number(south);
  const e = Number(east);
  const n = Number(north);
  const rows = (await db.select(
    "SELECT primary_fuel AS fuel, COUNT(*) AS c, SUM(capacity_mw) AS cap, " +
      "SUM(CASE WHEN capacity_mw IS NULL THEN 1 ELSE 0 END) AS miss " +
      "FROM power_plants " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL " +
      `AND lon BETWEEN ${w} AND ${e} AND lat BETWEEN ${s} AND ${n} ` +
      "GROUP BY primary_fuel",
  )) as Array<{ fuel: string | null; c: number; cap: number | null; miss: number }>;

  let total = 0;
  let totalCapacityMw = 0;
  let missingCapacity = 0;
  const byFuel: FuelStat[] = [];
  for (const r of rows) {
    const count = Number(r.c) || 0;
    const cap = r.cap == null ? null : Number(r.cap);
    total += count;
    totalCapacityMw += cap ?? 0;
    missingCapacity += Number(r.miss) || 0;
    byFuel.push({ fuel: r.fuel, count, capacityMw: cap });
  }
  return { total, totalCapacityMw, missingCapacity, byFuel };
}

async function loadPlantsGeoJson(): Promise<FeatureCollection> {
  const db = await Database.load(DB_URL);

  // 只取有坐标的记录：经纬度缺失的行无法在地图上定位
  const rows = (await db.select(
    "SELECT name, lat, lon, country, capacity_mw, primary_fuel, " +
      "commissioning_year, owner, source, url FROM power_plants " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL",
  )) as Array<{
    name: string;
    lat: number;
    lon: number;
    country: string | null;
    capacity_mw: number | null;
    primary_fuel: string | null;
    // 阶段46：迁移 006 新增的列。类型写成可空 —— 老库未重跑导入时全是 NULL
    commissioning_year: number | null;
    owner: string | null;
    source: string | null;
    url: string | null;
  }>;

  return {
    type: "FeatureCollection",
    // ⚠️ GeoJSON 的坐标顺序是 [经度, 纬度]，与 SQL 里 lat / lon 的书写顺序相反
    features: rows.map((r) => ({
      type: "Feature",
      properties: {
        name: r.name,
        country: r.country,
        capacity: r.capacity_mw,
        fuel: r.primary_fuel,
        // 颜色在这里算好写进属性，样式里直接用 ["get", "color"] 取。
        // 比在样式里堆一长串 match 表达式简单，且图例与 Popup 复用同一份映射。
        color: fuelColor(r.primary_fuel),
        // 阶段46：新字段一并带进属性，供多行 Popup 使用
        year: r.commissioning_year,
        owner: r.owner,
        source: r.source,
        // 阶段47：溯源链接（弹窗里的「数据来源」可点）
        url: r.url,
      },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  };
}

/**
 * GEM 电站级属性（**PMTiles 通道专用**）。
 * ‼️ 只剩这一条通路（旧的 GeoJSON / SQLite 通道已删除）。
 *
 * ‼️ **字段可用性随缩放级变化** —— 这是数据契约，不是渲染 bug：
 *    归档 z>=8 的瓦片带全部字段；z<8 只带 `plant_type`/`units`/`capacity`/`status`
 *    （见 `build_pmtiles.mjs` 的 `--kind gem` 档案里的 `collapseProps`）。
 *    ⇒ `location_id` / `name` / `country` / `state` / `owner` **仅高缩放级保证存在**。
 *    低缩放级点开弹窗时它们是 `null`，弹窗显示 `MISSING` —— 那是**真实缺失**。
 *    ⚠️ 所以不要在别处假设这些字段一定有值。
 *
 * 契约字段：`name` / `country` / `state` / `plant_type` / `units` /
 *           `capacity` / `status` / `owner`（`location_id` 可选）。
 *
 * ‼️ 阶段50-C.2-B：`status` **只作数据字段**（弹窗展示），**不参与 paint** ——
 *    颜色编码已由 `plant_type` 单独承担，两个通道再加一份 status 会互相抢谱。
 *
 * `wiki` 没有任何通路产出它，保留键位是为了改类型时不漏掉存量引用。
 */
interface GemPlantProperties {
  name: string;
  /** 电站级稳定标识（GEM location_id）。⚠️ 仅 z>=8 保证存在 */
  location_id?: string | null;
  /** ⚠️ 仅 z>=8 保证存在 */
  country: string | null;
  /** ⚠️ 仅 z>=8 保证存在 */
  state: string | null;
  /**
   * 煤 / 油气 / 生物质。**全缩放级可用**。
   * ‼️ 阶段50-C.2-B 起它是**唯一**的颜色来源（status 不再参与 paint）。
   */
  plant_type?: string | null;
  units: number;
  capacity: number;
  /** ⚠️ 只作弹窗展示，**不进任何 paint 表达式**（见上面的说明） */
  status: string;
  /** ⚠️ 仅 z>=8 保证存在 */
  owner: string | null;
  /** ⚠️ 无任何通路产出它，也**不在弹窗里展示**（保留键位只为改类型时不漏掉引用） */
  wiki: string | null;
  [key: string]: unknown;
}

/**
 * 阶段50-B.1：把要素属性**显式映射**成弹窗要的形状。
 *
 * ‼️ 取代原来的 `feature.properties as unknown as GemPlantProperties`。
 *    那个双重断言把「字段改名 / 字段缺失」整个挡在类型检查之外 ——
 *    MapLibre 给过来的 `properties` 就是个 `{ [k: string]: any }`，
 *    断言成什么都成立，**包括断言成错的**。症状是弹窗里出现 `undefined`，
 *    而 TS 一句都不报。
 *    这里逐字段取值 + 给缺省：缺字段时弹窗显示 `MISSING`（真实缺失），
 *    而不是渲染出 `undefined 台`、`undefined MW`。
 *
 * ‼️ 阶段50-C.2-B（Task 4 核查）：属性唯一的来源是 **PMTiles 瓦片要素**
 *    （字段集见 `build_pmtiles.mjs` 的 `--kind gem` 档案）。实测可用性：
 *      · `plant_type` / `units` / `capacity` / `status` —— **全缩放级**可用
 *      · `name` / `owner` / `country` / `state` —— **仅 z>=8** 可用
 *    ⇒ 低缩放级瓦片里后四个字段**不存在**，弹窗会显示 `MISSING`。
 *      这是**数据契约**，不是渲染 bug。（`location_id` 同属 z>=8 组）
 */
function gemPropsFromFeature(raw: unknown): GemPlantProperties {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const num = (k: string): number => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    name: str("name") ?? "未命名电站",
    location_id: str("location_id"),
    country: str("country"),
    state: str("state"),
    plant_type: str("plant_type"),
    units: num("units"),
    capacity: num("capacity"),
    status: str("status") ?? "unknown",
    owner: str("owner"),
    wiki: str("wiki"),
  };
}

/**
 * GEM 电站弹窗。
 * ⚠️ CC BY 4.0 **要求署名**，所以底部那行「数据来源」不是装饰，不能删。
 */
function buildGemPlantPopup(
  props: GemPlantProperties,
  point?: readonly [number, number],
): HTMLElement {
  // ‼️ 阶段50-C.3-A：「机组构成」行及其「按状态聚合机组数」的字段已删除
  //    （该字段无产出方，恒为空）。下面这几项与 `GemPlantProperties`
  //    的契约字段一一对应，不多不少。
  return buildPopupFrame(props.name, "未命名电站", [
    { label: "数据来源", value: "Global Energy Monitor (CC BY 4.0)", link: GEM_PLANT_LICENSE_URL },
    { label: "状态", value: GEM_STATUS_LABEL[props.status] ?? props.status },
    { label: "机组数", value: `${props.units} 台` },
    { label: "装机合计", value: `${props.capacity} MW` },
    { label: "国家/地区", value: [props.country, props.state].filter(Boolean).join(" ") || MISSING },
    { label: "所有者", value: props.owner || MISSING },
    { label: "坐标", value: point ? formatLngLat(point as [number, number]) : MISSING },
  ]);
}

/**
 * 阶段21：读取变电站，转 GeoJSON。
 * 数据来自设置页的「导入演示电网数据」按钮（见 src/lib/demoGrid.ts）。
 */
async function loadSubstationsGeoJson(): Promise<FeatureCollection> {
  const db = await Database.load(DB_URL);

  const rows = (await db.select(
    "SELECT name, country, voltage_kv, lat, lon FROM substations " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL",
  )) as Array<{
    name: string;
    country: string | null;
    voltage_kv: number | null;
    lat: number;
    lon: number;
  }>;

  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: {
        name: r.name,
        country: r.country,
        // 电压参与半径分级；缺失时给 0，落在 step 表达式的第一档
        voltage: r.voltage_kv ?? 0,
      },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  };
}

/**
 * 阶段21：读取输电线路，转 GeoJSON。
 *
 * ⚠️ 每条线路必须以「两点 LineString」表示，而不是把多条线塞进一个
 *    MultiLineString —— 后者会让 MapLibre 无法按单条线做属性分级。
 */
async function loadLinesGeoJson(): Promise<FeatureCollection> {
  const db = await Database.load(DB_URL);

  const rows = (await db.select(
    "SELECT name, voltage_kv, start_lat, start_lon, end_lat, end_lon " +
      "FROM transmission_lines " +
      "WHERE start_lat IS NOT NULL AND start_lon IS NOT NULL " +
      "AND end_lat IS NOT NULL AND end_lon IS NOT NULL",
  )) as Array<{
    name: string;
    voltage_kv: number | null;
    start_lat: number;
    start_lon: number;
    end_lat: number;
    end_lon: number;
  }>;

  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: {
        name: r.name,
        voltage: r.voltage_kv ?? 0,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [r.start_lon, r.start_lat],
          [r.end_lon, r.end_lat],
        ],
      },
    })),
  };
}

/**
 * 内存退化路径用的 PMTiles Source。
 *
 * ⚠️ 只有在 asset 协议**不支持 Range** 时才会用到它：那时只能把归档整包读进内存再切片。
 * 当前归档 33 MB，这么做还能接受；但换成行星级归档（100 GB+）就完全不可行，
 * 所以它只是兵底，不是主路径。
 */
class MemorySource {
  #buffer: ArrayBuffer;
  #key: string;

  constructor(buffer: ArrayBuffer, key: string) {
    this.#buffer = buffer;
    this.#key = key;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    // 返回独立副本，不把整个归档的底层 buffer 泄露出去
    return { data: this.#buffer.slice(offset, offset + length) };
  }

  getKey(): string {
    return this.#key;
  }
}

/** 本地 PMTiles 归档的定位结果（底图与电网瓦片共用同一套逻辑） */
type ArchiveHandle = {
  /** 协议表里的键：Range 模式是 asset URL，内存模式是资源路径 */
  key: string;
  /** 资源相对路径，便于日志与排错 */
  resource: string;
  minZoom: number;
  maxZoom: number;
  /** range = 按需 Range 读取（首选）；memory = 整包读入内存（退化路径） */
  mode: "range" | "memory";
};

/** 确认拿到的确实是 PMTiles 归档，而不是一段 HTML 错误页 */
function assertPmtilesMagic(head: Uint8Array): void {
  // 127 字节的头部以 7 字节魔数「PMTiles」开头
  const magic = String.fromCharCode(...head.subarray(0, 7));
  if (magic !== "PMTiles") {
    throw new Error(`不是合法的 PMTiles 归档（magic="${magic}"）`);
  }
}

/**
 * 深色离线底图配色。
 *
 * 设计目标：陆地/水域/道路/边界都能分辨，但**不能抢眼** ——
 * 地图的主角是电厂与变电站点，底图只是参照物。所以整体明度对比压得很低，
 * 并且刻意避开数据用色（青蓝 #3fd0c9 与金色 #ffb300 附近），以免混淆。
 */
const BASEMAP_PAINT = {
  background: "#0b0f14",
  earth: "#161c23",
  landcover: "#1a2119",
  landuse: "#1d232b",
  water: "#0e2338",
  river: "#1b4a6e",
  roadMinor: "#2a3340",
  roadMajor: "#3d4857",
  boundary: "#39434f",
} as const;

/**
 * 阶段51：浅色离线底图配色。
 *
 * ‼️ **只给底图用。** 数据图层（电厂燃料色 / 电压档色 / GEM 三色 / 变电站青 / 线路灰）
 *    两个主题**共用同一套十六进制值**，一个都没改 —— 这就是「配色不变」红线的边界：
 *    底图是参照物，必须跟着主题走；数据是语义，不能变。
 *
 * 沿用深色版的设计思路：整体明度对比压低，并刻意避开数据用色
 *（青蓝 #3fd0c9 与金色 #ffb300 附近），免得底图与数据点抢注意力。
 */
const BASEMAP_PAINT_LIGHT = {
  background: "#f6f6f4",
  earth: "#f2efe9",
  landcover: "#e6f0df",
  landuse: "#eceae3",
  water: "#cfe0ee",
  river: "#9dc0dc",
  roadMinor: "#e4e2dd",
  roadMajor: "#ffffff",
  boundary: "#bfc4c9",
} as const;

/** 地名文字的三级色（国家 / 省州 / 其他）—— 深浅两套。 */
const BASEMAP_LABEL_TEXT = {
  dark: ["#e8eef6", "#c3cdda", "#a7b3c2"],
  light: ["#11202e", "#33475c", "#5a6b7d"],
} as const;

/**
 * 阶段51：把底图切到指定主题。
 *
 * ‼️ 为什么用 `setPaintProperty` 而不是重建地图：重建会丢掉相机（中心/缩放）、
 *    打断 GEM 的挂载生命周期、重跑全部归档探测，而且「下载完成后重挂」那条路径
 *    还会与在途的重建竞态。改 paint 是幂等且瞬时的。
 *
 * ‼️ 这里**一个数据图层都不碰** —— 只动背景 + 9 个底图图层 + 地名文字。
 *    图层 id 也一个都没改。
 *
 * ⚠️ 图层可能还没建好（地图尚未 load、或底图归档缺失时只有 background）——
 *    逐个 `getLayer` 判空跳过，不报错。
 */
function applyBasemapTheme(map: MapLibreMap, theme: Theme): void {
  const p = theme === "light" ? BASEMAP_PAINT_LIGHT : BASEMAP_PAINT;
  const t = BASEMAP_LABEL_TEXT[theme];
  /**
   * ‼️ 为什么**不**用一个 `set(id, prop, value)` 小工具来收拢下面 11 次调用：
   *    `setPaintProperty` 的取值类型是**按属性名收窄**的（`background-color`
   *    与 `fill-color` 接受的联合并不相同）。一旦把 prop / value 抽成变量，
   *    类型就宽化成「所有 paint 属性的并集」，回传时必然 TS2345 —— 实测两次都撞在这。
   *    所以这里**逐条字面量调用**，让每个属性各自接受正确的类型检查；
   *    代价是每行都要判空，用下面这个 `has()` 收拢。
   *
   * ⚠️ 图层可能还没建好（地图未 load；底图归档缺失时更是只有 background）——
   *    判空跳过即可，不报错。
   */
  const has = (id: string) => Boolean(map.getLayer(id));
  if (has("background")) map.setPaintProperty("background", "background-color", p.background);
  if (has("basemap-earth")) map.setPaintProperty("basemap-earth", "fill-color", p.earth);
  if (has("basemap-landcover"))
    map.setPaintProperty("basemap-landcover", "fill-color", p.landcover);
  if (has("basemap-landuse")) map.setPaintProperty("basemap-landuse", "fill-color", p.landuse);
  if (has("basemap-water")) map.setPaintProperty("basemap-water", "fill-color", p.water);
  if (has("basemap-river")) map.setPaintProperty("basemap-river", "line-color", p.river);
  if (has("basemap-road-minor"))
    map.setPaintProperty("basemap-road-minor", "line-color", p.roadMinor);
  if (has("basemap-road-major"))
    map.setPaintProperty("basemap-road-major", "line-color", p.roadMajor);
  if (has("basemap-boundary"))
    map.setPaintProperty("basemap-boundary", "line-color", p.boundary);
  if (has(BASEMAP_LABEL_LAYER_ID)) {
    map.setPaintProperty(BASEMAP_LABEL_LAYER_ID, "text-color", [
      "match",
      ["get", "kind"],
      "country",
      t[0],
      "region",
      t[1],
      t[2],
    ]);
    // 描边用主题背景色：浅色底图上没有 halo 的文字在某些色块上会读不清
    map.setPaintProperty(BASEMAP_LABEL_LAYER_ID, "text-halo-color", p.background);
  }
}

/** 背景图层：无论底图是否可用都要有，否则数据点会浮在白色上 */
const BACKGROUND_LAYER: LayerSpecification = {
  id: "background",
  type: "background",
  paint: { "background-color": BASEMAP_PAINT.background },
};

/**
 * 底图图层栈。
 *
 * ⚠️ `source-layer` 的取值不是照抄文档，而是**把切出来的归档解开、逐层打印出来的**：
 * 本归档实际只有 earth / landcover / landuse / water / roads / boundaries / places
 * 七层（`scripts/fetch_basemap.mjs` 的回读校验里也在查这个）。
 * buildings / pois / transit 只出现在 z13 以后，而本归档最高只到 z8，所以不存在。
 *
 * ⚠️ 这里**没有 symbol 图层**：文字渲染需要 `glyphs` 字体服务器，
 * 而本项目样式是全离线内联的，没有字体源。地名改用 HTML 标记渲染（见聚合数字标记）。
 * 注：归档里的 `places` 层其实带 `name:zh-Hans`，将来若打包 CJK 字形包可以直接用。
 */
const BASEMAP_LAYERS: LayerSpecification[] = [
  {
    id: "basemap-earth",
    type: "fill",
    source: BASEMAP_SOURCE,
    "source-layer": "earth",
    paint: { "fill-color": BASEMAP_PAINT.earth },
  },
  {
    id: "basemap-landcover",
    type: "fill",
    source: BASEMAP_SOURCE,
    "source-layer": "landcover",
    paint: { "fill-color": BASEMAP_PAINT.landcover, "fill-opacity": 0.55 },
  },
  {
    id: "basemap-landuse",
    type: "fill",
    source: BASEMAP_SOURCE,
    "source-layer": "landuse",
    paint: { "fill-color": BASEMAP_PAINT.landuse, "fill-opacity": 0.6 },
  },
  {
    id: "basemap-water",
    type: "fill",
    source: BASEMAP_SOURCE,
    "source-layer": "water",
    paint: { "fill-color": BASEMAP_PAINT.water },
  },
  {
    // 河流在数据里也是**面**（kind_detail=river），只靠填充几乎看不见，所以补一层描边
    id: "basemap-river",
    type: "line",
    source: BASEMAP_SOURCE,
    "source-layer": "water",
    filter: ["==", ["get", "kind_detail"], "river"],
    paint: {
      "line-color": BASEMAP_PAINT.river,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.3, 8, 0.9, 12, 1.8],
    },
  },
  {
    id: "basemap-road-minor",
    type: "line",
    source: BASEMAP_SOURCE,
    "source-layer": "roads",
    paint: {
      "line-color": BASEMAP_PAINT.roadMinor,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.2, 8, 0.6, 12, 1.4],
    },
  },
  {
    id: "basemap-road-major",
    type: "line",
    source: BASEMAP_SOURCE,
    "source-layer": "roads",
    // ⚠️ MapLibre 的 `match` 标签必须是**字面量**，不能写成数组；
    // 取值 motorway / motorway_link 是实测出来的，不是猜的。
    filter: [
      "match",
      ["get", "kind_detail"],
      "motorway",
      true,
      "motorway_link",
      true,
      "trunk",
      true,
      "primary",
      true,
      false,
    ],
    paint: {
      "line-color": BASEMAP_PAINT.roadMajor,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 1.4, 12, 3],
    },
  },
  {
    id: "basemap-boundary",
    type: "line",
    source: BASEMAP_SOURCE,
    "source-layer": "boundaries",
    paint: {
      "line-color": BASEMAP_PAINT.boundary,
      "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.3, 8, 0.8],
    },
  },
  {
    // 阶段27：中文地名。
    //
    // 数据实测（不是照抄文档）：国家名就在 `places` 层且 `kind = "country"`，
    // 实测 48/48 个国家要素都带 `name:zh-Hans`；`kind = "region"`（省/州）、
    // `kind = "locality"`（市/town）。所以一层就够了。
    id: BASEMAP_LABEL_LAYER_ID,
    type: "symbol",
    source: BASEMAP_SOURCE,
    "source-layer": "places",
    // Protomaps 已经给每个地名算好了「最早应在哪一级出现」的 min_zoom，直接拿它当过滤器，
    // 比自己按人口/行政级别拍一套分级规则更贴合数据，也不会在低级别把地名挤成一团。
    filter: ["<=", ["get", "min_zoom"], ["zoom"]],
    layout: {
      // ⚠️ 这条回退链必须与 `scripts/fetch_glyphs.mjs` 里扫字形用的 NAME_KEYS 完全一致。
      //    否则会出现「扫字形时算的是 A 字、实际渲染用的是 B 字」→ 图上缺字。
      //    `name:en` 是关键兜底：实测有 23 个码位（缅甸文/泰文等）没有任何字体子集覆盖，
      //    没有英文兜底时那些地方会是空白标签。
      "text-field": [
        "coalesce",
        ["get", "name:zh-Hans"],
        ["get", "name:zh-Hant"],
        ["get", "name:en"],
        ["get", "name"],
      ],
      "text-font": [BASEMAP_FONT_FAMILY],
      // 国家 > 省/州 > 城市：用字号与颜色拉开层次。
      // ⚠️ 不能靠 font-weight 区分 —— CJK 的字重由字体文件自带，
      //    样式里的 light/regular/medium/bold 关键字对表意文字不生效。
      "text-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        2,
        ["case", ["==", ["get", "kind"], "country"], 12, ["==", ["get", "kind"], "region"], 10, 9],
        6,
        ["case", ["==", ["get", "kind"], "country"], 15, ["==", ["get", "kind"], "region"], 12, 11],
        12,
        ["case", ["==", ["get", "kind"], "country"], 18, ["==", ["get", "kind"], "region"], 14, 13],
      ],
      "text-max-width": 8,
      "text-padding": 4,
      // 默认 false：交给 MapLibre 做碰撞检测，重叠的地名会被自动抽掉，不会糊成一片
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": [
        "match",
        ["get", "kind"],
        "country",
        "#e8eef6",
        "region",
        "#c3cdda",
        "#a7b3c2",
      ],
      // 描边用底色：深色底图上没有 halo 的文字在某些色块上会读不清
      "text-halo-color": BASEMAP_PAINT.background,
      "text-halo-width": 1.2,
      "text-halo-blur": 0.4,
    },
  },
];

/**
 * 协议注册 + 底图定位，全程只执行一次。
 *
 * 三个必须遵守的点：
 * 1. MapLibre 的协议注册表是**全局**的，重复注册同名协议会抛错；而 `main.tsx`
 *    开了 StrictMode，effect 会「执行 → 清理 → 再执行」，所以这里必须幂等。
 * 2. 正因如此，cleanup 里**不能**调 removeProtocol —— 一旦摘掉，第二次建图时
 *    协议就没了，表现为瓦片全空且控制台不报错。
 * 3. 用 127 字节（正好是 PMTiles 头部长度）的**探针**确认底层协议真的支持 Range。
 *    不支持时立刻退化并给出明确提示，而不是让用户对着一张近黑的空地图发懵。
 */
let pmtilesProtocol: Protocol | null = null;
/** 同一份归档只解析一次（StrictMode 下 effect 会跑两遍） */
const archivePromises = new Map<string, Promise<ArchiveHandle | null>>();

/**
 * 阶段44：**下载完成后必须显式失效归档缓存。**
 *
 * ‼️ `archivePromises` 是按 `resource` 字符串缓存的 —— 同一个路径换了文件内容，
 *    缓存会继续返回**旧归档**，地图上什么都看不到。这是本阶段最容易漏的一步，
 *    而且症状是「明明下载成功了，地图还是没数据」，极难定位。
 */
function invalidateArchive(resource: string) {
  const had = archivePromises.delete(resource);
  console.info(`[MapPage] 归档缓存失效：${resource}${had ? "" : "（本来就没有缓存）"}`);
}

/**
 * 阶段44：用户可写的数据包目录（Rust 侧 `app_data_dir()/packs`）。
 *
 * ‼️ 不自己在前端算这个路径 —— Rust 侧是唯一真源。两边各算一遍的话，
 *    只要一边改了命名（比如加个子目录）就会「文件明明存在却探测不到」。
 */
let packsDirPromise: Promise<string | null> | null = null;
function getPacksDir(): Promise<string | null> {
  packsDirPromise ??= invoke<string>("pack_dir").catch((err) => {
    console.warn("[MapPage] 无法获取数据包目录（非 Tauri 环境？）", err);
    return null;
  });
  return packsDirPromise;
}

/**
 * 阶段44：一个 resource 可能有多个物理位置。
 *
 * 顺序很重要：**用户目录优先**（那是下载得到的、可能是新版本），
 * 其次才是资源目录（dev 的 `target/debug/packs`、或随安装包分发的兼容位置）。
 * 探测失败会继续试下一个候选，全失败才判定「未安装」。
 */
async function candidatePaths(resource: string): Promise<string[]> {
  const out: string[] = [];
  if (resource.startsWith("packs/")) {
    const dir = await getPacksDir();
    if (dir) {
      out.push(`${dir.replace(/[\\/]+$/, "")}\\${resource.slice("packs/".length)}`);
    }
  }
  try {
    const resolved = await resolveResource(resource);
    if (!out.includes(resolved)) out.push(resolved);
  } catch (err) {
    if (!out.length) throw err;
  }
  return out;
}

/** 协议注册表是全局的，而且只能注册一次 —— 这里做幂等 */
function ensurePmtilesProtocol(): Protocol {
  if (!pmtilesProtocol) {
    const protocol = new Protocol();
    // pmtiles v4 的处理器叫 tilev4（不是 tile）
    addProtocol("pmtiles", protocol.tilev4);
    pmtilesProtocol = protocol;
  }
  return pmtilesProtocol;
}

/**
 * 打开一份本地 PMTiles 归档（底图与电网瓦片共用同一套逻辑）。
 *
 * @param resource    资源相对路径，例如 "maps/osm_grid.pmtiles"
 * @param label       日志用的中文名
 * @param missingHint 拿不到时的补救提示
 * @param quiet       true 时文件不存在不告警（用于**探测可选包是否已安装** ——
 *                    用户没装区域包是正常状态，不该每次启动刷 7 条 warn）
 */
function ensurePmtilesArchive(
  resource: string,
  { label, missingHint, quiet = false }: { label: string; missingHint: string; quiet?: boolean },
): Promise<ArchiveHandle | null> {
  const cached = archivePromises.get(resource);
  if (cached) return cached;

  const task = (async (): Promise<ArchiveHandle | null> => {
    const protocol = ensurePmtilesProtocol();
    const candidates = await candidatePaths(resource);
    let lastErr: unknown = null;

    for (const absPath of candidates) {
      const url = convertFileSrc(absPath);
      try {
        // ---- 首选：让 pmtiles 自己按需发 Range 请求 ----
        const probe = await fetch(url, { headers: { Range: "bytes=0-126" } });

        // 该候选不存在（或不在 assetProtocol 作用域内）→ 安静地试下一个。
        // ‼️ 404/403 不能走下面的 warn 分支，否则「用户目录没有、资源目录有」
        //    这种完全正常的情况会每次都刷一条告警。
        if (probe.status === 404 || probe.status === 403) {
          lastErr = new Error(`HTTP ${probe.status}`);
          continue;
        }

        if (probe.status === 206) {
          assertPmtilesMagic(new Uint8Array(await probe.arrayBuffer()));
          const archive = new PMTiles(url);
          protocol.add(archive);
          const header = await archive.getHeader();
          console.info(
            `[MapPage] ${label}就绪（Range 读取）：${absPath}，z${header.minZoom}-${header.maxZoom}，` +
              `${header.numAddressedTiles} 个瓦片，Content-Range=${probe.headers.get("content-range") ?? "-"}`,
          );
          return {
            key: url,
            resource,
            minZoom: header.minZoom,
            maxZoom: header.maxZoom,
            mode: "range",
          };
        }

        // ---- 退化：协议不支持 Range，只能整包读进内存 ----
        console.warn(
          `[MapPage] ${label}未按 Range 返回（HTTP ${probe.status}，期望 206），退回整包读取。` +
            "这不会出错，但说明 asset 协议没生效，大文件会白占内存。",
        );
        const res = await fetch(url);
        if (!res.ok) throw new Error(`读取归档失败：HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        assertPmtilesMagic(new Uint8Array(buffer, 0, 7));
        const archive = new PMTiles(new MemorySource(buffer, resource));
        protocol.add(archive);
        const header = await archive.getHeader();
        return {
          key: resource,
          resource,
          minZoom: header.minZoom,
          maxZoom: header.maxZoom,
          mode: "memory",
        };
      } catch (err) {
        lastErr = err;
        console.info(`[MapPage] ${label}候选路径不可用，继续尝试下一个：${absPath}`, err);
      }
    }

    if (quiet) {
      console.info(`[MapPage] ${label}未安装（属于正常情况）：${resource}`);
    } else {
      console.warn(`[MapPage] ${label}不可用。${missingHint}`, lastErr);
    }
    return null;
  })();

  archivePromises.set(resource, task);
  return task;
}

/** 底图归档（阶段26 起） */
function ensureBasemapArchive(): Promise<ArchiveHandle | null> {
  return ensurePmtilesArchive(BASEMAP_RESOURCE, {
    label: "离线底图",
    missingHint: "将只显示纯色背景。请先运行 `node scripts/fetch_basemap.mjs` 生成底图。",
  });
}

/** 电网瓦片归档（阶段29 起） */
function ensureOsmGridArchive(): Promise<ArchiveHandle | null> {
  return ensurePmtilesArchive(OSM_GRID_RESOURCE, {
    label: "离线电网瓦片",
    missingHint: "将退回上海小样本 GeoJSON。请先运行 `node scripts/build_pmtiles.mjs`。",
  });
}

/**
 * 阶段50-B.1：数据包解析的**统一入口**。
 *
 * ‼️ 存在的意义是「让判定口径只有一个」。在这之前，同一件事分散在三处调用
 *    （探测 / 区域包挂载 / thematic 挂载），每处的 label 与 missingHint 都略有
 *    不同，改一处漏一处几乎必然发生。
 *
 * 查找顺序（由 `candidatePaths()` 实现，与 Rust 侧 `resolve_pack_resource()`
 * **必须保持一致**）：
 *   1. `app_data_dir/packs/<file>` —— 用户下载的（可能是新版本）
 *   2. `$RESOURCE/packs/<file>`    —— 随包分发 / `install_packs.mjs` 手动投放的
 *
 * ⚠️ 必须保持 `quiet: true`：用户没装某个包是**正常状态**，
 *    而探测阶段会对清单里**每一个**包都调一次 —— 不安静就会每次启动刷一串 warn。
 *
 * ⚠️ label 按 `kind` 取词：把 GEM 叫成“区域包”会让人在日志里
 *    把它当成第 8 个区域（它其实不参与视口选举）。
 */
function resolvePackResource(entry: PackEntry): Promise<ArchiveHandle | null> {
  const kindLabel = isThematicOverlay(entry) ? "数据包" : "区域包";
  return ensurePmtilesArchive(entry.file, {
    label: `${entry.label}${kindLabel}`,
    missingHint: `把 ${entry.file} 放到 $RESOURCE/packs/`,
    quiet: true,
  });
}

/** 用真实离线底图拼一个内联样式，彻底摆脱在线演示瓦片 */
function buildBasemapStyle(basemap: ArchiveHandle | null): StyleSpecification {
  if (!basemap) {
    return { version: 8, sources: {}, layers: [BACKGROUND_LAYER] };
  }

  return {
    version: 8,
    // 阶段27：把中文字形交给浏览器的 CSS Font Loading API 本地渲染。
    //
    // 🔴 为什么 **完全不设 `glyphs`**：
    // MapLibre 的 GlyphManager 里有这么一条判断（源码 lib 里实测）：
    //     if (!this.url || isCluster(id) || this._charUsesLocalIdeographFontFamily(codePoint))
    //         → 用本地字体绘制
    // 也就是说 `glyphs` 为空时**所有**字符都走本地绘制，一个字形请求都不会发出去，
    // 比“搞一个字形服务器”更符合本项目「完全离线」的定位。
    // 实测 Protomaps 的 basemaps-assets 只有 Noto Sans Regular/Medium/Italic（无 CJK，
    // CJK 码位区间返回 29 字节的空字形），所以本来也没现成的中文字形服务器可用。
    //
    // `font-faces` 是懒加载的（源码注释：“each file waits until a codepoint it covers is
    // actually drawn”），所以声明了 86 条也不会在启动时把 2.1 MB 全下下来。
    "font-faces": BASEMAP_FONT_FACES,
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        // ⚠️ 这里用 `tiles` 而不是 `url`，是个踩过坑的选择：
        //    用 `url` 时 MapLibre 会去问协议的 TileJSON，而协议会把**归档 header 里的
        //    bbox 当作 bounds 返回**（我们切的是中国中东部），MapLibre 据此裁剪瓦片
        //    请求 —— 于是缩小到 z0 看全球时，中国以外会是一片空白。
        //    自己写 `tiles` + 明确的全球 bounds，既避开这个陷阱，又省掉一次请求。
        tiles: [`pmtiles://${basemap.key}/{z}/{x}/{y}`],
        minzoom: basemap.minZoom,
        maxzoom: basemap.maxZoom,
        bounds: [-180, -85.0511, 180, 85.0511],
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: [BACKGROUND_LAYER, ...BASEMAP_LAYERS],
  };
}

/** 把匹配的点写进高亮图层（图层只建一次，之后只改数据） */
function renderHighlight(
  map: MapLibreMap,
  rows: ReadonlyArray<{ lat: number; lon: number; capacity_mw?: number | null }>,
) {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: {
        // 半径同样按容量分级 —— 否则「前10大电厂」高亮出来是一样大的圈，
        // 反而看不出谁更大，削弱了这个查询本身的意义
        capacity: r.capacity_mw ?? 0,
      },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  };

  const existing = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return;
  }

  // 首次使用才建图层（不参与聚合，所以在任何缩放级别下都看得到）
  map.addSource(HIGHLIGHT_SOURCE, {
    type: "geojson",
    data,
    cluster: false,
  });
  map.addLayer(
    {
      id: HIGHLIGHT_LAYER_ID,
      type: "circle",
      source: HIGHLIGHT_SOURCE,
      paint: {
        // 阶段24：整体比底图点大一号（6/8.5/11/14 对 3/5/7/10）。
        //
        // ⚠️ 这里**刻意不做 zoom 联动**：高亮通常只有几个到几十个点，
        //    需要任何缩放级别都醒目。底图要联动是因为点太多会糊，
        //    高亮没有这个问题。
        //
        // 「更大 + 金色描边」是双重信号：只换成金色的话，
        // 在点密集的区域容易被底图点淹没，找不到命中的是哪几个。
        "circle-radius": [
          "step",
          ["get", "capacity"],
          6,
          100,
          8.5,
          500,
          11,
          1000,
          14,
        ],
        "circle-color": "transparent",
        "circle-stroke-color": "#ffd24a",
        "circle-stroke-width": 2,
      },
    },
    // 阶段27：高亮层插到地名标签**之下**，保证文字始终可读。
    // （高亮层是首次高亮时才建的，那时标签层一定已存在；这里仍做一次判空，
    //   万一以后标签层被去掉也不会抛错。）
    map.getLayer(BASEMAP_LABEL_LAYER_ID) ? BASEMAP_LABEL_LAYER_ID : undefined,
  );
}

/**
 * 阶段28：加载 OSM 电网静态数据。
 *
 * 拿不到就返回 null（**不抛异常**）—— 底图和电厂数据不能被一个可选的图层拖垮。
 * 用 fetch 拿回对象再交给 MapLibre（而不是把 URL 丢给 source），好处：
 *   1) 只请求一次；（若把 URL 给 source，要先探测再加载就是两次）
 *   2) 能校验 FeatureCollection 结构，坏文件会当场报出来而不是变成空白图层；
 *   3) 能把要素数打进控制台 —— 一句话就能判断数据到底加载上没有。
 */
async function loadOsmGridData(): Promise<FeatureCollection | null> {
  try {
    const res = await fetch(OSM_DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = (await res.json()) as FeatureCollection;
    if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
      throw new Error("不是合法的 FeatureCollection");
    }
    if (fc.features.length === 0) throw new Error("要素数为 0");
    console.info(
      `[MapPage] OSM 电网数据就绪：${fc.features.length} 个要素（${OSM_DATA_URL}）`,
    );
    return fc;
  } catch (err) {
    console.error(
      `[MapPage] 未能加载 ${OSM_DATA_URL}，OSM 电网图层将不可见。` +
        "请先运行 `node scripts/prepare_osm_geojson.mjs`。",
      err,
    );
    return null;
  }
}

/**
 * 把 OSM 电网图层加到地图上。
 *
 * 调用位置很关键：必须在所有「点」图层**之前**调用，
 * 否则线会横穿彩色的电厂点与变电站点。图层次序由 addLayer 的调用次序决定。
 */
function addOsmGridLayers(
  map: MapLibreMap,
  archive: ArchiveHandle | null,
  fallback: FeatureCollection | null,
): void {
  if (map.getSource(OSM_SOURCE)) return;

  if (archive) {
    map.addSource(OSM_SOURCE, {
      type: "vector",
      // ⚠️ 与底图同理：用 `tiles` 而不是 `url`。用 `url` 时 MapLibre 会去问协议的
      //    TileJSON，而协议会把归档 header 里的 bbox 当 bounds 返回，缩到全球视野时
      //    电网瓦片会被裁掉。自己写 tiles + 全球 bounds 就避开这个陷阱。
      tiles: [`pmtiles://${archive.key}/{z}/{x}/{y}`],
      minzoom: archive.minZoom,
      maxzoom: archive.maxZoom,
      bounds: [-180, -85.0511, 180, 85.0511],
      attribution: OSM_ATTRIBUTION,
    });
  } else if (fallback) {
    map.addSource(OSM_SOURCE, {
      type: "geojson",
      data: fallback,
      attribution: OSM_ATTRIBUTION,
    });
  } else {
    return;
  }

  // 矢量瓦片必须额外指定 source-layer；GeoJSON 不能设（设了反而报错）
  const layerRef = archive ? { "source-layer": OSM_GRID_SOURCE_LAYER } : {};

  // ---- 阶段43：铁路 / 油气管道（背景参照，画在**电力图层下方**）----
  // ‼️ 必须加在电压档循环**之前**：MapLibre 先加的在下，
  //    若加在循环之后，虚线铁路会盖在 735kV 粉线上。
  // ‼️ layout.visibility 直接写 none：面板默认不包含这两项，
  //    不等显隐 effect 跑第一轮就不会闪一下。
  map.addLayer({
    id: OSM_RAILWAY_LAYER_ID,
    type: "line",
    source: OSM_SOURCE,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "railway"],
    layout: { "line-cap": "butt", "line-join": "round", visibility: "none" },
    paint: {
      "line-color": OSM_RAILWAY_COLOR,
      "line-opacity": 0.75,
      // 虚线：低缩放级别下与四档电压实线一眼可分（不占任何一档电压的颜色）
      "line-dasharray": [2, 1.6],
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 8, 0.9, 11, 1.4],
    },
  });

  map.addLayer({
    id: OSM_PIPELINE_LAYER_ID,
    type: "line",
    source: OSM_SOURCE,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "pipeline"],
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: {
      "line-color": OSM_PIPELINE_COLOR,
      "line-opacity": 0.9,
      // 实线（与铁路的虚线相反）：数量极少（全区域 85 条），需要显眼
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 8, 1.3, 11, 2.2],
    },
  });

  // ‼️ 自下而上加层，让 735kV 画在最顶（详见 `OSM_LINE_TIERS_BOTTOM_UP`）。
  //    ⚠️ 必须与 `addPackLayers` 用同一个数组，否则核心区与区域包画序不一致。
  for (const tier of OSM_LINE_TIERS_BOTTOM_UP) {
    map.addLayer({
      id: tier.id,
      type: "line",
      source: OSM_SOURCE,
      ...layerRef,
      // ftype 判别字段不能少：同一个 source 里装着点、线两类几何
      filter: [
        "all",
        ["==", ["get", "ftype"], "line"],
        ["==", ["get", "vclass"], tier.vclass],
      ],
      layout: {
        "line-cap": "round",
        "line-join": "round",
        // 电压未知档默认隐藏，避免用乱线干扰视线
        visibility: tier.vclass === "unknown" ? "none" : "visible",
      },
      paint: {
        "line-color": tier.color,
        "line-opacity": 0.85,
        // 标称线宽在 z11 达到，低级别收细 —— 否则 z8 以下会被粗线糊满
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          tier.width * 0.3,
          8,
          tier.width * 0.55,
          11,
          tier.width,
        ],
      },
    });
  }

  map.addLayer({
    id: OSM_SUBSTATION_LAYER_ID,
    type: "circle",
    source: OSM_SOURCE,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "substation"],
    paint: {
      "circle-color": SUBSTATION_COLOR,
      "circle-opacity": 0.9,
      "circle-stroke-color": "#06333a",
      "circle-stroke-width": 0.8,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 5, 14, 8],
    },
  });

  // OSM 里的电厂：只是想证明这些要素被抽出来了，所以刻意画成**白描空心圈**，
  // 与 WRI 电厂（按燃料上色的实心圆）一眼可分，不会混淆两套数据来源。
  map.addLayer({
    id: OSM_PLANT_LAYER_ID,
    type: "circle",
    source: OSM_SOURCE,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "plant"],
    paint: {
      "circle-color": "transparent",
      "circle-stroke-color": "#e8eef6",
      "circle-stroke-width": 1.2,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 7],
    },
  });

  // ---- 阶段34：输电线路的透明点击热区（真实切片）----
  // 三层过滤的第一层：热区只允许线要素。`osm-grid` 这个 source 里同时装着
  // 点（变电站/电厂）与线，不写这条 filter 就会「点到点图层」——
  // 这正是「点击彩色线却没反应 / 弹出些不对的信息」的典型来源。
  // 第二层在 click handler 里用 `queryRenderedFeatures({ layers: [...] })` 做点优先判定；
  // 第三层是 geometry.type 兜底。
  map.addLayer({
    id: OSM_LINES_HIT_LAYER_ID,
    type: "line",
    source: OSM_SOURCE,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "line"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      // 完全透明：只为扩大命中范围，视觉上不应该多出任何东西
      "line-color": "#000000",
      "line-opacity": 0,
      "line-width": OSM_LINES_HIT_WIDTH,
    },
  });
}

/**
 * 阶段50-A：数据包按**生命周期**分两类（不是按内容分）。
 *
 * · `"osm"` / 缺省 —— **区域包**：按视口选举、最多 2 个、随视野反复增删
 * · `"gem"`         —— **thematic / global overlay**：全球单一图层，
 *                       由图层开关控制，**该不该显示与视野完全无关**
 *
 * ‼️ 为什么必须分开：把 GEM 混进 `activePacks` 会产生三个都不能接受的行为
 *    （阶段50-A 代码审查逐条确认，均有明确代码依据）：
 *      1. 视野中心落进核心区 bbox（118,27→123,33）时 `activePacks` 被强制清空
 *         ⇒ **GEM 在长三角整片消失**
 *      2. GEM 的 bbox 是全球，重叠面积恒为最大 ⇒ 恒排第一、恒占 2 个名额之一，
 *         把华东/华中这些真正的区域包挤掉
 *      3. `zoom < PACK_MIN_ZOOM(6)` 时清空 ⇒ 缩小反而没数据，与直觉相反
 *
 * ⚠️ 判定用 `=== "gem"` 而**不是** `!== "osm"`。
 *    后者在类型改成 `"region" | "gem"`（阶段50-B）后会变成灾祸：
 *    `kind: "region"` 的条目会被算作 thematic ⇒ **所有区域包被排除出选举**，
 *    而且不报错、只是区域包再也不加载。现在这样写，
 *    任何未知/缺失值都安全地落到“区域包”这一侧。
 */
function isThematicOverlay(p: PackEntry): boolean {
  return p.kind === "gem";
}

/** 区域包的 source id */
function packSourceId(key: string): string {
  return `osm-pack-${key}`;
}

/**
 * 阶段39：给一个区域包挂上 source 与图层。
 *
 * ⚠️ 这里刻意**不改动** `addOsmGridLayers`（核心区那条已验证的路径），而是另写一份：
 *    两者的生命周期根本不同 —— 核心区在启动时一次性挂上、之后永不摘除；
 *    区域包随视口增删，还必须支持卸载。把已验证的核心区路径冻结住，
 *    换来的是「阶段29~38 关于核心区图层的全部结论继续成立」。
 *    代价是这段规格与 `addOsmGridLayers` 有重复 —— 但**所有数值都来自同一组常量**
 *    （`OSM_LINE_TIERS` 的 color/width、`SUBSTATION_COLOR`、`OSM_LINES_HIT_WIDTH`、
 *    `TIER_LABEL` 对应的 filter），所以改配色只需改常量，两个函数会一起变。
 *    唯一需要人工保持同步的是**图层的结构**（几个档、哪个 filter、hit 层宽度）——
 *    改动其中一个函数时请对照另一个。
 */
function addPackLayers(
  map: MapLibreMap,
  key: string,
  archive: ArchiveHandle,
): void {
  const sourceId = packSourceId(key);
  if (map.getSource(sourceId)) return;

  map.addSource(sourceId, {
    type: "vector",
    // 与核心区同理：用 `tiles` 而不是 `url`，避开协议把归档 header 的 bbox 当 bounds 返回
    tiles: [`pmtiles://${archive.key}/{z}/{x}/{y}`],
    minzoom: archive.minZoom,
    maxzoom: archive.maxZoom,
    bounds: [-180, -85.0511, 180, 85.0511],
    attribution: OSM_ATTRIBUTION,
  });

  const layerRef = { "source-layer": OSM_GRID_SOURCE_LAYER };
  // 区域包用带 `--<region>` 后缀的 id，**不覆盖核心区的 id**
  const id = (base: string) => packLayerId(base, key);

  // ---- 阶段43：铁路 / 油气管道（与 `addOsmGridLayers` 同规格，只是 id 带包后缀）----
  // ⚠️ 结构与数值必须与 `addOsmGridLayers` 保持一致 —— 改动其中一个请对照另一个。
  map.addLayer({
    id: id(OSM_RAILWAY_LAYER_ID),
    type: "line",
    source: sourceId,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "railway"],
    layout: { "line-cap": "butt", "line-join": "round", visibility: "none" },
    paint: {
      "line-color": OSM_RAILWAY_COLOR,
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.6],
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 8, 0.9, 11, 1.4],
    },
  });

  map.addLayer({
    id: id(OSM_PIPELINE_LAYER_ID),
    type: "line",
    source: sourceId,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "pipeline"],
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: {
      "line-color": OSM_PIPELINE_COLOR,
      "line-opacity": 0.9,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 8, 1.3, 11, 2.2],
    },
  });

  // ‼️ 用自下而上的顺序：先加的在下面，让 735kV 最后加、画在最顶。
  //    详见 `OSM_LINE_TIERS_BOTTOM_UP` 的说明（原先低压盖高压）。
  for (const tier of OSM_LINE_TIERS_BOTTOM_UP) {
    map.addLayer({
      id: id(tier.id),
      type: "line",
      source: sourceId,
      ...layerRef,
      filter: [
        "all",
        ["==", ["get", "ftype"], "line"],
        ["==", ["get", "vclass"], tier.vclass],
      ],
      layout: {
        "line-cap": "round",
        "line-join": "round",
        visibility: tier.vclass === "unknown" ? "none" : "visible",
      },
      paint: {
        "line-color": tier.color,
        "line-opacity": 0.85,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          tier.width * 0.3,
          8,
          tier.width * 0.55,
          11,
          tier.width,
        ],
      },
    });
  }

  map.addLayer({
    id: id(OSM_SUBSTATION_LAYER_ID),
    type: "circle",
    source: sourceId,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "substation"],
    paint: {
      "circle-color": SUBSTATION_COLOR,
      "circle-opacity": 0.9,
      "circle-stroke-color": "#06333a",
      "circle-stroke-width": 0.8,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 5, 14, 8],
    },
  });

  map.addLayer({
    id: id(OSM_PLANT_LAYER_ID),
    type: "circle",
    source: sourceId,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "plant"],
    paint: {
      "circle-color": "transparent",
      "circle-stroke-color": "#e8eef6",
      "circle-stroke-width": 1.2,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 7],
    },
  });

  map.addLayer({
    id: id(OSM_LINES_HIT_LAYER_ID),
    type: "line",
    source: sourceId,
    ...layerRef,
    filter: ["==", ["get", "ftype"], "line"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#000000",
      "line-opacity": 0,
      "line-width": OSM_LINES_HIT_WIDTH,
    },
  });
}

/**
 * 阶段50-C：GEM PMTiles 图层的监听器登记表。
 *
 * ‼️ 与 `packCursorHandlers` 是**同一个坑**：`map.on("click", layerId, fn)`
 *    注册的监听器挂在 **map** 上、以 layerId 为键，而 `removeLayer`
 *    **不会**把它们清掉。GEM 包同样随开关/视野反复增删，不摘就会累积。
 *    所以必须把 fn 引用存下来，卸载时用**同一个 fn** 去 `off`（匿名声闭包摘不掉）。
 *
 * ⚠️ 键是固定的 source id ⇒ 这张表最多只有 1 项，不会无限增长。
 */
const gemPmtilesHandlers = new Map<
  string,
  { click: (e: MapLayerMouseEvent) => void; enter: () => void; leave: () => void }
>();

/**
 * 阶段50-C：GEM 电源数据包的挂载（PMTiles vector source + circle 图层 + 点击弹窗）。
 *
 * ‼️ 为什么不复用 `addPackLayers`：两者的数据模型不同，共用一个函数会让双方
 *    都取到不存在的 `source-layer`：
 *      · OSM 区域包 = 线 + 点混合，MVT 图层名 `grid`，靠 `ftype`/`vclass` 分 7 个图层
 *      · GEM 电源包 = 纯点，MVT 图层名 `gem`，属性为 `capacity`/`status`/`units`/…
 *
 * ## 可视编码（阶段50-C.2-A 起由本函数**独占**实现）
 *   · 半径  ← `capacity`（与 48-A 旧层用**同一个** step 分级，两套数据才好对比）
 *   · 填色  ← **按 `plant_type` 三色**（coal / oil-gas / bioenergy），见 `gemFuelColor`
 *   · 描边  ← 与填色**同一份** `gemFuelColor`；线宽为**常量** 1.6
 *   · 透明度 ← **常量** 1
 *   ⇒ ‼️ 阶段50-C.2-B：**`status` 不参与 paint**，只作弹窗数据字段。
 *      可视编码全部由 `plant_type`（颜色）+ `capacity`（半径）两个通道承担。
 *
 *   ⇒ 全部写成 MapLibre 表达式而不是 JS 聚合。按类别拆成 3 个图层也能做，
 *     但会把「1 个图层」变成「3 个图层」：默认开关、点击弹窗、卸载顺序
 *     全要跟着改成三份，而任何一处漏改都是**静默**的（少画一种颜色）。
 *
 * ⚠️ 旧的「空心环」形状已随旧 GeoJSON 通道一起删除（50-C.1 / 50-C.2-A）。
 *    代价：同位置的 WRI 实心点会被 GEM 的实心圆盖住 —— 这是本次迁移
 *    **有意接受**的取舍，因为 GEM 默认关闭，用户开它就是为了看 GEM。
 *
 * ## 弹窗
 *   直接复用 `buildGemPlantPopup`。
 *   ⚠️ 字段可用性取决于**缩放级**（契约详见 `gemPropsFromFeature` 的注释）：
 *      · `plant_type`/`units`/`capacity`/`status` —— **全缩放级**可用
 *      · `name`/`owner`/`country`/`state`/`location_id` —— **仅 z>=8** 可用
 *      ⇒ 低缩放级点开的弹窗会显示 `MISSING`，这是**数据契约**，不是渲染 bug。
 *      `wiki` 没有任何通路产出它，恒为 `MISSING`。
 *
 * ⚠️ `popup` 传 null 时只挂图层、不注册点击（比 NPE 好）。
 */
function addGemPlantLayers(
  map: MapLibreMap,
  key: string,
  archive: ArchiveHandle,
  popup: Popup | null,
): void {
  // 阶段50-B：id 统一从函数取 —— 函数内部是唯一的字面量定义点
  const sourceId = gemPmtilesSourceId();
  const layerId = gemPlantsLayerId();
  if (map.getSource(sourceId)) return;

  map.addSource(sourceId, {
    type: "vector",
    // 与核心区/区域包同理：用 `tiles` 而不是 `url`，
    // 避开协议把归档 header 的 bbox 当 bounds 返回。
    tiles: [`pmtiles://${archive.key}/{z}/{x}/{y}`],
    minzoom: archive.minZoom,
    maxzoom: archive.maxZoom,
    bounds: [-180, -85.0511, 180, 85.0511],
    // ‼️ 必须用 GEM 自己的署名：沿用 `OSM_ATTRIBUTION` 会把 ODbL/OSM
    //    署到 CC BY 4.0 的数据上，属许可违约。
    attribution: GEM_PLANT_ATTRIBUTION,
  });

  // ⚠️ `source-layer` 不在 `CircleLayerSpecification` 的类型里（它是 MapLibre 的扩展），
  //    写成内联属性会触发 TS 的多余属性检查；用「先声明再展开」的写法绕过，
  //    这也是 `addPackLayers` / `addOsmGridLayers` 已有的约定。
  const layerRef = { "source-layer": GEM_PMTILES_SOURCE_LAYER };

  // 阶段50-C.2-A：填色与描边**共用同一份**「燃料 → 颜色」表达式。
  // ‼️ 不写成两遍字面量：那样会在改动时漂移，而漂移是**静默**的
  //    （只是某一种燃料的描边与填充对不上，不报错、不警告）。
  // ⚠️ 类型只能这样取：maplibre-gl 的公开 `.d.ts` **没有**导出
  //    `ExpressionSpecification`（已核实：全文 0 命中），但它导出了
  //    `LayerSpecification`（本文件已导入）。从它 Extract 出 circle 的 paint
  //    类型，就能把表达式提成变量而**不丢失上下文类型**（直接写 `const x = [...]`
  //    会退化成 `(string | ...)[]`，赋给 paint 时 TS 报错）。
  type GemCirclePaint = NonNullable<
    Extract<LayerSpecification, { type: "circle" }>["paint"]
  >;
  const gemFuelColor: GemCirclePaint["circle-color"] = [
    "match",
    ["get", "plant_type"],
    "coal",
    fuelColor("Coal"),
    // ⚠️ `oil-gas` 在 GEM 里是**油气合并**的一个 tracker（GOGPT），
    //    没有单独的“油”与“气”之分，所以只能二选一。
    //    取 Gas（橙）而不是 Oil（棕）：橙在白底与深色底上都更易分辨。
    "oil-gas",
    fuelColor("Gas"),
    "bioenergy",
    fuelColor("Biomass"),
    // ⚠️ `match` 的最后一项是**兑底值**，必须给：遇到清单外的 `plant_type`
    //    （或字段缺失）时整条表达式会落回它。
    FUEL_FALLBACK_COLOR,
  ];

  map.addLayer({
    id: layerId,
    type: "circle",
    source: sourceId,
    ...layerRef,
    // 阶段50-A：恒为 `visible`。
    // ‼️ 不再需要「加了但不显示」这个中间态 —— 由 thematic overlay 生命周期
    //    effect 保证「只在该显示时才调用本函数」（开着才装、关掉就卸），
    //    因此拿到 `visible` 参数反而会引入一个能被错误传入的开关。
    layout: { visibility: "visible" },
    paint: {
      // 阶段50-C.2-A：**填色改为按 plant_type 三色**。
      //    原先恒为 `transparent`（旧通道要靠“空心环”与 WRI 实心点区分）。
      //    现在只在**这一条**通道上表达“按燃料分类”，填色与描边同源。
      "circle-color": gemFuelColor,
      // 阶段50-C.2-A：描边与填色**共用同一条表达式**（见上面 `gemFuelColor`）。
      //    原先这里内联一份、而填色是 transparent；现在两处引用同一个值，
      //    改燃料配色时不可能只改到一半。
      "circle-stroke-color": gemFuelColor,
      // ‼️ 与 48-A 旧层的半径分级**逐字相同**。
      //    两套数据同图对比时，若半径不一致会让人以为是数据差异。
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        3,
        ["step", ["get", "capacity"], 3.5, 100, 4.5, 500, 6, 1000, 8],
        8,
        ["step", ["get", "capacity"], 5.5, 100, 8, 500, 11, 1000, 15],
      ],
      // 阶段50-C.2-B：**线宽改为常量**。
      //    C.2-A 曾把旧 ring 的 `zoom × status` 线宽表达式逐字迁移过来；
      //    C.2-B 确定「status 不参与 paint」，所以那两层 `match` 全部撤掉。
      //    取 1.6：等于旧表达式在 z3 + operating 下的值，是它的中性档。
      //    阶段51：1.6 → **1.5**（用户指定，让叠加时与 WRI 实心圆的层次更清楚）。
      "circle-stroke-width": 1.5,
      // 阶段50-C.2-B：**status 不再参与透明度**（原先是一条 4 档 match）。
      //    显式写 1 而不是删掉这个键：删掉只是回到同一个默认值，
      //    但看不出「这里被有意置平」，下次很容易又被加回去。
      "circle-stroke-opacity": 1,
    },
  });

  if (popup) {
    // 用 `e.lngLat` 而不是 `feature.geometry.coordinates`：矢量和要素的
    // geometry 由 MapLibre 解码后拼装，而 `lngLat` 是事件自带的、永远存在。
    const click = (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      popup
        .setLngLat(point)
        .setDOMContent(
          buildGemPlantPopup(gemPropsFromFeature(feature.properties), point),
        )
        .addTo(map);
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };
    gemPmtilesHandlers.set(sourceId, { click, enter, leave });
    map.on("click", layerId, click);
    map.on("mouseenter", layerId, enter);
    map.on("mouseleave", layerId, leave);
  }

  console.info(
    `[MapPage] 加载 GEM 数据包 ${key}（MVT 图层 ${GEM_PMTILES_SOURCE_LAYER}，` +
      `z${archive.minZoom}-${archive.maxZoom}，${archive.mode} 模式）`,
  );
}

/**
 * 阶段50-C：卸载 GEM PMTiles 图层。
 *
 * ⚠️ 顺序不能反：先摘监听器、再删图层、最后删 source。
 * ⚠️ 而且**顺序写反是不会报错的**：实测 maplibre-gl 6.9.0 的
 *    `Style.removeSource`（`maplibre-gl-dev.mjs:15181`）遇到「还有图层在用这个 source」
 *    时走的是 `fire(new ErrorEvent(…))` 然后 **`return`** —— 它**不抛异常**，
 *    source 也**不会被删掉**。即：写反了不会崩，而是**静默泄漏**归档引用与已缓存瓦片。
 *    同类坑：`setLayoutProperty` 对不存在的图层（`maplibre-gl-dev.mjs:15376`）
 *    也是 `fire(ErrorEvent)` + `return`，同样是静默的。
 *    ⇒ 这一整块“没报错”**不等于**“没问题”。
 * ⚠️ 必须真的 remove：只设 visibility=none 会把归档引用与已缓存瓦片留在内存里，
 *    而包是随开关反复增删的。
 */
function removeGemPlantLayers(map: MapLibreMap): void {
  const sourceId = gemPmtilesSourceId();
  const layerId = gemPlantsLayerId();
  const h = gemPmtilesHandlers.get(sourceId);
  if (h) {
    map.off("click", layerId, h.click);
    map.off("mouseenter", layerId, h.enter);
    map.off("mouseleave", layerId, h.leave);
    gemPmtilesHandlers.delete(sourceId);
  }
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/**
 * 阶段40：区域包热区的**光标监听器登记表** —— 修内存/回调泄漏。
 *
 * ‼️ 为什么必须有它：`map.on("mouseenter", layerId, fn)` 注册的监听器存在 **map** 上、
 *    以 layerId 为键；`removeLayer` **不会**把它们清掉（MapLibre 不管理这层生命周期）。
 *    而区域包随视口反复增删，每次重新挂载都再 `on` 一次
 *    → 同一个 layerId 上累积 N 份完全相同的回调，N 随进出次数无上限增长。
 *    （光标效果看起来“正常”，所以这个 bug 不会自己暴露 —— 只会越来越慢。）
 * ⚠️ 不能简单地用 `off(type, layerId)` 不带 fn 去清：那会**误伤**核心区
 *    在同一个 map 上注册的其它同类型监听。所以要先把 fn 引用存下来，逐个精准摘除。
 */
const packCursorHandlers = new Map<
  string,
  { layers: readonly string[]; enter: () => void; leave: () => void }
>();

/**
 * 卸载一个区域包的图层与 source。
 *
 * ⚠️ 顺序不能反：先删图层再删 source。反过来 MapLibre 会抛
 *    "Source ... cannot be removed while layer ... is using it"。
 * ⚠️ 必须真的 remove，而不是只把 visibility 设成 none —— 留着 source 就留着
 *    pmtiles 归档引用与已缓存的瓦片，切几次视野就把内存堆满了。
 */
function removePackLayers(map: MapLibreMap, key: string): void {
  const ids = packLayerIds(key);
  // ‼️ 先摘监听器（在图层还在的时候就摘，避免依赖“图层已删也能 off”的行为）。
  //    阶段41：点图层也纳入了光标反馈，所以要按登记的图层表逐个摘。
  const h = packCursorHandlers.get(key);
  if (h) {
    for (const lid of h.layers) {
      map.off("mouseenter", lid, h.enter);
      map.off("mouseleave", lid, h.leave);
    }
    packCursorHandlers.delete(key);
  }
  //
  // 🔴 阶段43 修复：这里原先手写枚举 `[...ids.lines, ids.substations, ids.plants, ids.hit]`，
  //    新增 railways/pipelines 两个图层时**忘了同步加进来**，于是卸载区域包时
  //    MapLibre 抛 `Source "osm-pack-<key>" cannot be removed while layer
  //    "osm-railways--<key>" is using it` —— source 与其缓存的瓦片永远留着，
  //    而区域包是随视口反复增删的，等于**持续泄漏**。
  //    ⚠️ 这个错误只在切视野时出现、且地图看起来正常，极易被忽略。
  //    现在改为**直接遍历 `packLayerIds()` 的全部字段**：
  //    以后再加图层，只要它出现在 packLayerIds 里就自动被卸载，不需要改这里。
  const allLayerIds = Object.values(ids).flat();
  for (const lid of allLayerIds) {
    if (map.getLayer(lid)) map.removeLayer(lid);
  }
  const sourceId = packSourceId(key);
  if (map.getSource(sourceId)) {
    try {
      map.removeSource(sourceId);
    } catch (err) {
      // 不该发生。响亮报错而不是让 source 静默留着 —— 提示去检查 packLayerIds。
      console.error(
        `[MapPage] ⚠️ 卸载区域包 ${key} 时 source 仍被图层引用；` +
          `请检查是否有新增图层没登记进 packLayerIds()。`,
        err,
      );
    }
  }
}

/** 清空高亮（保留图层，避免反复增删） */
function clearHighlight(map: MapLibreMap) {
  const src = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

/**
 * 阶段31：把内部可见性键翻译成**给人看**的中文图层名，写进 AI 上下文。
 *
 * 输电线路总开关按下时列出具体电压档 —— 「用户在看的电压等级」比「开了输电线路」
 * 信息量大得多，也正是这个上下文的价值所在。
 */
function layersForContext(visible: readonly string[]): string[] {
  const names: string[] = [];
  for (const name of LAYERS) {
    if (!visible.includes(name)) continue;
    if (name === "输电线路") {
      const tiers = OSM_LINE_TIERS.filter((t) => visible.includes(t.vclass)).map(
        (t) => TIER_LABEL[t.vclass] ?? t.vclass,
      );
      names.push(tiers.length ? `输电线路（${tiers.join("、")}）` : "输电线路");
      continue;
    }
    names.push(name);
  }
  return names;
}

/** 阶段32：MapLibre 的瓦片像素尺寸（注意是 512，不是 256） */
const TILE_SIZE = 512;

/**
 * 由「相机中心 + 缩放 + 容器尺寸」推导视野 bbox（Web Mercator），与 MapLibre 内部算法一致。
 *
 * 🔴 为什么不直接用 `map.getBounds()`：
 *    地图页被切走时容器会变成 `display: none`，MapLibre 会把 transform 尺寸更新为 0，
 *    此后 `getBounds()` **不再等于用户看到过的范围**。实测后果：AI 收到的 bbox
 *    只有真实视野的一半多（0.55° x 0.35° 对 1.49° x 0.88°），
 *    于是「当前视野里最大的 N 个电厂」会漏掉本该在框内的电厂（上海 35 座只回了 6 座）。
 *    改用「中心 + 缩放 + 缓存的容器尺寸」后，切页、隐藏都不再影响结果。
 */
function boundsFromCamera(
  lon: number,
  lat: number,
  zoom: number,
  width: number,
  height: number,
): ViewportBbox {
  const world = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * world;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * world;

  const toLon = (px: number) => (px / world) * 360 - 180;
  const toLat = (py: number) => {
    const n = Math.PI - (2 * Math.PI * py) / world;
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  };

  return {
    minLon: Math.max(-180, toLon(x - width / 2)),
    maxLon: Math.min(180, toLon(x + width / 2)),
    // 屏幕 y 向下、纬度向上，所以 maxLat 对应 y - h/2
    minLat: Math.max(-85.0511, toLat(y + height / 2)),
    maxLat: Math.min(85.0511, toLat(y - height / 2)),
  };
}

/**
 * 阶段48：把镜头移到某个区域（首次启动向导完成后用）。
 *
 * ‼️ 单独一个类型，**不复用 `MapCommand`**：那条通道的载荷是 `ParsedQuery`，
 *    它是自然语言查询的契约（intent/fuel/country/limit），
 *    把「飞到一个 bbox」塞进去会污染 AI 那层的语义。
 */
export interface MapFlyTo {
  bbox: [number, number, number, number];
  /** 自增序号：同一个对象重复渲染不应反复移动地图 */
  seq: number;
}

interface MapPageProps {
  /** 来自设置页「在地图上查看」的指令；null 表示没有待执行的指令 */
  command?: MapCommand | null;
  /** 阶段48：向导完成后的镜头初始化请求 */
  flyTo?: MapFlyTo | null;
  /**
   * 阶段31：地图视野上下文的**唯一写入点**（AppLayout 持有，AI 面板只读）。
   * 用 ref 而不是 state：拖拽时 moveend 每秒触发多次，不能让整个应用跟着重渲染。
   */
  viewportRef?: RefObject<QueryContext | null>;
  /** 视野移动导致「上次的视野限定查询」失效时通知外层（事件表格据此清空） */
  onResultsStale?: () => void;
  /** 地图页查询框提问后，把解析结果交回外层下达指令（复用设置页同一条通道） */
  onViewOnMap?: (query: ParsedQuery) => void;
  /** 发起新查询前清掉地图上的旧高亮 */
  onClearMap?: () => void;
  /** 阶段32：点击结果行 → 飞到该电厂并单点高亮（由地图页查询框触发） */
  onFocusPlant?: (plant: PlantFocus) => void;
  /** 阶段32：当前被聚焦的电厂（用于查询框表格标出选中行） */
  focusedPlant?: PlantFocus | null;
  /** 阶段33：共享的多轮对话记忆 */
  history?: readonly ConversationTurn[];
  onQueryDone?: (turn: ConversationTurn) => void;
}

function MapPage({
  command = null,
  flyTo = null,
  viewportRef,
  onResultsStale,
  onViewOnMap,
  onClearMap,
  onFocusPlant,
  focusedPlant,
  history,
  onQueryDone,
}: MapPageProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  /**
   * 图层控制面板的展开 / 折叠。
   *
   * ‼️ 阶段47：**默认折叠**（用户拍板）。
   *    理由：首次启动向导刚走完时，用户的注意力应当全在地图上，不该一上来就被
   *    一长列图层开关占满视线；折叠态更「干净、不杂乱」。
   *
   *    实测收益（1280×800）：面板内可视高度约 695px，而展开时内容约 914px
   *    ⇒ 原本**溢出 219px、必须内部滚动**。折叠后 `.layerGroups`（约 454px）与
   *    同一开关控制的 `.legend`（约 88px）一起收起，内容降到约 372px ⇒ **不再滚动**。
   *
   *    ⚠️ 折叠**只隐藏内容，不删除任何东西**：分组标题（电力设施 / 基础设施 /
   *       环境与底图）、按电压分级、按能源细分、图例与视觉约定说明全部原样保留，
   *       展开后立刻回到原位。也**不改变任何图层的可见性**。
   */
  const [panelOpen, setPanelOpen] = useState(false);

  /**
   * 阶段47-1：图例的展开 / 折叠（**自己的开关**，与图层控制互不影响）。
   *
   * ‼️ 用户拍板：「图例解耦保留，但加一个 hidden 属性支持折叠」——
   *    向导首次启动时先给用户一张干净的地图，等他主动展开图例再看。
   *
   *    所以这里**不是**把图例重新绑回 panelOpen（那就退回共用一个开关的老路），
   *    而是给它一个独立状态 + 独立开关，默认折叠。
   *
   *    实测（1280×800，面板可视高度 695px）：
   *      图例展开 + 图层控制展开 = 912px ⇒ 溢出 219px
   *      图例折叠 + 图层控制折叠 = 373px ⇒ 溢出 0（当前默认）
   *    即只有用户**主动**把两块都展开时才会滚动，那是他自己的选择。
   */
  const [legendOpen, setLegendOpen] = useState(false);

  /** 阶段45：各分组的展开状态。默认只展开「电力设施」。 */
  const [openGroups, setOpenGroups] = useState<readonly string[]>(() =>
    LAYER_GROUPS.filter((g) => g.defaultOpen).map((g) => g.id),
  );
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );

  /**
   * 阶段54：「输电线路（按电压分级）」的展开状态（第三层，与 fuelMenuOpen 同一层）。
   *
   * ‼️ 为什么加这一层 —— 修掉 1280×800 下**手动展开「图层控制」后的溢出**。
   *
   *    实测（2026-09-18，1280×800，AI 工作台折叠，`.layerPanel` 的 max-height = 641px）：
   *
   *    | 状态                              | clientHeight | scrollHeight | 溢出  |
   *    |-----------------------------------|--------------|--------------|-------|
   *    | 本层折叠（**本次改动后的默认**）  | 590          | 590          | **0** |
   *    | 本层展开（= 改动前的默认）        | 641          | 706          | 65    |
   *    | 再展开「统计筛选」                | 641          | 1059         | 418   |
   *    | 再展开「图例」                    | 641          | 1110         | 469   |
   *
   *    🔴 **旧文档记的「溢出 11px」已过期** —— 那是阶段52 把 AI 工作台改成
   *       地图上方横向条**之前**的数。布局一变，可用高度少了约 52px，
   *       真实溢出是 **65px**（= 这 5 条电压档的整块高度 116px 减去原有余量）。
   *       ⇒ 以后引用这个数字前先重测，别照抄 PROJECT_HANDOFF §2。
   *
   * ⚠️ **默认折叠，是对既有行为的改变，必须知情**：
   *    这 5 条电压分级此前是**始终可见**的，现在需要多一次点击。
   *    接受这个代价的理由有三条：
   *      ① 「输电线路」总开关本身就能全开/全关线路（`toggleAllTiers`），
   *         电压分级是**细化**而不是唯一入口；
   *      ② 图例里同样有电压分级的色块说明，且图例本就默认折叠 ——
   *         口径一致，不是只为这一处破例；
   *      ③ 与同层的「统计筛选」(`fuelMenuOpen`) 默认值一致（都是 false）。
   *
   * ⚠️ **不改变任何图层的可见性**：折叠只隐藏复选框，勾选状态照旧（同 panelOpen 的约定）。
   *    「输电线路」总开关的 `anyTierOn` 计算也**不依赖**本状态。
   *
   * 残余（如实记录，不假装修干净）：
   *    ① 本层展开后仍溢出 65px —— 这 116px 是**真实内容**，不加宽面板/不缩字号
   *       就压不下去（`max-height` 641px 是硬上限）。折叠只是让**默认路径**干净。
   *    ② 「统计筛选」有 **15 个**燃料项（约 353px），展开后必然溢出 ——
   *       这是阶段47-1 已记录并接受的立场：用户主动全展开时可以滚动，
   *       `.layerPanel` 本就有 `overflow-y: auto` 兜底。
   */
  const [tierMenuOpen, setTierMenuOpen] = useState(false);

  /**
   * 阶段46：「按能源细分」子菜单的展开状态（第三层）。
   * 与 openGroups 同级但**故意不复用**：openGroups 管的是分组（第二层），
   * 复用会让「收起分组」与「收起能源细分」互相牵连。
   */
  const [fuelMenuOpen, setFuelMenuOpen] = useState(false);

  /**
   * 阶段48：「统计筛选」的勾选状态。
   *
   * ‼️ 它**只过滤左侧看板的统计数字，不改地图渲染** —— 用户拍板的方案。
   *
   *    原因：电厂是 cluster（聚合）数据源，聚合体的 `point_count` 是**数据源级**
   *    算好的，在图层上加 filter 只能藏掉散点，聚合圆里的数字照样把被过滤的
   *    电站算进去 —— 会得到「关掉煤电、聚合圆还写着 500」，做半套比不做更误导。
   *
   *    而统计走的是 SQL，过滤它既精确又零成本（结果集 ≤15 行，前端过滤即可），
   *    所以「只过滤统计」不是妥协，而是唯一能**做对**的那一半。
   */
  const [statFuels, setStatFuels] = useState<readonly string[]>(() =>
    FUEL_LEGEND.map(([fuel]) => fuel),
  );
  const toggleStatFuel = (fuel: string) =>
    setStatFuels((prev) =>
      prev.includes(fuel) ? prev.filter((f) => f !== fuel) : [...prev, fuel],
    );

  /** 阶段33：AI 工作台展开 / 折叠。展开时把左侧的图层控制与视野统计面板右推，避免抢空间 */
  const [benchOpen, setBenchOpen] = useState(true);

  /** 地图是否已完成建图 + 数据加载（此时才能执行飞行与高亮） */
  const mapReadyRef = useRef(false);
  /** 已执行过的命令 id，用于去重 */
  const appliedIdRef = useRef(-1);
  /** 早到的命令先存这里，等地图就绪后再消费 */
  const pendingCommandRef = useRef<MapCommand | null>(null);
  /** 给用户看的执行结果提示 */
  const [mapNotice, setMapNotice] = useState<string | null>(null);

  /** 阶段31：视野上下文的**展示副本**（防抖后更新，给地图页查询框那一行读数用）。
      真正用于解析的是 `viewportRef` —— 刚拖完就提问时它一定是最新的。 */
  const [viewportInfo, setViewportInfo] = useState<QueryContext | null>(null);
  /** 阶段32：缓存最后一次**有效**的容器尺寸（CSS 像素）—— 切页隐藏时容器为 0，不能拿它算 bbox */
  const viewSizeRef = useRef<{ w: number; h: number } | null>(null);
  /** 阶段31：上一次「限定当前视野」查询用的范围；视野一旦移动就作废 */
  const lastViewportQueryRef = useRef<ViewportBbox | null>(null);
  /**
   * 阶段32：聚焦会引发 **1~2 次**程序化移动 —— flyTo 一次，若动画没飞到位还有一次精确校准。
   * 这些都不是用户改视野，不能触发「过期清空」，否则刚点出来的单点高亮会被自己抹掉。
   * 用**计数**而不是布尔：只放过一次的话，第二次仍会把高亮清掉（实测踩到）。
   */
  const suppressStaleMovesRef = useRef(0);
  /** 阶段31：通知地图页查询框清空旧结果（视野已移动，结果不再对得上画面） */
  const [queryResetSeq, setQueryResetSeq] = useState(0);

  // 图层可见性：纯视觉开关，不加载任何数据
  // 阶段30：除三个大开关外，还包含 4 个电压分级键（「电压未知」不在其中 = 默认关闭）
  //
  // ‼️ 阶段50-C.3-A：初始值过一遍 `normalizeLayerKeys` —— 这是旧 key **唯一**
  //    可能的进入口（将来从 localStorage / 用户配置恢复面板状态时，
  //    恢复出来的可能是改名前的「GEM 煤炭数据」）。今天的初始值是常量、
  //    转换是恒等映射，但入口先摆好，加持久化时才不会漏。
  const [visibleLayers, setVisibleLayersRaw] = useState<readonly string[]>(() =>
    normalizeLayerKeys([...LAYERS, ...DEFAULT_ON_TIERS]),
  );

  /**
   * 阶段50-C.3-A：`visibleLayers` 的**唯一**写入通道。
   *
   * ‼️ 所有写入都过一遍 `normalizeLayerKeys`，维持这条不变量：
   *    **`visibleLayers` 里永远只出现当前 key**。
   *    只要有一次绕过（直接调 `setVisibleLayersRaw`）写进旧 key，
   *    下游的 `includes(GEM_PLANT_LAYER_NAME)` 就会静默失效 ——
   *    开关显示已打开、图层却不动，且没有任何报错。
   */
  const setVisibleLayers = (
    updater: (prev: readonly string[]) => readonly string[],
  ) => setVisibleLayersRaw((prev) => normalizeLayerKeys(updater(prev)));

  /**
   * 地图与数据是否都就绪。
   * `mapReadyRef` 是 ref，不触发重渲染；统计效果需要 state 版才能在就绪那一刻自动跑一次。
   */
  const [mapReady, setMapReady] = useState(false);

  /**
   * 阶段30：当前视野统计。
   * `exact=false` 表示低级别（z<8）瓦片为压体积未保留 `osm_id`，
   * 无法跨瓦片去重，只能按源统计（含瓦片边缘重复）。
   */
  const [viewStats, setViewStats] = useState<{
    plants: number;
    lines: number;
    substations: number;
    exact: boolean;
    /** 阶段48：视野内按燃料的**原始**统计（尚未套「统计筛选」） */
    fuels: FuelStat[];
    totalCapacityMw: number;
    missingCapacity: number;
  } | null>(null);

  /** 阶段48：左侧面板顶部「当前视野」区块的展开 / 折叠 */
  const [viewOpen, setViewOpen] = useState(true);

  /** 阶段52：导出当前视野电厂（exporting = 进行中，exportHint = 结果提示） */
  const [exporting, setExporting] = useState(false);
  const [exportHint, setExportHint] = useState<string | null>(null);

  /**
   * 阶段52：导出当前视野内的全部电厂为 CSV。
   *
   * ‼️ 为什么用 SQL 而不是 `queryRenderedFeatures`：电厂走 cluster 数据源，
   *    低缩放下只能拿到聚合圆（带 `point_count`），导不出单个电厂。
   *    与 `loadPlantStatsInBox` 同一条理由。
   * ⚠️ 范围取 `viewportRef.current`（权威视野）而非展示副本 —— 展示副本有 200ms
   *    防抖，会让导出范围与用户按下按钮那一刻的画面不一致。
   * ⚠️ 边界值走 `?` 占位符绑定（与 loadPlantStatsInBox 的内联数值写法不同，
   *    这里更严——无论如何都不需要拼接 SQL 字符串）。
   */
  const handleExportViewport = async () => {
    const ctx = viewportRef?.current;
    // `viewport` 在 QueryContext 上是可选的，必须单独取出并守卫
    const bbox = ctx?.viewport;
    if (!ctx || !bbox || exporting) return;

    setExporting(true);
    setExportHint(null);
    try {
      const { minLon, minLat, maxLon, maxLat } = bbox;
      const db = await Database.load(DB_URL);
      const rows = await db.select<Array<Record<string, unknown>>>(
        `SELECT gppd_idnr, name, country, primary_fuel, capacity_mw,
                lat, lon, commissioning_year, owner
           FROM power_plants
          WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
        [minLat, maxLat, minLon, maxLon],
      );

      const columns = [
        "gppd_idnr", "name", "country", "primary_fuel",
        "capacity_mw", "lat", "lon", "commissioning_year", "owner",
      ];

      // 坐标精度：5 位（~1m）
      const rounded = rows.map((r) => ({
        ...r,
        lat: typeof r.lat === "number" ? Number(r.lat.toFixed(5)) : r.lat,
        lon: typeof r.lon === "number" ? Number(r.lon.toFixed(5)) : r.lon,
      }));

      const z = ctx.zoom ?? 0;
      const zoomTag = z < 8 ? `_z${z.toFixed(0)}` : "";

      const res = await downloadCsv(columns, rounded, {
        filenamePrefix: "当前视野电厂",
        filenameSuffix: zoomTag,
      });
      if (res.ok) {
        const suffix = z < 8 ? "（当前缩放 z<8，坐标精度按源数据）" : "";
        setExportHint(res.message + suffix);
      } else {
        setExportHint(res.message);
      }
    } catch (err) {
      setExportHint(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      // 提示 6 秒后自动消失
      window.setTimeout(() => setExportHint(null), 6000);
    }
  };

  /**
   * 阶段48：把原始燃料统计套上「统计筛选」，并整理成可直接渲染的形状。
   *
   * ‼️ 过滤放在**前端**（结果集 ≤15 行），而不是往 SQL 里拼 `IN (...)`：
   *    少一个拼接面、零注入风险，也更好读。
   * ‼️ 合计（座数与容量）都由**过滤后**的集合重算 —— 否则用户看到
   *    「分项总和 ≠ 合计」会以为是 bug。
   */
  const fuelView = useMemo(() => {
    if (!viewStats) return null;
    const on = new Set(statFuels);
    const kept = viewStats.fuels.filter((f) => !!f.fuel && on.has(f.fuel));
    const dropped = viewStats.fuels.filter((f) => !f.fuel || !on.has(f.fuel));
    // 按容量降序（容量缺失的排最后）；与看板「按容量排序更能反映电力结构」的判断一致
    const rows = [...kept].sort((a, b) => (b.capacityMw ?? -1) - (a.capacityMw ?? -1));
    const top = rows.slice(0, TOP_FUEL_ROWS);
    const rest = rows.slice(TOP_FUEL_ROWS);
    return {
      count: rows.reduce((s, f) => s + f.count, 0),
      cap: rows.reduce((s, f) => s + (f.capacityMw ?? 0), 0),
      top,
      restKinds: rest.length,
      restCount: rest.reduce((s, f) => s + f.count, 0),
      restCap: rest.reduce((s, f) => s + (f.capacityMw ?? 0), 0),
      hasRest: rest.length > 0,
      hiddenCount: dropped.reduce((s, f) => s + f.count, 0),
      missingCapacity: viewStats.missingCapacity,
    };
  }, [viewStats, statFuels]);

  /**
   * 阶段48：响应向导的镜头初始化请求。
   *
   * ⚠️ 用 `fitBounds(..., { duration: 0 })` 而**不是 `flyTo`**：
   *    `flyTo` 的动画在 WebView2 里会中途停住（阶段32 实测），还得靠 moveend 校准。
   *    向导场景不需要动画，“直接到位”反而更好。
   * ⚠️ `maxZoom` 必须给：只装了一个小区域包时 fitBounds 会把地图放到极大。
   */
  const appliedFlySeqRef = useRef(-1);
  useEffect(() => {
    if (!flyTo) return;
    if (appliedFlySeqRef.current === flyTo.seq) return;
    // 地图未就绪就先不动；`mapReady` 在依赖里，就绪后本效果会自己重跑
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    appliedFlySeqRef.current = flyTo.seq;
    const [w, s, e, n] = flyTo.bbox;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40, duration: 0, maxZoom: 9 },
    );
  }, [flyTo, mapReady]);

  /**
   * 阶段39：区域数据包。
   *  `packsManifest` —— 清单（有哪些包、覆盖哪里），随前端一起分发。
   *  `packsAvailable` —— **本机实际装了哪些**（靠 127 字节 Range 探测得出，清单里没有这信息）。
   *  `activePacks` —— 当前按视口选中的包；它一变，图层同步 effect 就增删 source/layer。
   */
  const [packsManifest, setPacksManifest] = useState<PacksManifest | null>(null);
  const [packsAvailable, setPacksAvailable] = useState<readonly string[]>([]);
  const [activePacks, setActivePacks] = useState<readonly string[]>([]);
  /** 探测是一次性的，用 ref 防止 StrictMode 下重复探测（虽然归档缓存已幂等，这里省掉重复日志） */
  const packsProbedRef = useRef(false);

  /**
   * 阶段50-A：清单的 ref 镜像。
   *
   * ‼️ `onPackInstalled` 的订阅只注册一次（deps=`[]`），而它的回调里需要按
   *    **最新**清单判断「这个文件属于哪个品类」才能选对卸载函数。
   *    用 state 会发现回调永远只能看到首次挂载时的闭包值（通常还是 `null`），
   *    于是 GEM 文件变化时会被当成区域包处理 —— 卸载落空，而且不报错。
   */
  const packsManifestRef = useRef<PacksManifest | null>(null);

  /**
   * 阶段50-A：thematic overlay（当前只有 GEM）当前**是否应该挂着**的 ref 镜像。
   * ⚠️ 与 `activePacksRef` 同一个用途：挂载是异步的（要等归档 Range 探测），
   *    `then` 里必须复核「这期间开关是不是又被关掉了」，读的必须是最新值。
   */
  const gemWantedRef = useRef(false);

  /** 输电线路总开关的状态：任一电压档开启即为「开」 */
  const anyTierOn = LINE_TIER_KEYS.some((k) => visibleLayers.includes(k));

  /**
   * visibleLayers 的 ref 镜像。
   * ⚠️ 为什么必须要：refreshClusterLabels 定义在建图的 useEffect 里，
   *    那里的闭包永远只能看到 visibleLayers 的初始值；而它同时被
   *    moveend / sourcedata 回调调用。不靠 ref 镜像的话，
   *    「关掉电厂图层后再平移地图」会把聚合数字又画回来。
   */
  const visibleLayersRef = useRef<readonly string[]>(visibleLayers);

  /**
   * 聚合数字用的是 HTML Marker，**不受 MapLibre 的 visibility 管辖**，
   * 必须由外面拿到建图时的这两个函数手动刷新 / 清空。
   */
  const labelApiRef = useRef<{ refresh: () => void; clear: () => void } | null>(
    null,
  );

  /**
   * 阶段39：popup 实例的 ref 镜像。
   * ⚠️ 区域包的点击处理注册在**地图级**（`map.on("click", fn)` 不带 layerId），
   *    因为区域图层是随视口动态增删的 —— 没法在建图那一刻为它们逐个注册 layer 级处理。
   *    地图级回调必须能拿到 popup，而 popup 是建图 effect 里的局部变量，所以做镜像。
   */
  const popupRef = useRef<Popup | null>(null);
  /** 阶段39：activePacks 的 ref 镜像，供地图级 click 回调读到**最新**值 */
  const activePacksRef = useRef<readonly string[]>([]);

  /**
   * 阶段31：发布「当前视野 + 已选图层」上下文，供 AI 解析「当前视野」类问题。
   *
   * ⚠️ 写 ref 不触发重渲染 —— 拖拽时 moveend 每秒触发多次，走 state 会让整棵应用
   *    （含 3.5 万个点与聚合索引的地图）在最频繁交互的时刻反复重渲染。
   * ⚠️ 跨 180° 经线、或 z<2 绕地球一圈时 `east - west >= 360`，BETWEEN 会变成
   *    反区间（min > max）而永远查不到东西，所以直接退化为全球、不加视野约束。
   */
  const publishViewport = (): QueryContext | null => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return null;

    // ⚠️ 容器可见时才更新缓存尺寸；不可见（display:none）时沿用最后一次有效值 ——
    //    这正是「切页后 bbox 变小」的修法：不再让隐藏状态污染视野上下文。
    //    可见时读取真实尺寸还能自愈：即使曾缓存过错误尺寸，下一次可见就会被纠正。
    const el = map.getContainer();
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) viewSizeRef.current = { w, h };

    const size = viewSizeRef.current;
    // 宁可暂时不提供上下文，也不提供错的
    if (!size) return null;

    const c = map.getCenter();
    const bbox = boundsFromCamera(c.lng, c.lat, map.getZoom(), size.w, size.h);

    const ctx: QueryContext = {
      viewport: {
        minLon: Number(bbox.minLon.toFixed(6)),
        minLat: Number(bbox.minLat.toFixed(6)),
        maxLon: Number(bbox.maxLon.toFixed(6)),
        maxLat: Number(bbox.maxLat.toFixed(6)),
      },
      zoom: Number(map.getZoom().toFixed(2)),
      layers: layersForContext(visibleLayersRef.current),
    };

    if (viewportRef) viewportRef.current = ctx;
    return ctx;
  };

  /**
   * 阶段31：视野移动后，上一个「限定当前视野」的结果已对不上当前画面。
   *
   * 必须把高亮与表格**一起**清掉 —— 否则会留下「地图飘走了、表格还停在那块
   * 区域」的误导组合。本函数只负责发现与清空，设置页表格靠 onResultsStale 通知。
   */
  const dropStaleViewportQuery = () => {
    // ‼️ 阶段32：放过「聚焦自身引起的」那几次移动。
    //    计数减到 0 的那一次（真正的终点）才刷新基准视野 —— 否则 flyTo 停在半路时
    //    会把「半路的位置」当成基准，紧接着的校准就会被误判成用户改了视野。
    if (suppressStaleMovesRef.current > 0) {
      suppressStaleMovesRef.current -= 1;
      // ⚠️ 只有**本来就存在**「视野限定查询」时才刷新基准。
      //    否则会把一个「没限定视野」的查询变成被监视状态 ——
      //    用户随手一动就会把结果表清掉（实测踩到：点名后切回设置页，表格没了）。
      if (suppressStaleMovesRef.current === 0 && lastViewportQueryRef.current) {
        lastViewportQueryRef.current = publishViewport()?.viewport ?? null;
      }
      return;
    }

    const previous = lastViewportQueryRef.current;
    if (!previous) return;

    const now = publishViewport()?.viewport;
    if (!now || !viewportChanged(previous, now)) return;

    lastViewportQueryRef.current = null;
    const map = mapRef.current;
    if (map) clearHighlight(map);
    setMapNotice("视野已移动：上次「当前视野」查询的结果已清空，请重新查询。");
    setQueryResetSeq((n) => n + 1);
    onResultsStale?.();
  };

  /**
   * 执行地图指令：飞到目标区域 + 高亮匹配的电厂。
   * ⚠️ 筛选值全部走 SQL 参数绑定（见 nlq.ts 的 buildBoundsSql / buildHighlightSql），
   *    不拼接任何用户输入。
   */
  const applyCommand = async (cmd: MapCommand) => {
    const map = mapRef.current;
    if (!map) return;

    // 阶段25：只清空高亮、不动视角。
    // 新查询发起时会先发这条指令，让地图与表格同时进入「空白待刷新」状态。
    if (cmd.clearOnly) {
      clearHighlight(map);
      setMapNotice(null);
      return;
    }

    // ‼️ 阶段32：聚焦到**单个**电厂（点击结果表格行）。
    //    刻意不重跑 SQL、不清空结果表：「定位」与「查询」是两件事，
    //    点一行就把整张表换成一座电厂会让用户一下子找不到刚才的列表。
    //    因此这个分支要放在最前面（也省掉一次数据库往返）。
    if (cmd.focus) {
      const f = cmd.focus;
      clearHighlight(map);
      // 这次移动是程序发起的，不要让过期检测把它当成“用户改了视野”
      suppressStaleMovesRef.current = 1;
      // 高亮半径同样按容量分级，所以把容量一并带上
      renderHighlight(map, [
        { lat: f.lat, lon: f.lon, capacity_mw: f.capacityMW },
      ]);

      // 高亮层是首次高亮时才建的，此刻才存在 —— 补一次可见性设置，
      // 否则「先关掉电厂图层、再点行定位」会出现只有金环、没有底点的状态。
      if (map.getLayer(HIGHLIGHT_LAYER_ID)) {
        map.setLayoutProperty(
          HIGHLIGHT_LAYER_ID,
          "visibility",
          visibleLayersRef.current.includes("电厂") ? "visible" : "none",
        );
      }

      map.flyTo({
        center: [f.lon, f.lat],
        // 只放大、不缩小：用户可能已经看得比 FOCUS_ZOOM 更近，
        // 硬拉回 11 反而会倒退。
        zoom: Math.max(map.getZoom(), FOCUS_ZOOM),
        duration: 1200,
      });
      // ‼️ 保底校准：实测本机 WebView2 里 flyTo 的动画会**在途中停住** ——
      //    停稳后中心仍偏离目标约 11 km（可复现，且不是“还没飞完”）。
      //    不管原因在动画还是渲染节流，「结果必须精确落在该电厂坐标上」这一点不能让步，
      //    所以在这次移动结束时校准一次；偏差在阈值内则是空操作，不会产生抖动。
      map.once("moveend", () => {
        const c = map.getCenter();
        if (Math.abs(c.lng - f.lon) > 1e-4 || Math.abs(c.lat - f.lat) > 1e-4) {
          // 这一次也是程序发起的移动，同样要让过期检测放过
          suppressStaleMovesRef.current += 1;
          map.jumpTo({
            center: [f.lon, f.lat],
            zoom: Math.max(map.getZoom(), FOCUS_ZOOM),
          });
        }
      });
      setMapNotice(
        `已定位到「${f.name}」` +
          (f.capacityMW != null ? `（${f.capacityMW} MW）` : "") +
          "，金色描边就是它；点它可看详情。",
      );
      return;
    }

    try {
      const db = await Database.load(DB_URL);

      // 全球概览：飞回默认视图。全球不做单点高亮 —— 3.5 万个点毫无意义且会卡
      if (cmd.intent === "global_stats") {
        clearHighlight(map);
        // ‼️ 阶段31：带了「当前视野」就**不能**飞回全球视图 —— 用户正看着那块区域，
        //    把他拽回全球会让视野限定的结果立刻变得毫无意义。数字在查询框里看。
        if (cmd.viewport) {
          lastViewportQueryRef.current = cmd.viewport;
          setMapNotice("当前视野总量概览：数字见查询结果，视角保持不变。");
          return;
        }
        setMapNotice("已回到全球视图（全球概览不做单点高亮）");
        map.flyTo({
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          duration: 1200,
        });
        return;
      }

      // ‼️ 阶段31：限定「当前视野」的查询**不移动地图**。
      //    用户就在看那块区域，fitBounds 反而会因 padding 把视野收窄 ——
      //    而视野一变，刚得到的结果会立刻被判成过期（自己把自己清掉）。
      //    所以直接跳过取 bbox 这一步：boundsRows 为空，下面的飞行分支自然不执行。
      lastViewportQueryRef.current = cmd.viewport ?? null;
      let boundsRows: Array<{
        min_lon: number | null;
        min_lat: number | null;
        max_lon: number | null;
        max_lat: number | null;
      }> = [];
      if (!cmd.viewport) {
        // 1) 用**数据算出来的** bbox 决定飞到哪里，代码里不硬编码任何国家边界
        const boundsPlan = buildBoundsSql(cmd);
        boundsRows = (await db.select(boundsPlan.sql, boundsPlan.params)) as typeof boundsRows;
      }

      const b = boundsRows[0];
      if (
        b &&
        b.min_lon != null &&
        b.min_lat != null &&
        b.max_lon != null &&
        b.max_lat != null
      ) {
        map.fitBounds(
          [
            [b.min_lon, b.min_lat],
            [b.max_lon, b.max_lat],
          ],
          // fitBounds 会自动算出贴合的范围级别，不用猜 zoom
          { padding: 90, duration: 1200, maxZoom: 11 },
        );

        // ⚠️ 飞完再兜一层最低缩放。
        //    fitBounds 只支持 maxZoom，不支持 minZoom；而结果散布全球时
        //    算出的级别会很低，容量分级在那级别下几乎看不出来。
        //    用 once 而不是 on，避免每次移动都检查。
        map.once("moveend", () => {
          if (mapRef.current && map.getZoom() < MIN_COMMAND_ZOOM) {
            map.easeTo({ zoom: MIN_COMMAND_ZOOM, duration: 400 });
          }
        });
      }

      // 2) 取明细点做高亮（SQL 里多取一个，用于判断是否超限）
      const hlPlan = buildHighlightSql(cmd);
      const points = (await db.select(hlPlan.sql, hlPlan.params)) as Array<{
        name: string;
        lat: number;
        lon: number;
        capacity_mw: number | null;
      }>;

      if (points.length > MAX_HIGHLIGHT_POINTS) {
        clearHighlight(map);
        setMapNotice(
          `匹配的电厂超过 ${MAX_HIGHLIGHT_POINTS} 个上限（如「中国全部电厂」有 4235 个），` +
            `点太多高亮会卡顿，因此只飞行、未高亮，放大后可自行查看。`,
        );
        return;
      }

      renderHighlight(map, points);
      // 高亮层是首次高亮时才建的，此刻才存在 —— 补一次可见性设置，
      // 否则「先关掉电厂图层、再执行查询」会出现光有金环没有底点的状态。
      if (map.getLayer(HIGHLIGHT_LAYER_ID)) {
        map.setLayoutProperty(
          HIGHLIGHT_LAYER_ID,
          "visibility",
          visibleLayersRef.current.includes("电厂") ? "visible" : "none",
        );
      }
      const scope = cmd.viewport ? "（限定当前视野）" : "";
      setMapNotice(
        points.length > 0
          ? `已高亮 ${points.length} 个匹配的电厂${scope}（金色描边）`
          : `没有匹配到电厂${scope}`,
      );
    } catch (err) {
      console.error("[MapPage] 执行地图指令失败", err);
      setMapNotice("执行地图指令失败，详见控制台。");
    }
  };

  /** 只有「地图已就绪 + 确实有待处理命令」时才真正执行 */  const tryApplyCommand = () => {
    const pending = pendingCommandRef.current;
    if (!pending || !mapReadyRef.current || !mapRef.current) return;
    if (pending.id === appliedIdRef.current) return;

    appliedIdRef.current = pending.id;
    pendingCommandRef.current = null;
    void applyCommand(pending);
  };

  // 地图实例的创建与销毁都在这个 effect 里。
  // ⚠️ main.tsx 开了 React StrictMode，开发模式下 effect 会「执行 → 清理 → 再执行」，
  //    所以 cleanup 必须真的 map.remove()，否则会出现“容器已初始化”报错或实例泄漏。
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // 底图归档的定位是异步的（要解析资源路径并探测 Range），所以建图必须等它就绪：
    // 否则建图时 MapLibre 的第一批瓦片请求会全部落空。
    // 注意：它**不会** reject，拿不到底图时返回 null，此时退化成纯色背景。
    let disposed = false;
    /** 页面用 display:none 切换可见性，容器尺寸会变，需要它来触发 map.resize() */
    let resizeObserver: ResizeObserver | null = null;

    // ---- 聚合数字标记 ----
    // 用 HTML 标记而非 symbol 图层：本项目样式是全离线内联的，没有 `glyphs`
    // 字体服务器，symbol 的 text-field 根本渲染不出来。
    // 数组与清理函数都在本次 effect 生命周期内，StrictMode 的“建→拆→再建”不会泄漏。
    const clusterLabels: Marker[] = [];
    const clearClusterLabels = () => {
      clusterLabels.forEach((m) => m.remove());
      clusterLabels.length = 0;
    };

    // 复用同一个 Popup 实例，避免每次点击都重建 DOM
    const popup = new Popup({
      closeButton: true,
      closeOnClick: true,
      offset: 12,
      maxWidth: "260px",
    });

    // 阶段36：每次弹窗打开时把它搬到 `.viewport`（地图容器的父节点）——
    // 用 open 事件挂钩而不是在每个点击处理里手写，这样能覆盖全部弹窗来源（当前 5 处）。
    popup.on("open", () => {
      liftPopup(popup, mapContainerRef.current?.parentElement);
    });
    // 阶段39：把 popup 镜像到 ref，供区域包的地图级点击回调使用
    popupRef.current = popup;

    ensureBasemapArchive()
      .then((basemap) => {
        // 等待期间组件可能已卸载（StrictMode 下必然发生一次），此时不能再建图
        if (disposed || !mapContainerRef.current) return;

        const map = new MapLibreMap({
          container: mapContainerRef.current,
          style: buildBasemapStyle(basemap),
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          // 保留版权信息（合规），右下角紧凑显示，不与我们左下角的比例尺冲突
          attributionControl: { compact: true },
          // 阶段15 从 6 提到 12。原来的 6 是为合成夹具设的，但它会把
          // clusterMaxZoom(8) 卡死 —— 点击聚合点算出的目标级别被截断后，
          // 永远展不开到单个电厂。
          // 阶段26：底图最高只切到 z8，再往里由 MapLibre 自动 overzoom（矢量放大不糊，
          // 只是细节不再增加），所以底图的级别上限不再限制地图的 maxZoom。
          maxZoom: 12,
        });
        mapRef.current = map;

        // 底图缺失时明确告知用户，而不是让人对着一张空地图猜
        if (!basemap) {
          setMapNotice(BASEMAP_MISSING_NOTICE);
        }

        // ⚠️ 页面常驻、用 display:none 切换可见性，容器尺寸会从 0 变回正常，
        //    MapLibre 必须 resize 才能重算画布尺寸与瓦片加载范围。
        //    ResizeObserver 是浏览器原生能力，零依赖。
        resizeObserver = new ResizeObserver(() => {
          mapRef.current?.resize();
        });
        if (mapContainerRef.current) {
          resizeObserver.observe(mapContainerRef.current);
        }

        // 比例尺改用 MapLibre 自带的 ScaleControl（库自带，零新增依赖），
        // 取代原先写死“500 km”的静态占位。
        map.addControl(
          new ScaleControl({ maxWidth: 100, unit: "metric" }),
          "bottom-left",
        );

        // 把 SQLite 里的电厂渲染成圆点图层。
        // 等 style 加载完再 addSource/addLayer —— 未加载完就加会抛错。
        map.once("load", () => {
          // ⚠️ 必须先把连接池建起来（这一步才会执行 migration），再并发查三张表。
          //
          // 曾经的写法是三个 loadXxxGeoJson() 各自 await Database.load() 后 Promise.all，
          // 结果是**竞态**：只有首次 load 会触发 migration v3（灌入演示电网数据），
          // 另外两个的 SELECT 可能在迁移提交之前就执行完，拿到空结果。
          // 实测表现极具迷惑性 —— 统计页能查到 200 个变电站，地图上却一个点都没有。
          // 阶段28：OSM 电网数据与数据库查询并行发出。
          // 两者互不依赖，用 Promise.all 一起等；OSM 失败只会返回 null，不影响其它。
          Promise.all([
            // 阶段29：优先用本地 PMTiles 瓦片；缺归档才退回小样本 GeoJSON。
            // 顺序很重要 —— 有归档时**不该**再去下载那份 GeoJSON。
            ensureOsmGridArchive().then(async (grid) => ({
              grid,
              fallback: grid ? null : await loadOsmGridData(),
            })),
            Database.load(DB_URL).then(() =>
              Promise.all([
                loadSubstationsGeoJson(),
                loadLinesGeoJson(),
                loadPlantsGeoJson(),
              ]),
            ),
          ]).then(([{ grid, fallback }, [substationData, lineData, data]]) => {
            // 等异步查询期间组件可能已卸载，此时不能碰地图
            if (disposed || !mapRef.current) return;

            // ---- 阶段28/29：真实 OSM 电网（最先加，压在所有点图层之下）----
            addOsmGridLayers(map, grid, fallback);
            if (grid) {
              // 走瓦片，正常情况，不提示
            } else if (fallback) {
              setMapNotice(OSM_FALLBACK_NOTICE);
            } else {
              setMapNotice(OSM_MISSING_NOTICE);
            }

              // ---- 阶段21 图层一：输电线路（最底层）----
              map.addSource(LINES_SOURCE, { type: "geojson", data: lineData });
              map.addLayer({
                id: LINES_LAYER_ID,
                type: "line",
                source: LINES_SOURCE,
                layout: {
                  // 圆角收尾，避免折角处出现尖刺毛边
                  "line-cap": "round",
                  "line-join": "round",
                },
                paint: {
                  "line-color": LINE_COLOR,
                  // 轻微透明：既要看得见电网骨架，又不能压过上面的点
                  "line-opacity": 0.55,
                  // 按电压分级线宽，一眼分出主干与支线
                  "line-width": [
                    "step",
                    ["get", "voltage"],
                    1,
                    220,
                    1.6,
                    500,
                    2.6,
                  ],
                },
              });

              // ---- 阶段21 图层二：变电站 ----
              map.addSource(SUBSTATIONS_SOURCE, {
                type: "geojson",
                data: substationData,
              });
              map.addLayer({
                id: SUBSTATIONS_LAYER_ID,
                type: "circle",
                source: SUBSTATIONS_SOURCE,
                paint: {
                  "circle-color": SUBSTATION_COLOR,
                  // 半径与描边都按电压分级。
                  // 阶段22 把间距从 4/5.5/7 拉大到 3.5/6/9 —— 原来差距太小，
                  // 实测在小比例尺下几乎分不出等级。1000kV 档为将来接
                  // 真实特高压数据预留（当前演示数据里没有，写了也不会出错）。
                  "circle-radius": [
                    "step",
                    ["get", "voltage"],
                    3.5,
                    220,
                    6,
                    500,
                    9,
                    1000,
                    12,
                  ],
                  "circle-opacity": 0.9,
                  "circle-stroke-color": "#06333a",
                  "circle-stroke-width": [
                    "step",
                    ["get", "voltage"],
                    1,
                    220,
                    1.2,
                    500,
                    1.6,
                    1000,
                    2,
                  ],
                },
              });

              // ---- 阶段22：输电线路的透明点击热区 ----
              // 放在视觉线之后添加，保证它在同一位置上「压得住」细线，
              // 但因为它完全透明，视觉上完全看不出多了一层。
              map.addLayer({
                id: LINES_HIT_LAYER_ID,
                type: "line",
                source: LINES_SOURCE,
                layout: {
                  "line-cap": "round",
                  "line-join": "round",
                },
                paint: {
                  // 颜色无所谓（opacity 为 0），给个黑色只是为了让属性完整
                  "line-color": "#000000",
                  "line-width": LINES_HIT_WIDTH,
                  "line-opacity": 0,
                },
              });

              // 开启 MapLibre **内置**聚合：低缩放级别下把邻近电厂合并成聚合点，
              // 避免 3.5 万个点重叠成一团糊。算法由库自带，未安装任何聚合库。
              map.addSource(PLANTS_SOURCE, {
                type: "geojson",
                data,
                cluster: true,
                clusterRadius: 50,
                clusterMaxZoom: 8,
                // ⚠️ WRI 数据采用 CC BY 4.0 许可，**要求署名**，这段来源说明必须保留。
                // 阶段26 之前它被挂在底图源上（权宜之计）；现在底图源挂 OSM 署名，
                // 这里才是它真正该在的位置。
                attribution: "电厂数据 © WRI Global Power Plant Database (CC BY 4.0)",
              });

              // 图层一：聚合圆（只渲染带 point_count 的要素）
              map.addLayer({
                id: CLUSTER_LAYER_ID,
                type: "circle",
                source: PLANTS_SOURCE,
                filter: ["has", "point_count"],
                paint: {
                  // step 是 MapLibre 内置表达式，不是引入的库。
                  // 分级：<10 蓝 / 10~99 绿 / 100~499 黄 / >=500 红，
                  // 半径同步放大，让密集区域一眼可辨。
                  "circle-color": [
                    "step",
                    ["get", "point_count"],
                    "#4daafc",
                    10,
                    "#5ee39b",
                    100,
                    "#ffd24a",
                    500,
                    "#ff6b6b",
                  ],
                  "circle-radius": [
                    "step",
                    ["get", "point_count"],
                    15,
                    10,
                    18,
                    100,
                    22,
                    500,
                    26,
                  ],
                  "circle-opacity": 0.85,
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 1,
                  "circle-stroke-opacity": 0.4,
                },
              });

              // 图层二：单个电厂（只渲染没有 point_count 的要素）
              map.addLayer({
                id: PLANT_LAYER_ID,
                type: "circle",
                source: PLANTS_SOURCE,
                filter: ["!", ["has", "point_count"]],
                paint: {
                  // 阶段24：半径按装机容量分级，并与缩放级别联动。
                  //
                  // ⚠️ 为什么要联动：库里 3.5 万个点，容量跨度 0.1~7000 MW。
                  //    若固定一套半径，低缩放时大点会糊成一片色块，
                  //    高缩放时小点又几乎看不见 —— 两头都不好用。
                  //    低缩放看分布密度，高缩放才看个体差异。
                  //
                  // step 是 MapLibre 原生表达式，语义等价于 switch-case，
                  // 零依赖、零 JS 计算，且能感知 zoom（JS 预计算做不到这点）。
                  "circle-radius": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    3,
                    ["step", ["get", "capacity"], 1.2, 100, 2, 500, 3, 1000, 4.5],
                    8,
                    ["step", ["get", "capacity"], 3, 100, 5, 500, 7, 1000, 10],
                  ],
                  // 颜色由属性携带（见 loadPlantsGeoJson 里的 fuelColor 映射）
                  "circle-color": ["get", "color"],
                  "circle-opacity": 0.9,
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 0.5,
                  "circle-stroke-opacity": 0.6,
                },
              });

              // ---- GEM 层由 PMTiles vector 通道提供 ----
              // ⚠️ 阶段50-C.1：这里原先是**建图期**就挂上的一个空 GeoJSON 源
              //    （`gem-coal`）+ 两个 circle 图层，数据由 `loadGemPlants()` 读
              //    SQLite 后 `setData` 注入。那整条通道已删除。
              //    GEM 现在是 thematic overlay：由「开关 + 数据包是否已安装」
              //    驱动的独立生命周期 effect 挂载（见 addGemPlantLayers），
              //    建图时不占任何 source/layer。
              //
              // ‼️ 为什么不在建图期就挂：归档要**下载**才能拿到，建图时并不存在；
              //    而且默认关闭，不开这个层的用户不该为它付内存。

              // ‼️ addLayer 会追加到样式最顶，会盖住地名标签 —— 与区域包那里同一个坑
              if (map.getLayer(BASEMAP_LABEL_LAYER_ID)) {
                map.moveLayer(BASEMAP_LABEL_LAYER_ID);
              }

              // ---- 聚合数字：用 HTML 标记而非 symbol 图层 ----
              // ⚠️ 为什么不用 symbol 图层的 text-field？文字渲染需要 `glyphs`
              //    （SDF 字体 PBF），而本项目样式是全离线内联的，没有字体服务器，
              //    数字会直接渲染不出来。HTML 标记零外部资源，样式还能走 CSS Modules。
              // ⚠️ querySourceFeatures 会**跨瓦片边界重复返回同一个聚合要素**，
              //    必须按 cluster_id 去重，否则数字会叠影。
              const refreshClusterLabels = () => {
                clearClusterLabels();

                // ⚠️ 电厂图层被关掉时不重建数字：Marker 不在 MapLibre 的
                //    visibility 管辖范围内，不管就会在空地图上飘一堆数字。
                if (!visibleLayersRef.current.includes("电厂")) return;

                const seen = new Set<number>();
                for (const f of map.querySourceFeatures(PLANTS_SOURCE, {
                  filter: ["has", "point_count"],
                })) {
                  const clusterId = f.properties?.cluster_id as number | undefined;
                  const count = f.properties?.point_count as number | undefined;
                  if (clusterId == null || count == null) continue;
                  if (seen.has(clusterId)) continue;
                  seen.add(clusterId);

                  const el = document.createElement("span");
                  el.className = styles.clusterLabel;
                  el.textContent = String(count);

                  clusterLabels.push(
                    new Marker({ element: el })
                      .setLngLat(
                        (f.geometry as Point).coordinates as [number, number],
                      )
                      .addTo(map),
                  );
                }
              };

              // 动画期间标记会与圆错位，干脆先清掉、移动结束后再重建
              map.on("movestart", clearClusterLabels);
              map.on("moveend", refreshClusterLabels);

              // 把两个函数交给外部：图层开关需要能在不开图的情况下主动清空 / 重建数字
              labelApiRef.current = {
                refresh: refreshClusterLabels,
                clear: clearClusterLabels,
              };
              // ⚠️ 必须监听 sourcedata：addLayer 之后数据仍要在 worker 里构建聚合索引，
              //    此刻立刻调用 querySourceFeatures 会返回空数组 —— 表现为
              //    「聚合圆都画出来了，但数字一个都不显示」。所以要等 source
              //    真正加载完成后再刷新一次。
              map.on("sourcedata", (e) => {
                if (e.sourceId === PLANTS_SOURCE && e.isSourceLoaded) {
                  refreshClusterLabels();
                }
              });
              refreshClusterLabels();

              // ---- 点击聚合点：平滑放大到恰好能展开它的级别 ----
              map.on("click", CLUSTER_LAYER_ID, (e) => {
                const feature = e.features?.[0];
                if (!feature) return;
                const clusterId = feature.properties?.cluster_id as
                  | number
                  | undefined;
                if (clusterId == null) return;

                const source = map.getSource(PLANTS_SOURCE) as GeoJSONSource;
                const center = (feature.geometry as Point).coordinates as [
                  number,
                  number,
                ];

                // getClusterExpansionZoom 直接给出「恰好能把这个聚合点拆开」的
                // 级别，比固定加几级更准（它是 cluster:true 时 source 的内置方法）
                source
                  .getClusterExpansionZoom(clusterId)
                  .then((zoom) => {
                    if (disposed || !mapRef.current) return;
                    map.easeTo({ center, zoom, duration: 600 });
                  })
                  .catch((err: unknown) => {
                    console.error("[MapPage] 展开聚合点失败", err);
                  });
              });

              // ---- 点击单个电厂：弹出详情卡片 ----
              map.on("click", PLANT_LAYER_ID, (e) => {
                const feature = e.features?.[0];
                if (!feature) return;

                const point = (feature.geometry as Point).coordinates as [
                  number,
                  number,
                ];

                popup
                  .setLngLat(point.slice() as [number, number])
                  .setDOMContent(
                    buildPlantPopup(
                      feature.properties as PlantProperties,
                      point,
                    ),
                  )
                  .addTo(map);
              });

              // ---- 阶段22：点击变电站：弹出详情卡片 ----
              map.on("click", SUBSTATIONS_LAYER_ID, (e) => {
                // 「点优先」：该位置若有电厂，交给电厂自己的 handler。
                // 两层共用一个 popup 实例，不判定的话后执行的会覆盖先执行的。
                const onPlant = map.queryRenderedFeatures(e.point, {
                  layers: [PLANT_LAYER_ID],
                });
                if (onPlant.length > 0) return;

                const feature = e.features?.[0];
                if (!feature) return;

                const point = (feature.geometry as Point).coordinates as [
                  number,
                  number,
                ];

                popup
                  .setLngLat(point.slice() as [number, number])
                  .setDOMContent(
                    buildSubstationPopup(
                      feature.properties as SubstationProperties,
                    ),
                  )
                  .addTo(map);
              });

              // ---- 阶段22：点击输电线路（绑在透明热区层上）----
              map.on("click", LINES_HIT_LAYER_ID, (e) => {
                // 「点优先」：热区宽 14px，而变电站半径只有 3.5~9px，
                // 线穿过站点时热区必然会盖住它。不判定的话，用户想点变电站
                // 却会弹出线路信息 —— 这是本项目里最容易忽略的一处。
                const onPoint = map.queryRenderedFeatures(e.point, {
                  layers: [SUBSTATIONS_LAYER_ID, PLANT_LAYER_ID],
                });
                if (onPoint.length > 0) return;

                // 阶段34：同一位置若压着**真实切片**上的线路，让给那个 handler。
                // 两份数据都有线，共用同一个 popup 实例，后执行的会覆盖先执行的；
                // 显式让真实数据优先，就不依赖委托监听器的执行顺序了。
                const onOsmLine = map.queryRenderedFeatures(e.point, {
                  layers: [OSM_LINES_HIT_LAYER_ID],
                });
                if (onOsmLine.length > 0) return;

                const feature = e.features?.[0];
                if (!feature) return;

                const coords = (feature.geometry as LineString).coordinates as [
                  number,
                  number,
                ][];
                // 弹窗挂在线的中点而不是鼠标处：否则点在线段末端时，
                // 弹窗会贴到视窗边缘甚至被裁掉。
                const anchor = coords[Math.floor(coords.length / 2)];
                if (!anchor) return;

                popup
                  .setLngLat(anchor.slice() as [number, number])
                  .setDOMContent(
                    buildLinePopup(feature.properties as LineProperties, coords),
                  )
                  .addTo(map);
              });

              // ---- 阶段41：OSM 线路的 layer-scoped 处理器已**移除** ----
              // 原先核心区走 layer-scoped、区域包走地图级，是两条独立路径。
              // 两条都用「命中了点要素就 return」防弹窗盖住点，却都没真正处理点要素，
              // 导致点击变电站/电厂被吞掉后什么都不发生。
              // 现在统一到下面那个地图级回调 + `showOsmPointOrLine`，
              // 从根上杜绝「只改一条路径」造成的半修状态。

              // ---- 光标反馈 ----
              // 阶段41：把 OSM 切片里的**点图层**也纳入指针反馈 ——
              // 它们现在真的能点开弹窗了，不给 pointer 提示用户根本不知道能点。
              for (const layerId of [
                CLUSTER_LAYER_ID,
                PLANT_LAYER_ID,
                SUBSTATIONS_LAYER_ID,
                LINES_HIT_LAYER_ID,
                OSM_LINES_HIT_LAYER_ID,
                OSM_PLANT_LAYER_ID,
                OSM_SUBSTATION_LAYER_ID,
              ]) {
                map.on("mouseenter", layerId, () => {
                  map.getCanvas().style.cursor = "pointer";
                });
                map.on("mouseleave", layerId, () => {
                  map.getCanvas().style.cursor = "";
                });
              }

              // ---- 阶段41：点击 OSM 切片上的**点要素（变电站 / 电厂）与线路** ----
              // 统一为一个地图级回调，核心区与区域包共用同一个 `showOsmPointOrLine`。
              //  · 区域包图层随视口动态增删，建图那一刻还不存在，
              //    没法给它们逐个注册 layer 级处理器 —— 所以必须走地图级。
              //  · 地图级回调自己按 `activePacksRef` 拼出当前该查的图层集。
              map.on("click", (e) => {
                showOsmPointOrLine(map, e, {
                  popup: popupRef.current ?? popup,
                  packKeys: activePacksRef.current,
                });
              });

              // 阶段27：地名标签必须压在所有电力图层之上。
              // 样式里的图层先于本回调里的 addLayer 执行，所以现在用 moveLayer（不给 beforeId
              // 即移到最顶）把它提上来 —— 否则 3.5 万个电厂点会把文字盖住。
              if (map.getLayer(BASEMAP_LABEL_LAYER_ID)) {
                map.moveLayer(BASEMAP_LABEL_LAYER_ID);
              }

              // 地图与数据都就绪了，到这一步才能执行飞行与高亮。
              // 顺便消费掉可能早于地图到达的那条指令。
              mapReadyRef.current = true;
              setMapReady(true);
              tryApplyCommand();
            })
            .catch((err: unknown) => {
              // 在 Tauri 之外（例如用 Vite 浏览器预览 UI）必然失败，
              // 这里只记日志，绝不能让电厂数据加载失败影响底图。
              console.error("[MapPage] 电厂数据加载失败（底图不受影响）", err);
            });
        });
      })
      .catch((err: unknown) => {
        console.error("[MapPage] 离线瓦片归档加载失败，地图未创建", err);
      });

    return () => {
      disposed = true;
      mapReadyRef.current = false;
      resizeObserver?.disconnect();
      // 先摘掉标记与弹窗，再销毁地图
      clearClusterLabels();
      popup.remove();
      // 阶段50-A：GEM 的监听器登记在**模块级** Map 里，`map.remove()` 只销毁
      // map 自身的监听器，**不会**清它 —— 那条记录会继续持有已销毁的 map 与 popup。
      // 若组件重挂载后 GEM 没被再次挂载（探测未完成 / 开关没开），
      // 这条记录就再也没有机会被后来者覆盖 ⇒ 长期占着一份已废弃的地图内存。
      gemPmtilesHandlers.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // 指令变化时尝试执行：地图已就绪就立即执行；否则先暂存，
  // 等建图完成后的 tryApplyCommand() 来消费。
  // （tryApplyCommand 不放进依赖：它是每次渲染重建的普通函数，
  //   靠 ref 读最新状态，无需也不应作为依赖。）
  useEffect(() => {
    if (!command || command.id === appliedIdRef.current) return;
    pendingCommandRef.current = command;
    tryApplyCommand();
  }, [command]);

  const toggleLayer = (name: string) => {
    setVisibleLayers((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  /** 阶段30：切换单个电压分级 */
  const toggleTier = (vclass: string) => {
    setVisibleLayers((prev) =>
      prev.includes(vclass) ? prev.filter((n) => n !== vclass) : [...prev, vclass],
    );
  };

  /**
   * 阶段30：输电线路总开关 —— 一键全开 / 全关所有电压档。
   * 规则：当前「有任一档开启」就全部关闭；一档都不开则全部开启（含「电压未知」）。
   */
  const toggleAllTiers = () => {
    setVisibleLayers((prev) => {
      const on = LINE_TIER_KEYS.some((k) => prev.includes(k));
      const rest = prev.filter((n) => !LINE_TIER_KEYS.includes(n));
      return on ? rest : [...rest, ...LINE_TIER_KEYS];
    });
  };

  /**
   * 阶段51：主题切换 → 底图重新着色。
   *
   * ‼️ 为什么单独一个 effect、不塞进建图那个巨型 effect：建图 effect 依赖为空、
   *    终生只跑一次；而主题是**可变的**。混在一起要么拿不到最新主题，
   *    要么让建图 effect 跟着主题重跑（= 重建地图，灾难）。
   *
   * ⚠️ 首次挂载时也要**补一次着色**：样式是在建图时按深色构建的，
   *    若用户在浅色主题下启动，不补这一下就会一直停在深色底图。
   * ⚠️ 订阅回调里用的是 `mapRef.current` 之外捕获的 map：本 effect 只在 mapReady
   *    翻转时建一次订阅，而地图实例在整个生命周期内不变（重建走的是 remount）。
   */
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const paint = (t: Theme) => applyBasemapTheme(map, t);
    paint(readTheme());
    return onThemeChange(paint);
  }, [mapReady]);

  /**
   * 阶段39：加载区域包清单，并探测**本机装了哪些包**。
   *
   * 清单随前端分发（`public/packs_manifest.json`，2.6 KB），但「本机有没有这个包」清单里
   * 没有 —— 那必须运行时探测。探测方式就是 `ensurePmtilesArchive` 的那次
   * **127 字节 Range 请求**（正好是 PMTiles 头部长度）：拿到 206 且魔数为 "PMTiles" 才算装了。
   * 好处是不需要给前端开任何目录列举权限（不引 fs 插件 = 不引新依赖）。
   *
   * ⚠️ 探测必须 quiet —— 用户没装区域包是**正常状态**，不该每次启动刷一串 warn。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(PACKS_MANIFEST_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const manifest = (await res.json()) as PacksManifest;
        if (cancelled) return;
        packsManifestRef.current = manifest;
        setPacksManifest(manifest);

        if (packsProbedRef.current) return;
        packsProbedRef.current = true;
        const results = await Promise.all(
          manifest.packs.map(async (p) => ({
            key: p.key,
            ok: (await resolvePackResource(p)) !== null,
          })),
        );
        if (cancelled) return;
        const ok = results.filter((r) => r.ok).map((r) => r.key);
        setPacksAvailable(ok);
        console.info(
          `[MapPage] 区域数据包：清单 ${manifest.packs.length} 个，本机已安装 ${ok.length} 个` +
            (ok.length ? `（${ok.join("、")}）` : "（未安装，本视图只能显示核心区）"),
        );
      } catch (err) {
        console.warn(
          `[MapPage] 未能加载区域包清单 ${PACKS_MANIFEST_URL}，按「无区域包」处理。` +
            "该文件由 `node scripts/gen_packs_manifest.mjs` 生成。",
          err,
        );
        if (!cancelled) {
          packsManifestRef.current = null;
          setPacksManifest(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 阶段44：数据包下载完成后，把地图上的该包**换掉**。
   *
   * 三件事缺一不可：
   *   1. **失效归档缓存** —— 否则 `archivePromises` 继续返回旧归档，
   *      症状是「提示下载成功但地图上依然没数据」，极难定位
   *   2. 拆掉旧的 source/layer —— 否则 source 泄漏，且新文件不会被读取
   *   3. 重新探测并纳入可加载集合
   * 之后由下面那个「按视口激活」的 effect 在合适时机重新挂上。
   */
  useEffect(() => {
    return onPackInstalled((file) => {
      const key = packKeyFromFile(file);
      const resource = `packs/${file}`;
      invalidateArchive(resource);

      const map = mapRef.current;
      // 阶段50-A：先按品类选对卸载函数。
      // ‼️ 少了 GEM 这一支会出两个都不会报错的问题：
      //    ① 用户在设置页**删除** GEM 数据包后，图层会一直留在图上
      //       （source 指向已删除的归档；瓦片 404 或命中旧缓存）
      //    ② 下面 `setPacksAvailable(filter)` 会把 key 从数组里摘掉，
      //       而「按视口卸载」那个循环**遍历的正是 packsAvailable** ——
      //       于是它再也看不到这个 key，永远不会补拆一次
      //    （区域包不受影响：它在这一行就已经被显式拆掉了，这就是本段存在的意义）
      //
      // 🔴 阶段50-B：**按 file 反查清单条目，而不是按 key**。
      //    `packKeyFromFile()` 是从 basename 推 key 的（`osm-huadong.pmtiles` → `huadong`），
      //    对 GEM 会推出 `"gem-plants"`，而清单里声明的 `key` 是 `"gem"` ——
      //    两者对不上 ⇒ `find` 落空 ⇒ 上面的 GEM 拆除分支**默默地永远不会执行**。
      //    这正是“不要依赖 basename 自动推导 key”的具体原因：
      //    **GEM 一律以清单的 entry.key 为准**，事件里的 basename 只用来定位是哪一个条目。
      const changed = packsManifestRef.current?.packs.find(
        (p) => p.file.split("/").pop() === file,
      );
      if (changed && isThematicOverlay(changed)) {
        gemWantedRef.current = false;
        if (map?.getSource(gemPmtilesSourceId())) {
          removeGemPlantLayers(map);
          console.info(`[MapPage] GEM 数据包 ${changed.key} 文件已变化，拆掉旧图层等重挂`);
        }
      } else if (map?.getSource(packSourceId(key))) {
        removePackLayers(map, key);
        console.info(`[MapPage] 区域包 ${key} 文件已变化，拆掉旧图层等重挂`);
      }

      // 先摘掉，避免拆掉 source 后 packsAvailable 还声称它可用
      setPacksAvailable((prev) => prev.filter((k) => k !== key));

      void ensurePmtilesArchive(resource, {
        label: `${key} 区域包`,
        missingHint: `${file} 尚未下载完成`,
        quiet: true,
      }).then((handle) => {
        if (!handle) return;
        setPacksAvailable((prev) => (prev.includes(key) ? prev : [...prev, key]));
        console.info(`[MapPage] 区域包 ${key} 已重新可用`);
      });
    });
  }, []);

  /**
   * 阶段39：按视口决定激活哪些区域包。
   *
   * 三条策略（与 `PACK_MIN_ZOOM` 等常量处的说明一致）：
   *   1. z < PACK_MIN_ZOOM 不加载 —— 低缩放覆盖半个中国，只显示 2 个区域会显得像坏了
   *   2. 视口中心落在核心区覆盖内不加载 —— 核心区优先，长三角只用随安装包分发的那份
   *   3. 其余情况按**重叠面积**排序取前 N 个
   *
   * ⚠️ 用 `moveend`/`zoomend` 而不是每帧的 `move`：后者在拖拽时每秒触发几十次，
   *    会不停地增删 source/layer（每次都是真实网络与样式重建）。
   */
  useEffect(() => {
    if (!mapReady || !packsManifest) return;
    const map = mapRef.current;
    if (!map) return;

    const recompute = () => {
      const setIfChanged = (next: readonly string[]) => {
        const cur = activePacksRef.current;
        if (cur.length === next.length && next.every((k, i) => cur[i] === k)) return;
        setActivePacks(next);
      };

      if (!packsAvailable.length) {
        setIfChanged([]);
        return;
      }
      if (map.getZoom() < PACK_MIN_ZOOM) {
        setIfChanged([]);
        return;
      }
      const el = map.getContainer();
      const w = el.clientWidth;
      const h = el.clientHeight;
      const size = w > 0 && h > 0 ? { w, h } : viewSizeRef.current;
      if (!size) return;

      const c = map.getCenter();
      if (bboxContainsPoint(packsManifest.core.bbox, c.lng, c.lat)) {
        setIfChanged([]);
        return;
      }

      const view = boundsFromCamera(c.lng, c.lat, map.getZoom(), size.w, size.h);
      const next = packsManifest.packs
        .filter((p) => packsAvailable.includes(p.key))
        // 阶段50-A：thematic overlay（GEM）**不参与**视口选举。
        // ‼️ 这一步就是它“不抢名额”的全部实现 —— 只要它不进这个数组，
        //    就不可能占掉 `PACK_MAX_ACTIVE` 里的一个位置。
        //    （GEM 的挂载由下面那个独立生命周期 effect 接管）
        .filter((p) => !isThematicOverlay(p))
        .map((p) => ({ key: p.key, area: bboxOverlapArea(view, p.bbox) }))
        .filter((x) => x.area > 0)
        .sort((a, b) => b.area - a.area)
        .slice(0, PACK_MAX_ACTIVE)
        .map((x) => x.key);
      setIfChanged(next);
    };

    map.on("moveend", recompute);
    map.on("zoomend", recompute);
    recompute();
    return () => {
      map.off("moveend", recompute);
      map.off("zoomend", recompute);
    };
  }, [mapReady, packsManifest, packsAvailable]);

  /**
   * 阶段39：把 `activePacks` 同步成地图上的 source/layer。
   *
   * ⚠️ 卸载必须真的 `removeSource`，不能只设 visibility=none：留着 source 就留着
   *    pmtiles 归档引用与已缓存的瓦片，来回切几次视野内存就堆满了。
   * ⚠️ 挂载是异步的（要等归档探测 Promise），等待期间视野可能又变了 ——
   *    所以 `then` 里要**复核一次** `activePacksRef.current` 是否还需要这个包。
   */
  useEffect(() => {
    activePacksRef.current = activePacks;
    const map = mapRef.current;
    if (!map || !mapReady || !packsManifest) return;

    const want = activePacks.filter((k) => packsAvailable.includes(k));

    for (const key of packsAvailable) {
      if (want.includes(key)) continue;
      // 阶段50-A：GEM 不归这里管 —— 它的挂载/卸载由下面那个
      // 「thematic overlay 生命周期」effect 独占。
      // ‼️ 这里必须显式跳过而不是“反正它不会出现在 want 里”：
      //    本循环遍历的是 `packsAvailable`（不是 want），而 GEM 永远不在 want 里，
      //    于是每一轮都会把刚挂上的 GEM 拆掉 —— 两个 effect 互相抢管。
      const entry = packsManifest.packs.find((p) => p.key === key);
      if (entry && isThematicOverlay(entry)) continue;
      if (map.getSource(packSourceId(key))) {
        removePackLayers(map, key);
        console.info(`[MapPage] 卸载区域包 ${key}`);
      }
    }

    for (const key of want) {
      if (map.getSource(packSourceId(key))) continue;
      const entry = packsManifest.packs.find((p) => p.key === key);
      if (!entry) continue;
      // 阶段50-A：GEM 不走这条路径（它由下面的 thematic overlay 生命周期 effect 独占）。
      // 这里显式跳过而不是“靠选举保证不会出现”—— 把归属写在边界上，
      // 将来若有人再把 GEM 塞进 activePacks 也只会无效，不会造成双向抢管。
      if (isThematicOverlay(entry)) continue;
      void resolvePackResource(entry).then((archive) => {
        const m = mapRef.current;
        if (!archive || !m) return;
        if (!activePacksRef.current.includes(key)) return; // 视野又变了，不挂了
        addPackLayers(m, key, archive);

        // ‼️ 阶段40：把地名标签提回最顶。
        //    `addLayer` 不带 `beforeId` 会把新图层**追加到样式最顶**，
        //    而建图时已用 `moveLayer(BASEMAP_LABEL_LAYER_ID)` 把标签提到顶了 ——
        //    所以每当挂上一个区域包，新图层就盖在标签之上，地名被线条/圆点遮住。
        //    这个现象只在**切换过区域**之后出现（首次建图时顺序是对的），
        //    极易被当成偶发渲染错位。每加完一个包补一次 moveLayer 最稳。
        if (m.getLayer(BASEMAP_LABEL_LAYER_ID)) {
          m.moveLayer(BASEMAP_LABEL_LAYER_ID);
        }

        // 新图层默认全可见，必须先按当前开关设一次，否则会出现
        // 「面板里关掉了电压未知，新加载的区域包却把它画出来」的不一致。
        const vis = visibleLayersRef.current;
        const on = (name: string) => vis.includes(name);
        const ids = packLayerIds(key);
        for (const tier of OSM_LINE_TIERS) {
          m.setLayoutProperty(packLayerId(tier.id, key), "visibility", on(tier.vclass) ? "visible" : "none");
        }
        m.setLayoutProperty(ids.substations, "visibility", on("变电站") ? "visible" : "none");
        m.setLayoutProperty(ids.plants, "visibility", on("电厂") ? "visible" : "none");
        // 阶段43：新加载的区域包也要按当前开关设一次，否则默认关闭的铁路/管道会自己冒出来
        m.setLayoutProperty(ids.railways, "visibility", on("铁路") ? "visible" : "none");
        m.setLayoutProperty(ids.pipelines, "visibility", on("油气管道") ? "visible" : "none");
        m.setLayoutProperty(ids.hit, "visibility", LINE_TIER_KEYS.some((k) => on(k)) ? "visible" : "none");

        // 光标反馈（与核心区那几个 hit 层一致）。
        // ‼️ 必须先存引用再注册：卸载时要用同一个 fn 去 `off`，匿名闭包摘不掉。
        const onEnter = () => {
          m.getCanvas().style.cursor = "pointer";
        };
        const onLeave = () => {
          m.getCanvas().style.cursor = "";
        };
        // 阶段41：点图层现在也能点开弹窗，一并给指针提示
        // （只给 hit 层的话，鼠标移到变电站/电网上不会有“可点”的反应感）。
        const cursorLayers = [ids.hit, ids.plants, ids.substations];
        packCursorHandlers.set(key, { layers: cursorLayers, enter: onEnter, leave: onLeave });
        for (const lid of cursorLayers) {
          m.on("mouseenter", lid, onEnter);
          m.on("mouseleave", lid, onLeave);
        }
        console.info(
          `[MapPage] 加载区域包 ${key}（${entry.label}${entry.features ? `，${entry.features} 个要素` : ""}）`,
        );
      });
    }
  }, [activePacks, mapReady, packsManifest, packsAvailable]);

  /**
   * 阶段50-A：**thematic / global overlay 的独立生命周期**（当前只有 GEM）。
   *
   * ‼️ 为什么不复用 `activePacks`（上面那个 effect）：两者语义根本不同 ——
   *    · `activePacks` = 「**按视口**选举、最多 2 个」的**区域包**管理器
   *      （核心 bbox 优先、`zoom < 6` 不加载、按重叠面积排序取前 2）
   *    · GEM = **全球单一图层**，由「GEM 发电设施」开关控制，
   *      「该不该显示」与视野**完全无关**
   *    混在一起会产生三个都不能接受的行为，详见 `isThematicOverlay` 的注释。
   *
   * ## 装载策略：**开着才装、关掉就卸**
   *    与 48-A 的懒加载同一个取舍（「不开的用户零开销」）——
   *    归档 5.4 MB / 19,182 张瓦片，没打开这个图层的人不该为它付内存。
   *    这也让 `addGemPlantLayers` 不再需要「加了但不显示」那个中间态。
   *
   * ## 它同时接管了三件事
   *    ① 开关打开且数据包已装 → 挂载
   *    ② 开关关闭 / 数据包被删 → 卸载
   *    ③ 数据包文件变化（重下/更新） → 由 `onPackInstalled` 里的
   *       `removeGemPlantLayers` 先拆，然后本 effect 因为 `packsAvailable`
   *       变化而重跑、重新挂上新归档
   *
   * ⚠️ 挂载是异步的（要等 127 字节 Range 探测），等待期间开关可能又关了 ——
   *    所以 `then` 里必须用 ref **复核一次**（与区域包挂载同一个坑）。
   *
   * ⚠️ 有意**不**给 GEM 加 `PACK_MIN_ZOOM` 那类限级：归档自带 `minzoom: 0`，
   *    而「缩小反而没数据」对一个全球图层是反直觉的（这正是审查里 H-3 那条）。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !packsManifest) return;

    const entry = packsManifest.packs.find(isThematicOverlay);
    if (!entry) {
      // 清单里根本没有 thematic overlay（或清单被换掉）→ 确保不残留
      gemWantedRef.current = false;
      if (map.getSource(gemPmtilesSourceId())) {
        removeGemPlantLayers(map);
        console.info("[MapPage] 卸载 GEM 数据包（清单中已无此包）");
      }
      return;
    }

    const wanted =
      packsAvailable.includes(entry.key) &&
      visibleLayers.includes(GEM_PLANT_LAYER_NAME);
    gemWantedRef.current = wanted;

    if (!wanted) {
      if (map.getSource(gemPmtilesSourceId())) {
        removeGemPlantLayers(map);
        console.info("[MapPage] 卸载 GEM 数据包（开关关闭或数据包不可用）");
      }
      return;
    }

    if (map.getSource(gemPmtilesSourceId())) return; // 已挂上，无需重复

    void resolvePackResource(entry).then((archive) => {
      const m = mapRef.current;
      if (!archive || !m) return;
      if (!gemWantedRef.current) return; // 这期间开关被关了，不挂了
      addGemPlantLayers(m, entry.key, archive, popupRef.current);
      // 与区域包同理：`addLayer` 会把新图层**追加到样式最顶**，
      // 得把地名标签提回来，否则 GEM 的点会盖住地名。
      if (m.getLayer(BASEMAP_LABEL_LAYER_ID)) m.moveLayer(BASEMAP_LABEL_LAYER_ID);
    });
  }, [mapReady, packsManifest, packsAvailable, visibleLayers]);

  /**
   * 阶段21：把「图层控制」的开关真正接到 MapLibre 上。
   *
   * ⚠️ 两个坑：
   *  1) 建图是异步的（Database.load + addSource/addLayer）。若在建成之前
   *     就执行，getLayer 全返回 undefined，开关会“静默失效”。
   *     所以这里先更新 ref 镜像，建图完成时 refreshClusterLabels 会读到最新值。
   *  2) 高亮图层是首次高亮时才创建的，此刻可能还不存在 —— getLayer 判空跳过即可。
   */
  useEffect(() => {
    visibleLayersRef.current = visibleLayers;

    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    const apply = (ids: readonly string[], on: boolean) => {
      for (const id of ids) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
        }
      }
    };
    const on = (name: string) => visibleLayers.includes(name);

    // 「电厂」统一控制 4 个图层：高亮层是查询结果的叠加，
    // 若单独留着，会出现「电厂关掉了但还飘着一圈金环」的怪状。
    apply([CLUSTER_LAYER_ID, PLANT_LAYER_ID, HIGHLIGHT_LAYER_ID, OSM_PLANT_LAYER_ID], on("电厂"));
    apply([SUBSTATIONS_LAYER_ID, OSM_SUBSTATION_LAYER_ID], on("变电站"));

    // 阶段48-A：GEM 层（默认关闭，不在 visibleLayers 初始值里）。
    // 阶段50-A：它的**挂载/卸载**由「thematic overlay 生命周期」effect 独占管理
    //    （关掉开关会整个拆掉）；这里保留它只是「兵底同步」——
    //    万一卸载与开关在同一帧里竞态，也不会留下一个可见的残留。
    // ‼️ 阶段50-C.2-A：只剩这一个图层了（旧 GeoJSON 通道的两个图层已删除），
    //    原先“只开环不开外环会失去形状区分”的约束随之消失。
    //    旧开关名已在 `visibleLayers` 的**规范化层**里转掉了（见 `normalizeLayerKeys`），
    //    这里只认当前 key，无需再判旧名。
    apply([gemPlantsLayerId()], on(GEM_PLANT_LAYER_NAME));

    // 阶段43：铁路 / 油气管道。两个独立开关，**默认关闭**（不在 visibleLayers 初始值里）。
    // 它们没有命中热区/弹窗，所以不需要像线路那样联动 hit 层。
    apply([OSM_RAILWAY_LAYER_ID], on("铁路"));
    apply([OSM_PIPELINE_LAYER_ID], on("油气管道"));

    // ⚠️ 输电线路的热区层必须跟着视觉线一起开关，否则会出现
    //    「线看不见了、却还能点到它的弹窗」的幽灵交互。
    // ‼️ 阶段30：输电线路细化为「一个电压档一个开关」，键直接用 vclass。
    //    `osm-line-unknown` 不再是特例 —— 它只是普通的第 5 档（默认关闭）。
    for (const tier of OSM_LINE_TIERS) {
      apply([tier.id], on(tier.vclass));
    }
    // 旧的 DB 演示线层（阶段28 已清空）与热区层跟随「任一档开启」
    apply([LINES_LAYER_ID, LINES_HIT_LAYER_ID], LINE_TIER_KEYS.some((k) => on(k)));
    // 阶段34：真实切片线路的点击热区也必须跟着电压档开关走 ——
    // 全部关掉时若热区还在，点空白处会弹出「看不见的线路」信息。
    apply([OSM_LINES_HIT_LAYER_ID], LINE_TIER_KEYS.some((k) => on(k)));

    // 阶段39：区域包的图层跟随**同一套**开关。
    // 这里按当前 activePacks 重新算一遍 —— 刚挂上的包也会被设成正确状态，
    // 不用等用户下一次拨开关（否则新加载的包会短暂地把「电压未知」也画出来）。
    for (const key of activePacks) {
      for (const tier of OSM_LINE_TIERS) {
        apply([packLayerId(tier.id, key)], on(tier.vclass));
      }
      apply([packLayerId(OSM_SUBSTATION_LAYER_ID, key)], on("变电站"));
      apply([packLayerId(OSM_PLANT_LAYER_ID, key)], on("电厂"));
      apply([packLayerId(OSM_RAILWAY_LAYER_ID, key)], on("铁路"));
      apply([packLayerId(OSM_PIPELINE_LAYER_ID, key)], on("油气管道"));
      apply([packLayerId(OSM_LINES_HIT_LAYER_ID, key)], LINE_TIER_KEYS.some((k) => on(k)));
    }

    // 聚合数字是 HTML Marker，上面的 setLayoutProperty 管不到它
    if (visibleLayers.includes("电厂")) {
      labelApiRef.current?.refresh();
    } else {
      labelApiRef.current?.clear();
    }

    // 阶段31：图层开关变化也要立刻反映到 AI 上下文里 ——
    // 「用户在看哪些电压等级」正是这个上下文的价值所在
    setViewportInfo(publishViewport());
  }, [visibleLayers, activePacks]);

  /**
   * 阶段30：当前视野数据统计。
   *
   * 触发：`moveend`（平移与缩放结束都会触发）+ 200ms 防抖。
   * 口径（比数字本身更重要，面板上同步标注）：
   *   · 电厂 —— SQL bbox 精确计数（聚合图层不能按要素求和，会把聚合内的电厂重复计数）
   *   · 线路段 / 变电站 —— `queryRenderedFeatures`：只数**真的渲染在视野内**的要素，
   *     且天然跟随上面的复选框；`querySourceFeatures` 会把视野外瓦片缓冲区里的要素
   *     也算进来，数值明显偏大且与开关脱钩（因此不用它）。
   *   · 跨瓦片重复：z≥8 的瓦片带 `osm_id`，按它去重 → 精确；
   *     z<8 的低级别瓦片为压体积没保留 `osm_id`，无法去重 → 显示为 `≈`。
   *
   * ⚠️ 性能护栏：耗时写进控制台；超过 50ms 额外告警（按约定此时应停下来汇报，不硬撑）。
   */
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    /**
     * 阶段40：上一次统计的总耗时，用于自适应节流。
     * ‼️ 实测（采样时 pmtiles 在飞请求 = 0，与瓦片加载无关）：
     *    屏上 5,085 段线 → 26.5ms；**21,513 段线 → 77.3ms**；22,972 段线 → 128.9ms。
     *    且关掉「220kV 以下」使要素数降 35%、耗时只降 16% ——
     *    反推成本 ≈ **固定开销 34ms + 每要素 1.7µs**，固定部分是大头。
     *    因此单次阻塞无法靠减要素消除，只能降低**发生频率**：
     *    上一次跑慢了就把下一次的延迟拉长，等用户真正停下来再算。
     */
    let lastCostMs = 0;

    /** 同一要素可能被相邻瓦片各带一份（缓冲区重叠），z≥8 时用 osm_id 去重 */
    const countUnique = (feats: MapGeoJSONFeature[], exact: boolean): number => {
      if (!exact) return feats.length;
      const seen = new Set<unknown>();
      for (const f of feats) {
        const id = f.properties?.osm_id;
        if (id != null) seen.add(id);
      }
      return seen.size;
    };

    const run = () => {
      // 组件已卸载（或地图已重建）时不要再碰地图
      if (cancelled) return;
      const t0 = performance.now();
      const zoom = map.getZoom();
      const exact = zoom >= 8;
      const on = (name: string) => visibleLayersRef.current.includes(name);

      // 只查**当前开启**的电压档：关掉的档不应出现在统计里。
      // 阶段39：区域包的图层也要算进去 —— 否则在四川看了一屏线、面板却写「线路段 0 段」。
      // ⚠️ 必须过滤掉不存在的图层：`queryRenderedFeatures` 传一个不存在的 layer id 会报错。
      const packKeys = activePacksRef.current;
      const lineLayers = [
        ...OSM_LINE_TIERS.filter((t) => on(t.vclass)).map((t) => t.id),
        ...packKeys.flatMap((k) =>
          OSM_LINE_TIERS.filter((t) => on(t.vclass)).map((t) => packLayerId(t.id, k)),
        ),
      ].filter((lid) => !!map.getLayer(lid));
      const lines = lineLayers.length
        ? countUnique(map.queryRenderedFeatures({ layers: lineLayers }), exact)
        : 0;
      const subLayers = [
        OSM_SUBSTATION_LAYER_ID,
        ...packKeys.map((k) => packLayerId(OSM_SUBSTATION_LAYER_ID, k)),
      ].filter((lid) => !!map.getLayer(lid));
      const substations = on("变电站") && subLayers.length
        ? countUnique(map.queryRenderedFeatures({ layers: subLayers }), exact)
        : 0;
      // 拆两段计时：渲染查询是同步的，剩下全部是 SQL 往返（电厂精确计数走数据库）
      const tRender = performance.now();

      const b = map.getBounds();
      const plantStatsPromise = on("电厂")
        ? loadPlantStatsInBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())
        : Promise.resolve<PlantStatsInBox>({
            total: 0,
            totalCapacityMw: 0,
            missingCapacity: 0,
            byFuel: [],
          });

      void plantStatsPromise
        .then((stats) => {
          if (cancelled) return;
          const ms = performance.now() - t0;
          lastCostMs = ms;
          const msRender = tRender - t0;
          console.debug(
            `[MapPage] 视野统计 ${ms.toFixed(1)}ms（渲染查询 ${msRender.toFixed(1)}ms + 数据库 ${(ms - msRender).toFixed(1)}ms，` +
              `z=${zoom.toFixed(2)}，${exact ? "按 osm_id 去重" : "低级别按源统计"}）：` +
              `电厂 ${stats.total}（${stats.byFuel.length} 类）/ 线路段 ${lines} / 变电站 ${substations}`,
          );
          if (ms > 50) {
            console.warn(`[MapPage] ⚠️ 视野统计超过 50ms 护栏：${ms.toFixed(1)}ms`);
          }
          // 与统计数字放在同一次状态更新里，避免每帧多渲一次
          setViewportInfo(publishViewport());
          setViewStats({
            plants: stats.total,
            lines,
            substations,
            exact,
            fuels: stats.byFuel,
            totalCapacityMw: stats.totalCapacityMw,
            missingCapacity: stats.missingCapacity,
          });
        })
        .catch((err: unknown) => {
          console.error("[MapPage] 视野统计失败", err);
        });
    };

    const schedule = () => {
      // 阶段31：先同步发布视野（提问瞬间要读到最新值，不能等防抖），
      // 并顺手把「上一个视野限定查询」判为过期并清空
      dropStaleViewportQuery();
      if (timer) clearTimeout(timer);
      // 阶段40：自适应节流。基准 350ms；若上一次跑得慢（>=80ms），拉到 900ms。
      // 代价是视野停下后数字慢一拍才更新；换来的是热点区域不再“每动一下卡一下”。
      const delay = lastCostMs >= STATS_SLOW_MS ? STATS_SLOW_DEBOUNCE_MS : STATS_DEBOUNCE_MS;
      timer = setTimeout(run, delay);
    };

    map.on("moveend", schedule);
    map.on("zoomend", schedule);
    // 阶段32：容器尺寸变化（窗口缩放、切页回来）时重算并刷新视野上下文 ——
    // 否则缓存尺寸与真实尺寸脱节，bbox 会偏
    const onResize = () => setViewportInfo(publishViewport());
    map.on("resize", onResize);
    // ‼️ 冷启动补丁（阶段31 收尾）：地图「就绪」只说明图层与数据已挂上，
    //    并**不**代表瓦片已经画出来。挂载时那次统计往往跑在瓦片渲染之前，
    //    queryRenderedFeatures 会返回 0 → 面板停在「线路段 0 段 · 变电站 0 座」
    //    且**不会自纠**（除非用户碰一下地图）。所以等地图首次真正空闲再补跑一次。
    //    `once` 而非 `on`：只需覆盖冷启动那一次，之后靠 moveend 就够了。
    map.once("idle", schedule);
    // 建图完成后立即算一次，避免面板长时间停在「—」
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      map.off("moveend", schedule);
      map.off("zoomend", schedule);
      map.off("resize", onResize);
      map.off("idle", schedule);
    };
  }, [mapReady, visibleLayers, activePacks]);

  return (
    <div
      className={`${styles.viewport} ${
        benchOpen ? styles.withBench : styles.railOnly
      }`}
    >
      {/* 地图画布容器：铺满视窗，位于悬浮 UI 之下 */}
      <div ref={mapContainerRef} className={styles.mapContainer} />

      {/* 阶段31：地图页浮动查询框。
          GIS 用户是**看着地图提问**的，放在地图页才符合直觉；
          完整的 AI 配置与 CSV 导出仍然在设置页。 */}
      <MapQueryBox
        viewport={viewportInfo}
        viewportRef={viewportRef}
        staleSeq={queryResetSeq}
        onViewOnMap={onViewOnMap}
        onClearMap={onClearMap}
        onFocusPlant={onFocusPlant}
        focusedPlant={focusedPlant}
        history={history}
        onQueryDone={onQueryDone}
        open={benchOpen}
        onToggleOpen={() => setBenchOpen((v) => !v)}
      />

      {/* 左上角：图层控制 */}
      <section className={styles.layerPanel} aria-label="数据看板与图层控制">
        {/* 阶段48：当前视野统计 —— 用户要求放**面板最上方**。
            原先是左下角独立的 `.statsPanel`，现合并到这里：
            ① 同一类信息不再占两处；② 左下角让出来后本面板可用高度多出约 84px。 */}
        <section className={styles.viewPanel} aria-label="当前视野统计" aria-live="polite">
          <div className={styles.viewHeader}>
            <button
              type="button"
              className={styles.viewHeaderToggle}
              aria-expanded={viewOpen}
              aria-controls="viewport-stats-body"
              onClick={() => setViewOpen((v) => !v)}
            >
              <span className={styles.viewTitle}>当前视野</span>
              <span className={styles.viewHeadRight}>
                <span className={styles.viewTotal}>
                  {fuelView ? `${fuelView.count.toLocaleString()} 座` : "—"}
                </span>
                <span className={styles.chevron} aria-hidden="true">
                  {viewOpen ? "▼" : "▶"}
                </span>
              </span>
            </button>
            <button
              type="button"
              className={styles.viewExportBtn}
              onClick={() => void handleExportViewport()}
              disabled={exporting || !viewStats}
              title={viewStats ? "导出当前视野内的电厂为 CSV" : "视野统计尚未就绪"}
            >
              {exporting ? "导出中…" : "导出"}
            </button>
          </div>

          <div id="viewport-stats-body" className={styles.viewBody} hidden={!viewOpen}>
            {!viewStats || !fuelView ? (
              <p className={styles.viewNote}>正在统计…</p>
            ) : fuelView.count === 0 ? (
              <p className={styles.viewNote}>
                {viewStats.plants > 0
                  ? "当前视野内的电厂都被「统计筛选」排除了"
                  : "当前视野内没有电厂"}
              </p>
            ) : (
              <>
                <p className={styles.viewCap}>
                  装机合计 <b>{formatGw(fuelView.cap)}</b>
                </p>
                <ul className={styles.fuelStats}>
                  {fuelView.top.map((f) => (
                    <li key={f.fuel ?? "none"} className={styles.fuelStatRow}>
                      <span
                        className={styles.fuelStatSwatch}
                        style={{ backgroundColor: fuelColor(f.fuel) }}
                        aria-hidden="true"
                      />
                      <span className={styles.fuelStatName}>{fuelLabel(f.fuel)}</span>
                      <span className={styles.fuelStatCount}>
                        {f.count.toLocaleString()}
                      </span>
                      <span className={styles.fuelStatCap}>
                        {f.capacityMw == null ? "--" : formatGw(f.capacityMw)}
                      </span>
                    </li>
                  ))}
                  {fuelView.hasRest && (
                    <li className={styles.fuelStatRow}>
                      <span
                        className={styles.fuelStatSwatch}
                        style={{ backgroundColor: "#6b6b6b" }}
                        aria-hidden="true"
                      />
                      <span className={styles.fuelStatName}>
                        其他 {fuelView.restKinds} 类
                      </span>
                      <span className={styles.fuelStatCount}>
                        {fuelView.restCount.toLocaleString()}
                      </span>
                      <span className={styles.fuelStatCap}>
                        {formatGw(fuelView.restCap)}
                      </span>
                    </li>
                  )}
                </ul>

                <p className={styles.viewNote}>
                  线路段 {viewStats.exact ? "" : "≈"}
                  {viewStats.lines.toLocaleString()} · 变电站{" "}
                  {viewStats.exact ? "" : "≈"}
                  {viewStats.substations.toLocaleString()}
                  {viewStats.exact ? "（z≥8 已去重）" : "（z<8 按源统计）"}
                </p>

                {/* 口径必须写清，否则用户看到「分项和 ≠ 合计」会以为是算错了 */}
                {(fuelView.hiddenCount > 0 || fuelView.missingCapacity > 0) && (
                  <p className={styles.viewWarn}>
                    {fuelView.hiddenCount > 0 &&
                      `已被统计筛选排除 ${fuelView.hiddenCount.toLocaleString()} 座`}
                    {fuelView.hiddenCount > 0 && fuelView.missingCapacity > 0 && "；"}
                    {fuelView.missingCapacity > 0 &&
                      `容量缺失 ${fuelView.missingCapacity.toLocaleString()} 座未计入合计`}
                  </p>
                )}
              </>
            )}

            {/* 阶段52：导出结果提示（6 秒后自动消失） */}
            {exportHint && (
              <p className={styles.viewNote}>{exportHint}</p>
            )}
          </div>
        </section>

        {/* 阶段46：数据看板（静态原型）—— **全局**口径，与上面的「当前视野」区分开。
            默认折叠（展开后内容较高，会拉长面板）。 */}
        <StatsDashboard />

        <button
          type="button"
          className={styles.panelToggle}
          aria-expanded={panelOpen}
          aria-controls="map-layer-groups"
          onClick={() => setPanelOpen((open) => !open)}
        >
          <span>图层控制</span>
          <span className={styles.chevron} aria-hidden="true">
            {panelOpen ? "▼" : "▶"}
          </span>
        </button>

        {/* 阶段45：分组制的图层控制。
            折叠仅隐藏内容，**不改变图层可见性**（收起「基础设施」不会让铁路消失）。 */}
        <div id="map-layer-groups" className={styles.layerGroups} hidden={!panelOpen}>
          {LAYER_GROUPS.map((group) => {
            const open = openGroups.includes(group.id);
            const bodyId = `layer-group-${group.id}`;
            return (
              <section key={group.id} className={styles.layerGroup}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => toggleGroup(group.id)}
                >
                  <span>{group.label}</span>
                  <span className={styles.chevron} aria-hidden="true">
                    {open ? "▼" : "▶"}
                  </span>
                </button>

                <div id={bodyId} className={styles.groupBody} hidden={!open}>
                  {/* ---------- 电力设施：三个总开关 + 电压分级 ---------- */}
                  {group.id === "power" && (
                    <>
                      <ul className={styles.layerList}>
                        {[...LAYERS, GEM_PLANT_LAYER_NAME].map((name) => {
                          // 「输电线路」是总开关：状态 = 任一电压档开启；点击 = 全开 / 全关
                          const isVisible =
                            name === "输电线路" ? anyTierOn : visibleLayers.includes(name);

                          return (
                            <li key={name}>
                              <button
                                type="button"
                                className={styles.layerBtn}
                                aria-pressed={isVisible}
                                onClick={() =>
                                  name === "输电线路" ? toggleAllTiers() : toggleLayer(name)
                                }
                              >
                                <span
                                  className={styles.layerSwatch}
                                  style={{ background: LAYER_SWATCH[name] }}
                                  aria-hidden="true"
                                />
                                {name}
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {/* 阶段30：输电线路按电压分级。
                          用原生 `<input type="checkbox">`：语义与无障碍最好，也不必为「选中态」自造样式。
                          色块取自与地图**同一份** `OSM_LINE_TIERS[].color`，所以开关本身就是图例，
                          永远不会和地图上的颜色脱节。
                          阶段54：本组改为**可折叠**（第三层，默认折叠），
                          把 1280×800 下这块 116px 的内容从默认路径上摘掉（溢出 65px → 0）。
                          实测数据与代价见 `tierMenuOpen` 的注释。 */}
                      <div className={styles.tierGroup}>
                        <button
                          type="button"
                          className={styles.subHeader}
                          aria-expanded={tierMenuOpen}
                          aria-controls="tier-sub-menu"
                          onClick={() => setTierMenuOpen((v) => !v)}
                        >
                          <span>输电线路（按电压分级）</span>
                          <span className={styles.chevron} aria-hidden="true">
                            {tierMenuOpen ? "▼" : "▶"}
                          </span>
                        </button>

                        <ul
                          id="tier-sub-menu"
                          className={`${styles.tierList} ${styles.subList}`}
                          hidden={!tierMenuOpen}
                        >
                          {OSM_LINE_TIERS.map((tier) => (
                            <li key={tier.vclass}>
                              <label className={styles.tierItem}>
                                <input
                                  type="checkbox"
                                  className={styles.tierCheck}
                                  checked={visibleLayers.includes(tier.vclass)}
                                  onChange={() => toggleTier(tier.vclass)}
                                />
                                <span
                                  className={styles.layerSwatch}
                                  style={{ background: tier.color }}
                                  aria-hidden="true"
                                />
                                {TIER_LABEL[tier.vclass] ?? tier.vclass}
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* 阶段48：第三层折叠 —— 「统计筛选」
                          （阶段46 时叫「按能源细分」并标为原型，现已生效为真实过滤）。
                          同一套样式构成第三层，靠**缩进**而不是新分隔线区分层级。
                          ⚠️ 勾选**只过滤左侧看板的统计数字**，不改地图渲染 ——
                             原因见 statFuels 的注释（cluster 数据源过滤不了）。 */}
                      <div className={styles.tierGroup}>
                        <button
                          type="button"
                          className={styles.subHeader}
                          aria-expanded={fuelMenuOpen}
                          aria-controls="fuel-sub-menu"
                          onClick={() => setFuelMenuOpen((v) => !v)}
                        >
                          <span>统计筛选</span>
                          <span className={styles.chevron} aria-hidden="true">
                            {fuelMenuOpen ? "▼" : "▶"}
                          </span>
                        </button>

                        <ul
                          id="fuel-sub-menu"
                          className={`${styles.tierList} ${styles.subList}`}
                          hidden={!fuelMenuOpen}
                        >
                          {FUEL_LEGEND.map(([fuel, label]) => (
                            <li key={fuel}>
                              <label className={styles.tierItem}>
                                <input
                                  type="checkbox"
                                  className={styles.tierCheck}
                                  checked={statFuels.includes(fuel)}
                                  onChange={() => toggleStatFuel(fuel)}
                                />
                                <span
                                  className={styles.layerSwatch}
                                  style={{ background: fuelColor(fuel) }}
                                  aria-hidden="true"
                                />
                                {label}
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}

                  {/* ---------- 基础设施：默认关闭的背景参照 ---------- */}
                  {group.id === "infra" && (
                    <div className={styles.tierGroup}>
                      <p className={styles.legendTitle}>默认关闭（背景参照）</p>
                      <ul className={styles.tierList}>
                        {INFRA_LAYERS.map((name) => (
                          <li key={name}>
                            <label className={styles.tierItem}>
                              <input
                                type="checkbox"
                                className={styles.tierCheck}
                                checked={visibleLayers.includes(name)}
                                onChange={() => toggleLayer(name)}
                              />
                              <span
                                className={styles.layerSwatch}
                                style={{ background: INFRA_SWATCH[name] }}
                                aria-hidden="true"
                              />
                              {name}
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ---------- 环境与底图：预留占位 ---------- */}
                  {group.placeholder && (
                    <p className={styles.groupPlaceholder}>{group.placeholder}</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {/* 图例：纯 DOM + CSS，不引入任何图表 / 配色库。

            ‼️ 阶段47：**与「图层控制」开关解耦**，阶段47-1 又给了它**自己的**折叠开关。
               用户拍板：「保留独立控制的设计，但向导首次启动时要先看到干净的地图，
               等他主动展开图例再看」—— 所以默认折叠，但**不删任何条目**。

            实测（1280×800，面板可视高度 695px）：
              图例展开 + 图层控制展开 = 912px ⇒ 溢出 219px
              图例折叠 + 图层控制折叠 = 373px ⇒ 溢出 0（默认）

            ⚠️ 阶段47：这块图例被**两次**去重，目的都是消掉左面板的长滚动条
               （实测：面板可视高度硬上限只有 609px，而去重前内容高达 1722px）。

               1. 「燃料类型」（15 类、两列网格，约 300px）→ 删除。
                  新的「数据看板」已完整呈现同样 15 类的色块 + 中文名，且信息更多
                  （还带座数与容量）。同一屏维护两份一模一样的图例没有意义。
               2. 「变电站 / 输电线路」（约 64px）→ 删除。
                  这两项与上方图层开关左侧的色块**逐字节相同**
                  （LAYER_SWATCH.变电站 === SUBSTATION_COLOR === "#3fd0c9"、
                    LAYER_SWATCH.输电线路 === LINE_COLOR === "#8b96a8"），
                  而 .layerList 的注释早就写明「让开关本身充当图例」——
                  再列一遍就是纯重复。

            只保留**不重复**的部分：查询高亮（图层开关里没有它）与下方的视觉约定说明。
            ⚠️ 折叠只隐藏内容，**不删除任何条目**，展开后原样回来。 */}
        <section className={styles.legend} aria-label="图例">
          <button
            type="button"
            className={styles.panelToggle}
            aria-expanded={legendOpen}
            aria-controls="map-legend-body"
            onClick={() => setLegendOpen((open) => !open)}
          >
            <span>图例</span>
            <span className={styles.chevron} aria-hidden="true">
              {legendOpen ? "▼" : "▶"}
            </span>
          </button>

          <div id="map-legend-body" className={styles.legendBody} hidden={!legendOpen}>
            <ul className={styles.legendList}>
              <li className={styles.legendItem}>
                <span
                  className={styles.legendSwatch}
                  style={{ backgroundColor: "#ffd24a" }}
                  aria-hidden="true"
                />
                查询高亮
              </li>
            </ul>
            <p className={styles.legendFoot}>
              变电站半径与线路宽度均随电压等级递增；变电站与线路为演示数据。
            </p>
          </div>
        </section>
      </section>

      {/* 右上角：缩放控件（已接真实地图） */}
      <div className={styles.zoomControl} role="group" aria-label="缩放控件">
        <button
          type="button"
          className={styles.zoomBtn}
          aria-label="放大"
          onClick={() => mapRef.current?.zoomIn()}
        >
          +
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          aria-label="缩小"
          onClick={() => mapRef.current?.zoomOut()}
        >
          −
        </button>
      </div>

      {/* 左下角比例尺已改由 MapLibre 的 ScaleControl 渲染（见上面的 addControl），
          它挂在 .maplibregl-ctrl-bottom-left 里，不再需要自定义 DOM。 */}

      {/* 地图指令的执行结果提示（如「已高亮 N 个匹配的电厂」） */}
      {mapNotice && <p className={styles.mapNotice}>{mapNotice}</p>}
    </div>
  );
}

export default MapPage;
