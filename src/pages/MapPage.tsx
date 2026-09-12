import { useEffect, useRef, useState } from "react";
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
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { FUEL_LEGEND, fuelColor } from "../lib/fuel";
import {
  MAX_HIGHLIGHT_POINTS,
  buildBoundsSql,
  buildHighlightSql,
  type MapCommand,
} from "../lib/nlq";
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
 *    即：底图 → 输电线路 → 变电站 → 电厂 → 聚合 → 高亮。
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

/** 底图归档的定位结果 */
type BasemapHandle = {
  /** 协议表里的键：Range 模式是 asset URL，内存模式是资源路径 */
  key: string;
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
let basemapReady: Promise<BasemapHandle | null> | null = null;

function ensurePmtilesProtocol(): Promise<BasemapHandle | null> {
  basemapReady ??= (async () => {
    const protocol = new Protocol();
    // pmtiles v4 的处理器叫 tilev4（不是 tile）
    addProtocol("pmtiles", protocol.tilev4);

    try {
      const absPath = await resolveResource(BASEMAP_RESOURCE);
      const url = convertFileSrc(absPath);

      // ---- 首选：让 pmtiles 自己按需发 Range 请求 ----
      const probe = await fetch(url, { headers: { Range: "bytes=0-126" } });
      if (probe.status === 206) {
        assertPmtilesMagic(new Uint8Array(await probe.arrayBuffer()));
        const archive = new PMTiles(url);
        protocol.add(archive);
        const header = await archive.getHeader();
        console.info(
          `[MapPage] 离线底图就绪（Range 读取）：${absPath}，z${header.minZoom}-${header.maxZoom}，` +
            `${header.numAddressedTiles} 个瓦片，Content-Range=${probe.headers.get("content-range") ?? "-"}`,
        );
        return {
          key: url,
          minZoom: header.minZoom,
          maxZoom: header.maxZoom,
          mode: "range",
        };
      }

      // ---- 退化：协议不支持 Range，只能整包读进内存 ----
      console.warn(
        `[MapPage] 底图协议未按 Range 返回（HTTP ${probe.status}，期望 206），` +
          `退回整包读取。当前归档 33 MB 尚可，但这说明 asset 协议没有生效。`,
      );
      const res = await fetch(url);
      if (!res.ok) throw new Error(`读取底图失败：HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      assertPmtilesMagic(new Uint8Array(buffer, 0, 7));
      const archive = new PMTiles(new MemorySource(buffer, BASEMAP_RESOURCE));
      protocol.add(archive);
      const header = await archive.getHeader();
      return {
        key: BASEMAP_RESOURCE,
        minZoom: header.minZoom,
        maxZoom: header.maxZoom,
        mode: "memory",
      };
    } catch (err) {
      console.error(
        "[MapPage] 离线底图不可用，将只显示纯色背景。" +
          "请先运行 `node scripts/fetch_basemap.mjs` 生成底图。",
        err,
      );
      return null;
    }
  })();

  return basemapReady;
}

/** 用真实离线底图拼一个内联样式，彻底摆脱在线演示瓦片 */
function buildBasemapStyle(basemap: BasemapHandle | null): StyleSpecification {
  if (!basemap) {
    return { version: 8, sources: {}, layers: [BACKGROUND_LAYER] };
  }

  return {
    version: 8,
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
  map.addLayer({
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
  });
}

/** 清空高亮（保留图层，避免反复增删） */
function clearHighlight(map: MapLibreMap) {
  const src = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

interface MapPageProps {
  /** 来自设置页「在地图上查看」的指令；null 表示没有待执行的指令 */
  command?: MapCommand | null;
}

function MapPage({ command = null }: MapPageProps) {
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

  // 图层可见性：纯视觉开关，不加载任何数据
  const [visibleLayers, setVisibleLayers] = useState<readonly string[]>(() => [
    ...LAYERS,
  ]);

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
        setMapNotice("已回到全球视图（全球概览不做单点高亮）");
        map.flyTo({
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          duration: 1200,
        });
        return;
      }

      // 1) 用**数据算出来的** bbox 决定飞到哪里，代码里不硬编码任何国家边界
      const boundsPlan = buildBoundsSql(cmd);
      const boundsRows = (await db.select(
        boundsPlan.sql,
        boundsPlan.params,
      )) as Array<{
        min_lon: number | null;
        min_lat: number | null;
        max_lon: number | null;
        max_lat: number | null;
      }>;

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
      setMapNotice(
        points.length > 0
          ? `已高亮 ${points.length} 个匹配的电厂（金色描边）`
          : "没有匹配到电厂",
      );
    } catch (err) {
      console.error("[MapPage] 执行地图指令失败", err);
      setMapNotice("执行地图指令失败，详见控制台。");
    }
  };

  /** 只有「地图已就绪 + 确实有待处理命令」时才真正执行 */
  const tryApplyCommand = () => {
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

    ensurePmtilesProtocol()
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
          Database.load(DB_URL)
            .then(() =>
              Promise.all([
                loadSubstationsGeoJson(),
                loadLinesGeoJson(),
                loadPlantsGeoJson(),
              ]),
            )
            .then(([substationData, lineData, data]) => {
              // 等异步查询期间组件可能已卸载，此时不能碰地图
              if (disposed || !mapRef.current) return;

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

              // 地图与数据都就绪了，到这一步才能执行飞行与高亮。
              // 顺便消费掉可能早于地图到达的那条指令。
              mapReadyRef.current = true;
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

    const visibility = (name: string) =>
      visibleLayers.includes(name) ? "visible" : "none";

    // 前三个图层都由「电厂」开关统一控制：高亮层是查询结果的叠加，
    // 若单独留着，会出现「电厂关掉了但还飘着一圈金环」的怪状。
    // ⚠️ 输电线路的热区层必须跟着视觉线一起开关，否则会出现
    //    「线看不见了、却还能点到它的弹窗」的幽灵交互。
    const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["电厂", [CLUSTER_LAYER_ID, PLANT_LAYER_ID, HIGHLIGHT_LAYER_ID]],
      ["变电站", [SUBSTATIONS_LAYER_ID]],
      ["输电线路", [LINES_LAYER_ID, LINES_HIT_LAYER_ID]],
    ];

    for (const [name, ids] of groups) {
      for (const id of ids) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visibility(name));
        }
      }
    }

    // 聚合数字是 HTML Marker，上面的 setLayoutProperty 管不到它
    if (visibleLayers.includes("电厂")) {
      labelApiRef.current?.refresh();
    } else {
      labelApiRef.current?.clear();
    }
  }, [visibleLayers]);

  return (
    <div className={styles.viewport}>
      {/* 地图画布容器：铺满视窗，位于悬浮 UI 之下 */}
      <div ref={mapContainerRef} className={styles.mapContainer} />

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
            const isVisible = visibleLayers.includes(name);

            return (
              <li key={name}>
                <button
                  type="button"
                  className={styles.layerBtn}
                  aria-pressed={isVisible}
                  onClick={() => toggleLayer(name)}
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
    </div>
  );
}

export default MapPage;
