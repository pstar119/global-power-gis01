import { useEffect, useRef, useState, type RefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
// 阶段26：读取随安装包分发的离线底图。
// convertFileSrc 把本地绝对路径转成 `asset://localhost/...`（实现了真正的 HTTP Range）；
// resolveResource 把相对资源路径解析成绝对路径（随安装包分发的 $RESOURCE 目录）。
import { convertFileSrc } from "@tauri-apps/api/core";
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
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { FUEL_LEGEND, fuelColor } from "../lib/fuel";
// 阶段27：离线中文字形的 `font-faces` 清单（由 scripts/fetch_glyphs.mjs 生成）
import { BASEMAP_FONT_FACES, BASEMAP_FONT_FAMILY } from "../lib/basemapFonts.generated";
import {
  MAX_HIGHLIGHT_POINTS,
  buildBoundsSql,
  buildHighlightSql,
  viewportChanged,
  type MapCommand,
  type ParsedQuery,
  type QueryContext,
  type ViewportBbox,
} from "../lib/nlq";
import MapQueryBox from "../components/MapQueryBox";
import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

/**
 * 图层开关左侧色块的颜色 —— 让开关本身充当图例，不必再单独解释一遍。
 * 电厂用渐变表示「按燃料多色」，而不是给一个会误导人的单色。
 */
const LAYER_SWATCH: Record<string, string> = {
  电厂: "conic-gradient(#9aa0a6, #f5a524, #4daafc, #5ee39b, #b07cf5, #9aa0a6)",
  变电站: "#3fd0c9",
  输电线路: "#8b96a8",
};

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
const OSM_SUBSTATION_LAYER_ID = "osm-substations";
const OSM_PLANT_LAYER_ID = "osm-plants";

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
 * 默认开启的分级：除「电压未知」外全开。
 * 实测长三角有 7,917 条线路没有 `voltage` 标签（约 35%），把它们归进任何一档都是误导，
 * 所以单独一档且**默认关闭**。
 */
const DEFAULT_ON_TIERS: readonly string[] = OSM_LINE_TIERS
  .filter((t) => t.vclass !== "unknown")
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

/** Popup 里展示的字段（来自 GeoJSON properties） */
type PlantProperties = {
  name: string;
  country: string | null;
  capacity: number | null;
  fuel: string | null;
  color: string;
};

/** 变电站要素的属性。voltage 参与半径分级，缺失时为 0（落在 step 第一档）。 */
type SubstationProperties = {
  name: string;
  country: string | null;
  voltage: number;
};

/** 输电线路要素的属性 */
type LineProperties = {
  name: string;
  voltage: number;
};

/**
 * 用原生 DOM 构建 Popup 内容。
 *
 * ⚠️ 刻意**不用 `setHTML()`**：电厂名称来自外部数据集，拼 HTML 字符串会有
 *    注入风险。这里一律走 `textContent`（由浏览器自动转义）。
 * ⚠️ 样式用 CSS Modules 的类名（它在运行时就是个字符串），因此 Popup 的
 *    外观与其它悬浮面板完全一致，不需要为它另写一套全局 CSS。
 */
function buildPlantPopup(props: PlantProperties): HTMLElement {
  return buildPopupFrame(props.name, "未命名电厂", [
    { label: "国家/地区", value: props.country || "未知" },
    {
      label: "燃料类型",
      value: props.fuel || "未知",
      // 燃料那一行在文字前加一个与地图同色的色块，和图例形成呼应
      swatch: props.fuel ? props.color : undefined,
    },
    {
      label: "装机容量",
      value: props.capacity == null ? "未提供" : `${props.capacity} MW`,
    },
  ]);
}

/** 变电站 Popup：名称 / 国家 / 电压等级 */
function buildSubstationPopup(props: SubstationProperties): HTMLElement {
  return buildPopupFrame(props.name, "未命名变电站", [
    { label: "国家/地区", value: props.country || "未知" },
    { label: "电压等级", value: formatVoltage(props.voltage), swatch: SUBSTATION_COLOR },
  ]);
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
  return buildPopupFrame(props.name, "未命名线路", [
    { label: "电压等级", value: formatVoltage(props.voltage), swatch: LINE_COLOR },
    { label: "起点", value: start ? formatLngLat(start) : "未提供" },
    { label: "终点", value: end ? formatLngLat(end) : "未提供" },
  ]);
}
/** Popup 的一行：标签 + 值，可选的色块用于与图例呼应 */
type PopupRow = { label: string; value: string; swatch?: string };

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
    dd.textContent = row.value;

    if (row.swatch) {
      const swatch = document.createElement("span");
      swatch.className = styles.popupSwatch;
      swatch.style.backgroundColor = row.swatch;
      dd.prepend(swatch);
    }

    list.append(dt, dd);
  }

  root.appendChild(list);
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
 * 从 SQLite 读取电厂，转成 GeoJSON 供地图渲染。
 *
 * 数据由外部导入脚本写入（见 `scripts/import_wri_plants.py`），
 * 应用本身不产生任何数据，只负责读取与展示。
 *
 * 先 Database.load() 确保插件的连接池已建立，再 db.select(...)。
 */

