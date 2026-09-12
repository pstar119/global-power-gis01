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

/** 电厂数据源 id（聚合图层与单点图层共用同一个 source） */
const PLANTS_SOURCE = "power-plants";
/** 聚合圆的图层 id */
const CLUSTER_LAYER_ID = "power-plant-clusters";
/** 单个电厂的图层 id */
const PLANT_LAYER_ID = "power-plant-points";

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
      // 先摘掉标记与弹窗，再销毁地图
      clearClusterLabels();
      popup.remove();
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
