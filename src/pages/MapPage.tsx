import { useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import type { FeatureCollection, Point } from "geojson";
// 仅用命名导入：maplibre-gl 的类型声明不提供 default export
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  ScaleControl,
  addProtocol,
  type GeoJSONSource,
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
 * 本地离线瓦片夹具，由 `node scripts/make_test_pmtiles.mjs` 生成。
 * 几何全部是程序合成的图形，**不含任何真实电力数据**。
 * 文件放在 `public/` 下，开发与打包后都用相对路径读取。
 */
const FIXTURE_PATH = "power-fixture.pmtiles";

/** 内存归档在协议表里的键：样式里的 `pmtiles://<key>` 必须与它完全一致 */
const FIXTURE_KEY = "power-fixture.pmtiles";

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
 *    即：fixture → 输电线路 → 变电站 → 电厂 → 聚合 → 高亮。
 */
const SUBSTATIONS_SOURCE = "substations-data";
const SUBSTATIONS_LAYER_ID = "substation-points";
const LINES_SOURCE = "transmission-lines-data";
const LINES_LAYER_ID = "transmission-lines";

/** 变电站统一用青蓝色（不按电压上色：燃料配色盘已被 15 种燃料占满，再加一套会和图例打架） */
const SUBSTATION_COLOR = "#3fd0c9";
/** 输电线路用中性灰，在 #101418 深底上可见但不抢眼 */
const LINE_COLOR = "#8b96a8";

/** Popup 里展示的字段（来自 GeoJSON properties） */
type PlantProperties = {
  name: string;
  country: string | null;
  capacity: number | null;
  fuel: string | null;
  color: string;
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
  const root = document.createElement("div");
  root.className = styles.popup;

  const title = document.createElement("h3");
  title.className = styles.popupTitle;
  title.textContent = props.name || "未命名电厂";
  root.appendChild(title);

  const list = document.createElement("dl");
  list.className = styles.popupList;

  const rows: ReadonlyArray<readonly [string, string]> = [
    ["国家/地区", props.country || "未知"],
    ["燃料类型", props.fuel || "未知"],
    ["装机容量", props.capacity == null ? "未提供" : `${props.capacity} MW`],
  ];

  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;

    const dd = document.createElement("dd");
    dd.textContent = value;

    // 燃料那一行在文字前加一个与地图同色的色块，和图例形成呼应
    if (label === "燃料类型" && props.fuel) {
      const swatch = document.createElement("span");
      swatch.className = styles.popupSwatch;
      swatch.style.backgroundColor = props.color;
      dd.prepend(swatch);
    }

    list.append(dt, dd);
  }

  root.appendChild(list);
  return root;
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
 * 把整个归档读进内存后自建的 PMTiles Source。
 *
 * ⚠️ 为什么不让 pmtiles 自己去发 Range 请求（`pmtiles://http://...`）？
 * 因为生产环境里 `public/` 下的文件是由 Tauri 的 `tauri.localhost`（内嵌资源协议）
 * 提供的，而它**不实现 HTTP Range**：即使收到 `Range: bytes=0-16383`，也返回
 * `200` + 全量正文，且**不带 Content-Length / Content-Range**。
 * pmtiles 的 FetchSource 据此判定"后端不支持字节服务"并抛错，
 * 结果是底图只剩一层背景色（近黑）、页面上完全没有网格。
 *
 * 夹具只有 ~100 KB，整包读进内存最稳，而且 dev 与生产走**完全相同**的代码路径
 * （dev 下 Vite 其实支持 Range，但没必要为此分叉出两套逻辑）。
 *
 * 🔴 **只能用于小文件。** 接入 100 MB+ 的真实离线归档时必须改回 Tauri 的
 * asset 协议（`asset.localhost`，它实现了真正的 Range），
 * 绡不能把大数据整包读进内存。
 */
class ByteSource {
  #buffer: ArrayBuffer;
  #key: string;

  constructor(buffer: ArrayBuffer, key: string) {
    this.#buffer = buffer;
    this.#key = key;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    // 返回独立副本，不把整个归档的底层 buffer 泄需出去
    return { data: this.#buffer.slice(offset, offset + length) };
  }

  getKey(): string {
    return this.#key;
  }
}

/**
 * 协议注册 + 归档加载，全程只执行一次。
 *
 * 两个必须遵守的点：
 * 1. MapLibre 的协议注册表是**全局**的，重复注册同名协议会抛错；而 `main.tsx`
 *    开了 StrictMode，effect 会「执行 → 清理 → 再执行」，所以这里必须幂等。
 * 2. 正因如此，cleanup 里**不能**调 removeProtocol —— 一旦摘掉，第二次建图时
 *    协议就没了，表现为瓦片全空且控制台不报错。
 */
let pmtilesReady: Promise<void> | null = null;

function ensurePmtilesProtocol(): Promise<void> {
  pmtilesReady ??= (async () => {
    const protocol = new Protocol();
    // pmtiles v4 的处理器叫 tilev4（不是 tile）
    addProtocol("pmtiles", protocol.tilev4);

    const res = await fetch(FIXTURE_PATH);
    if (!res.ok) {
      throw new Error(`加载 ${FIXTURE_PATH} 失败：HTTP ${res.status}`);
    }
    // 必须先于建图完成，否则 MapLibre 第一批瓦片请求会全部落空
    const buffer = await res.arrayBuffer();
    protocol.add(new PMTiles(new ByteSource(buffer, FIXTURE_KEY)));
  })();

  return pmtilesReady;
}

/** 用本地 .pmtiles 拼一个内联样式，彻底摆脫在线演示瓦片 */
function buildFixtureStyle(): StyleSpecification {
  // pmtiles:// 后面给的不是网络地址，而是**内存归档在协议表里的键**：
  // Protocol.add() 用 source.getKey() 注册，两名字符串必须完全一致。
  return {
    version: 8,
    sources: {
      "power-fixture": {
        type: "vector",
        url: `pmtiles://${FIXTURE_KEY}`,
        // 夹具只做到 z4；再放大由 MapLibre 自动 overzoom
        maxzoom: 4,
        // ⚠️ WRI 数据采用 CC BY 4.0 许可，**要求署名**，这段来源说明必须保留。
        // 底图瓦片目前仍是阶段11 的合成夹具，两者性质不同，必须分别说明。
        attribution:
          "电厂数据 © WRI Global Power Plant Database (CC BY 4.0)；离线瓦片为合成测试数据。",
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#101418" },
      },
      // ⚠️ 以下 4 个是**合成夹具**图层：几何全部是程序生成的格子，
      //    不对应任何真实地理位置，仅用于证明离线瓦片通道可用。
      //    真实电厂数据叠加在其上，所以这里把不透明度压得很低，
      //    避免干扰对真实点的观察。
      //    `maxzoom: 7` 表示 zoom >= 7 时隐藏（MapLibre 的语义是“大于等于即隐藏”）：
      //    夹具只做到 z4，再放大就会 overzoom 成空白格子，不如直接让位给真实数据。
      {
        id: "fixture-substations",
        type: "fill",
        source: "power-fixture",
        "source-layer": "substations",
        maxzoom: 7,
        paint: { "fill-color": "#007acc", "fill-opacity": 0.1 },
      },
      {
        id: "fixture-substation-borders",
        type: "line",
        source: "power-fixture",
        "source-layer": "substations",
        maxzoom: 7,
        paint: { "line-color": "#4daafc", "line-width": 1, "line-opacity": 0.18 },
      },
      {
        id: "fixture-power-lines",
        type: "line",
        source: "power-fixture",
        "source-layer": "power-lines",
        maxzoom: 7,
        paint: { "line-color": "#7fd4ff", "line-width": 1.5, "line-opacity": 0.18 },
      },
      {
        id: "fixture-power-plants",
        type: "circle",
        source: "power-fixture",
        "source-layer": "power-plants",
        maxzoom: 7,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffb300",
          "circle-opacity": 0.12,
          "circle-stroke-color": "#3a2a00",
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.12,
        },
      },
    ],
  };
}

/** 把匹配的点写进高亮图层（图层只建一次，之后只改数据） */
function renderHighlight(
  map: MapLibreMap,
  rows: ReadonlyArray<{ lat: number; lon: number }>,
) {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: {},
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
      // 放大 + 金色描边：与深色底图对比强，且不消耗持续 CPU
      "circle-radius": 7,
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
      }

      // 2) 取明细点做高亮（SQL 里多取一个，用于判断是否超限）
      const hlPlan = buildHighlightSql(cmd);
      const points = (await db.select(hlPlan.sql, hlPlan.params)) as Array<{
        name: string;
        lat: number;
        lon: number;
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

    // 归档现在是异步读进内存的，所以建图必须等它就绪：
    // 否则建图时 MapLibre 的第一批瓦片请求会全部落空。
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
      .then(() => {
        // 等待期间组件可能已卸载（StrictMode 下必然发生一次），此时不能再建图
        if (disposed || !mapContainerRef.current) return;

        const map = new MapLibreMap({
          container: mapContainerRef.current,
          style: buildFixtureStyle(),
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          // 保留版权信息（合规），右下角紧凑显示，不与我们左下角的比例尺冲突
          attributionControl: { compact: true },
          // 阶段15 从 6 提到 12。原来的 6 是为合成夹具设的，但它会把
          // clusterMaxZoom(8) 卡死 —— 点击聚合点算出的目标级别被截断后，
          // 永远展不开到单个电厂。夹具现在改由各图层的 maxzoom:7 负责隐藏。
          maxZoom: 12,
        });
        mapRef.current = map;

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
                  // 半径按电压分级，直观体现站点的重要性层级
                  "circle-radius": [
                    "step",
                    ["get", "voltage"],
                    4,
                    220,
                    5.5,
                    500,
                    7,
                  ],
                  "circle-opacity": 0.9,
                  "circle-stroke-color": "#06333a",
                  "circle-stroke-width": 1.2,
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
                  "circle-radius": 5,
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

              // ---- 光标反馈 ----
              for (const layerId of [CLUSTER_LAYER_ID, PLANT_LAYER_ID]) {
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
    const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["电厂", [CLUSTER_LAYER_ID, PLANT_LAYER_ID, HIGHLIGHT_LAYER_ID]],
      ["变电站", [SUBSTATIONS_LAYER_ID]],
      ["输电线路", [LINES_LAYER_ID]],
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