/**
 * 阶段30：统计**当前视野**内的电厂数量（精确）。
 *
 * 为什么不和线路/变电站一样用 queryRenderedFeatures 求和：
 * 电厂是**聚合**（cluster）图层，图层查询拿到的是聚合体（带 point_count），
 * 求和会把聚合内的电厂重复计数；同一个电厂还可能落在多张瓦片的缓冲区里。
 * 数据库一句 COUNT 就是精确值，而且它是只读 SELECT，不触碰「前端只读」红线。
 *
 * ⚠️ 边界值直接插进 SQL：取值来自 `map.getBounds()` 并经 `Number()` 强转，
 *    是纯数字而非用户输入，没有注入面。比依赖占位符语法（`?` / `$1`）在
 *    tauri-plugin-sql 上的具体行为更稳妥。
 */
async function loadPlantCountInBox(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<number> {
  const db = await Database.load(DB_URL);
  const w = Number(west);
  const s = Number(south);
  const e = Number(east);
  const n = Number(north);
  const rows = (await db.select(
    "SELECT COUNT(*) AS c FROM power_plants " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL " +
      `AND lon BETWEEN ${w} AND ${e} AND lat BETWEEN ${s} AND ${n}`,
  )) as Array<{ c: number }>;
  return rows[0]?.c ?? 0;
}

async function loadPlantsGeoJson(): Promise<FeatureCollection> {
  const db = await Database.load(DB_URL);

  // 只取有坐标的记录：经纬度缺失的行无法在地图上定位
  const rows = (await db.select(
    "SELECT name, lat, lon, country, capacity_mw, primary_fuel FROM power_plants " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL",
  )) as Array<{
    name: string;
    lat: number;
    lon: number;
    country: string | null;
    capacity_mw: number | null;
    primary_fuel: string | null;
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
      },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  };
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
 */
function ensurePmtilesArchive(
  resource: string,
  { label, missingHint }: { label: string; missingHint: string },
): Promise<ArchiveHandle | null> {
  const cached = archivePromises.get(resource);
  if (cached) return cached;

  const task = (async (): Promise<ArchiveHandle | null> => {
    const protocol = ensurePmtilesProtocol();
    try {
      const absPath = await resolveResource(resource);
      const url = convertFileSrc(absPath);

      // ---- 首选：让 pmtiles 自己按需发 Range 请求 ----
      const probe = await fetch(url, { headers: { Range: "bytes=0-126" } });
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
      console.warn(`[MapPage] ${label}不可用。${missingHint}`, err);
      return null;
    }
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

  for (const tier of OSM_LINE_TIERS) {
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

interface MapPageProps {
  /** 来自设置页「在地图上查看」的指令；null 表示没有待执行的指令 */
  command?: MapCommand | null;
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
}

function MapPage({
  command = null,
  viewportRef,
  onResultsStale,
  onViewOnMap,
  onClearMap,
}: MapPageProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  // 图层控制面板的展开 / 折叠
  const [panelOpen, setPanelOpen] = useState(true);

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
  /** 阶段31：上一次「限定当前视野」查询用的范围；视野一旦移动就作废 */
  const lastViewportQueryRef = useRef<ViewportBbox | null>(null);
  /** 阶段31：通知地图页查询框清空旧结果（视野已移动，结果不再对得上画面） */
  const [queryResetSeq, setQueryResetSeq] = useState(0);

  // 图层可见性：纯视觉开关，不加载任何数据
  // 阶段30：除三个大开关外，还包含 4 个电压分级键（「电压未知」不在其中 = 默认关闭）
  const [visibleLayers, setVisibleLayers] = useState<readonly string[]>(() => [
    ...LAYERS,
    ...DEFAULT_ON_TIERS,
  ]);

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
  } | null>(null);

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

    const b = map.getBounds();
    let west = b.getWest();
    let east = b.getEast();
    if (east - west >= 360) {
      west = -180;
      east = 180;
    }

    const ctx: QueryContext = {
      viewport: {
        minLon: Number(west.toFixed(6)),
        minLat: Number(Math.max(-90, b.getSouth()).toFixed(6)),
        maxLon: Number(east.toFixed(6)),
        maxLat: Number(Math.min(90, b.getNorth()).toFixed(6)),
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
                    buildPlantPopup(feature.properties as PlantProperties),
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

              // ---- 光标反馈 ----
              for (const layerId of [
                CLUSTER_LAYER_ID,
                PLANT_LAYER_ID,
                SUBSTATIONS_LAYER_ID,
                LINES_HIT_LAYER_ID,
              ]) {
                map.on("mouseenter", layerId, () => {
                  map.getCanvas().style.cursor = "pointer";
                });
                map.on("mouseleave", layerId, () => {
                  map.getCanvas().style.cursor = "";
                });
              }

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

    // ⚠️ 输电线路的热区层必须跟着视觉线一起开关，否则会出现
    //    「线看不见了、却还能点到它的弹窗」的幽灵交互。
    // ‼️ 阶段30：输电线路细化为「一个电压档一个开关」，键直接用 vclass。
    //    `osm-line-unknown` 不再是特例 —— 它只是普通的第 5 档（默认关闭）。
    for (const tier of OSM_LINE_TIERS) {
      apply([tier.id], on(tier.vclass));
    }
    // 旧的 DB 演示线层（阶段28 已清空）与热区层跟随「任一档开启」
    apply([LINES_LAYER_ID, LINES_HIT_LAYER_ID], LINE_TIER_KEYS.some((k) => on(k)));

    // 聚合数字是 HTML Marker，上面的 setLayoutProperty 管不到它
    if (visibleLayers.includes("电厂")) {
      labelApiRef.current?.refresh();
    } else {
      labelApiRef.current?.clear();
    }

    // 阶段31：图层开关变化也要立刻反映到 AI 上下文里 ——
    // 「用户在看哪些电压等级」正是这个上下文的价值所在
    setViewportInfo(publishViewport());
  }, [visibleLayers]);

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
      const t0 = performance.now();
      const zoom = map.getZoom();
      const exact = zoom >= 8;
      const on = (name: string) => visibleLayersRef.current.includes(name);

      // 只查**当前开启**的电压档：关掉的档不应出现在统计里
      const lineLayers = OSM_LINE_TIERS.filter((t) => on(t.vclass)).map((t) => t.id);
      const lines = lineLayers.length
        ? countUnique(map.queryRenderedFeatures({ layers: lineLayers }), exact)
        : 0;
      const substations = on("变电站")
        ? countUnique(
            map.queryRenderedFeatures({ layers: [OSM_SUBSTATION_LAYER_ID] }),
            exact,
          )
        : 0;
      // 拆两段计时：渲染查询是同步的，剩下全部是 SQL 往返（电厂精确计数走数据库）
      const tRender = performance.now();

      const b = map.getBounds();
      const plantsPromise = on("电厂")
        ? loadPlantCountInBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())
        : Promise.resolve(0);

      void plantsPromise
        .then((plants) => {
          if (cancelled) return;
          const ms = performance.now() - t0;
          const msRender = tRender - t0;
          console.debug(
            `[MapPage] 视野统计 ${ms.toFixed(1)}ms（渲染查询 ${msRender.toFixed(1)}ms + 数据库 ${(ms - msRender).toFixed(1)}ms，` +
              `z=${zoom.toFixed(2)}，${exact ? "按 osm_id 去重" : "低级别按源统计"}）：` +
              `电厂 ${plants} / 线路段 ${lines} / 变电站 ${substations}`,
          );
          if (ms > 50) {
            console.warn(`[MapPage] ⚠️ 视野统计超过 50ms 护栏：${ms.toFixed(1)}ms`);
          }
          // 与统计数字放在同一次状态更新里，避免每帧多渲一次
          setViewportInfo(publishViewport());
          setViewStats({ plants, lines, substations, exact });
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
      timer = setTimeout(run, 200);
    };

    map.on("moveend", schedule);
    map.on("zoomend", schedule);
    // 建图完成后立即算一次，避免面板长时间停在「—」
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      map.off("moveend", schedule);
      map.off("zoomend", schedule);
    };
  }, [mapReady, visibleLayers]);

  return (
    <div className={styles.viewport}>
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
      />

      {/* 左上角：图层控制 */}
      <section className={styles.layerPanel} aria-label="图层控制">
        <button
          type="button"
          className={styles.panelToggle}
          aria-expanded={panelOpen}
          aria-controls="map-layer-list"
          onClick={() => setPanelOpen((open) => !open)}
        >
          <span>图层控制</span>
          <span className={styles.chevron} aria-hidden="true">
            {panelOpen ? "▼" : "▶"}
          </span>
        </button>

        <ul id="map-layer-list" className={styles.layerList} hidden={!panelOpen}>
          {LAYERS.map((name) => {
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
            永远不会和地图上的颜色脱节。 */}
        <div className={styles.tierGroup} hidden={!panelOpen}>
          <p className={styles.legendTitle}>输电线路（按电压分级）</p>
          <ul className={styles.tierList}>
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

        {/* 燃料类型图例：纯 DOM + CSS，色块颜色取自与地图同一份 FUEL_COLORS，
            不引入任何图表 / 配色库。随图层面板一同折叠。 */}
        <div className={styles.legend} hidden={!panelOpen}>
          <p className={styles.legendTitle}>燃料类型</p>
          <ul className={styles.legendList}>
            {FUEL_LEGEND.map(([fuel, label]) => (
              <li key={fuel} className={styles.legendItem}>
                <span
                  className={styles.legendSwatch}
                  style={{ backgroundColor: fuelColor(fuel) }}
                  aria-hidden="true"
                />
                {label}
              </li>
            ))}
          </ul>

          {/* 阶段21：电网基础设施的视觉约定。颜色与上面的图层开关、
              以及 MapPage.tsx 顶部的 SUBSTATION_COLOR / LINE_COLOR 保持一致。 */}
          <p className={styles.legendTitle}>基础设施</p>
          <ul className={styles.legendList}>
            <li className={styles.legendItem}>
              <span
                className={styles.legendSwatch}
                style={{ backgroundColor: SUBSTATION_COLOR }}
                aria-hidden="true"
              />
              变电站
            </li>
            <li className={styles.legendItem}>
              <span
                className={styles.legendLine}
                style={{ backgroundColor: LINE_COLOR }}
                aria-hidden="true"
              />
              输电线路
            </li>
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

      {/* 阶段30：当前视野数据统计。
          放左下角、比例尺上方 —— 左上是图层面板、右上是缩放、右下是版权、底部中间是提示，
          只剩这个位置不会碰撞。`pointer-events: none` 保证它不挡地图拖拽。 */}
      <section
        className={styles.statsPanel}
        aria-label="当前视野数据统计"
        aria-live="polite"
      >
        <p className={styles.statsTitle}>本视野</p>
        <ul className={styles.statsList}>
          <li>
            电厂 <b>{viewStats ? viewStats.plants.toLocaleString() : "—"}</b> 座
          </li>
          <li>
            线路段{" "}
            <b>
              {viewStats
                ? `${viewStats.exact ? "" : "≈"}${viewStats.lines.toLocaleString()}`
                : "—"}
            </b>{" "}
            段
          </li>
          <li>
            变电站{" "}
            <b>
              {viewStats
                ? `${viewStats.exact ? "" : "≈"}${viewStats.substations.toLocaleString()}`
                : "—"}
            </b>{" "}
            座
          </li>
        </ul>
        <p className={styles.statsNote}>
          {viewStats && !viewStats.exact
            ? "z<8 为按源统计（含瓦片边缘重复）"
            : "z≥8 已按 osm_id 去重"}
        </p>
      </section>
    </div>
  );
}

export default MapPage;
