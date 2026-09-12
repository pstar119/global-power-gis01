import { useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import type { FeatureCollection } from "geojson";
// 仅用命名导入：maplibre-gl 的类型声明不提供 default export
import {
  Map as MapLibreMap,
  ScaleControl,
  addProtocol,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

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

/** 电厂点图层的 source / layer id */
const PLANTS_SOURCE = "power-plants";
const PLANTS_LAYER_ID = "power-plants";

/**
 * 燃料类型 -> 颜色。
 *
 * ⚠️ 刻意用**纯对象字面量**实现，绝不引入 d3-scale / chroma.js 等配色库：
 *    一张颜色映射表不值得增加任何依赖。
 *
 * key 对应 WRI 数据集的 primary_fuel 取值（实测共 15 类）。
 */
const FUEL_COLORS: Record<string, string> = {
  Coal: "#8d8d8d", // 煤：灰
  Gas: "#ff9b52", // 气：橙
  Oil: "#b0703f", // 油：棕
  Nuclear: "#c77dff", // 核：紫
  Hydro: "#4daafc", // 水：蓝
  Wind: "#5ee39b", // 风：绿
  Solar: "#ffd24a", // 光：黄
  Biomass: "#7fc76f", // 生物质：草绿
  Geothermal: "#ff6b6b", // 地热：红
  Waste: "#b0a04a", // 废弃物：土黄
  Storage: "#4fd1c5", // 储能：青
  Cogeneration: "#c9a227", // 热电联产：金
  Petcoke: "#6b6b6b", // 石油焦：深灰
  "Wave and Tidal": "#2e9bd6", // 潮汐：海蓝
  Other: "#9aa0a6", // 其他：中性灰
};

/** 未知 / 缺失燃料类型时的兜底色 */
const FUEL_FALLBACK_COLOR = "#9aa0a6";

function fuelColor(fuel: string | null): string {
  if (!fuel) return FUEL_FALLBACK_COLOR;
  return FUEL_COLORS[fuel] ?? FUEL_FALLBACK_COLOR;
}

/**
 * 图例条目：燃料英文键 -> 中文标签（顺序即图例展示顺序）。
 * 色块颜色不在这里写死，而是渲染时从 FUEL_COLORS 取 —— 避免颜色定义两处维护。
 */
const FUEL_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Coal", "煤电"],
  ["Gas", "燃气"],
  ["Oil", "燃油"],
  ["Nuclear", "核电"],
  ["Hydro", "水电"],
  ["Wind", "风电"],
  ["Solar", "光伏"],
  ["Biomass", "生物质"],
  ["Geothermal", "地热"],
  ["Waste", "废弃物"],
  ["Storage", "储能"],
  ["Cogeneration", "热电联产"],
  ["Petcoke", "石油焦"],
  ["Wave and Tidal", "潮汐"],
  ["Other", "其他"],
];

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
    "SELECT name, lat, lon, primary_fuel FROM power_plants " +
      "WHERE lat IS NOT NULL AND lon IS NOT NULL",
  )) as Array<{
    name: string;
    lat: number;
    lon: number;
    primary_fuel: string | null;
  }>;

  return {
    type: "FeatureCollection",
    // ⚠️ GeoJSON 的坐标顺序是 [经度, 纬度]，与 SQL 里 lat / lon 的书写顺序相反
    features: rows.map((r) => ({
      type: "Feature",
      properties: {
        name: r.name,
        fuel: r.primary_fuel,
        // 颜色在这里算好写进属性，样式里直接用 ["get", "color"] 取。
        // 比在样式里堆一长串 match 表达式简单，且将来加图例时可复用同一份映射。
        color: fuelColor(r.primary_fuel),
      },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
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
      //    阶段14 起真实电厂叠加在其上，所以这里把不透明度压得很低，
      //    避免干扰对 3.5 万个真实点的观察。
      {
        id: "fixture-substations",
        type: "fill",
        source: "power-fixture",
        "source-layer": "substations",
        paint: { "fill-color": "#007acc", "fill-opacity": 0.1 },
      },
      {
        id: "fixture-substation-borders",
        type: "line",
        source: "power-fixture",
        "source-layer": "substations",
        paint: { "line-color": "#4daafc", "line-width": 1, "line-opacity": 0.18 },
      },
      {
        id: "fixture-power-lines",
        type: "line",
        source: "power-fixture",
        "source-layer": "power-lines",
        paint: { "line-color": "#7fd4ff", "line-width": 1.5, "line-opacity": 0.18 },
      },
      {
        id: "fixture-power-plants",
        type: "circle",
        source: "power-fixture",
        "source-layer": "power-plants",
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

function MapPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  // 图层控制面板的展开 / 折叠
  const [panelOpen, setPanelOpen] = useState(true);

  // 图层可见性：纯视觉开关，不加载任何数据
  const [visibleLayers, setVisibleLayers] = useState<readonly string[]>(() => [
    ...LAYERS,
  ]);

  // 地图实例的创建与销毁都在这个 effect 里。
  // ⚠️ main.tsx 开了 React StrictMode，开发模式下 effect 会「执行 → 清理 → 再执行」，
  //    所以 cleanup 必须真的 map.remove()，否则会出现“容器已初始化”报错或实例泄漏。
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // 归档现在是异步读进内存的，所以建图必须等它就绪：
    // 否则建图时 MapLibre 的第一批瓦片请求会全部落空。
    let disposed = false;

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
          // 【仅测试夹具阶段的限制】夹具是周期性合成图案，放大超过一定程度后
          // 视口会整个落在一个网格内部而变空（看起来像坏了）。
          // 变空条件 2^(z-Z) > W_px·N/512：Z=4、N=4 时，最窄窗口
          // （minHeight 700 → 内容区高约 651px）算得临界点为 z≈6.35。
          // 所以这里封在 6，既保留连续的放大手感又不会出现全空。
          // ⚠️ 接入真实离线数据后应当调高或移除这个限制。
          maxZoom: 6,
        });
        mapRef.current = map;

        // 比例尺改用 MapLibre 自带的 ScaleControl（库自带，零新增依赖），
        // 取代原先写死“500 km”的静态占位。
        map.addControl(
          new ScaleControl({ maxWidth: 100, unit: "metric" }),
          "bottom-left",
        );

        // 把 SQLite 里的电厂渲染成圆点图层。
        // 等 style 加载完再 addSource/addLayer —— 未加载完就加会抛错。
        map.once("load", () => {
          loadPlantsGeoJson()
            .then((data) => {
              // 等异步查询期间组件可能已卸载，此时不能碰地图
              if (disposed || !mapRef.current) return;

              map.addSource(PLANTS_SOURCE, { type: "geojson", data });
              map.addLayer({
                id: PLANTS_LAYER_ID,
                type: "circle",
                source: PLANTS_SOURCE,
                paint: {
                  // 半径不能太大：全球视图下 3.5 万个点会彼此严重重叠
                  "circle-radius": 4,
                  // 颜色由属性携带（见 loadPlantsGeoJson 里的 fuelColor 映射）
                  "circle-color": ["get", "color"],
                  "circle-opacity": 0.85,
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 0.5,
                  "circle-stroke-opacity": 0.6,
                },
              });
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
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const toggleLayer = (name: string) => {
    setVisibleLayers((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

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
                  <span className={styles.layerSwatch} aria-hidden="true" />
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
    </div>
  );
}

export default MapPage;
