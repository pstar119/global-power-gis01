import { useEffect, useRef, useState } from "react";
// 仅用命名导入：maplibre-gl 的类型声明不提供 default export
import {
  Map as MapLibreMap,
  ScaleControl,
  addProtocol,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

/**
 * 本地离线瓦片夹具，由 `node scripts/make_test_pmtiles.mjs` 生成。
 * 几何全部是程序合成的图形，**不含任何真实电力数据**。
 *
 * 放在 `public/` 下 → 直接用相对路径读取即可：
 * 开发时由 Vite dev server 提供（已实测支持 HTTP Range），
 * 打包后由 Tauri 内置的 asset 协议提供（同样支持 Range），
 * 因此**无需**开启 assetProtocol、也无需动 capabilities 或任何 Rust 代码。
 */
const FIXTURE_PATH = "power-fixture.pmtiles";

const INITIAL_CENTER: [number, number] = [0, 20];
const INITIAL_ZOOM = 1.5;

/**
 * PMTiles 协议单例。两个必须遵守的点：
 *
 * 1. MapLibre 的协议注册表是**全局**的，重复注册同名协议会抛错；而 `main.tsx`
 *    开了 StrictMode，effect 会「执行 → 清理 → 再执行」，所以注册必须幂等。
 * 2. 正因如此，cleanup 里**不能**调 removeProtocol —— 一旦摘掉，第二次建图时
 *    协议就没了，表现为瓦片全空且控制台不报错。
 */
let pmtilesProtocol: Protocol | null = null;

function ensurePmtilesProtocol(): void {
  if (pmtilesProtocol) return;

  const protocol = new Protocol();
  // pmtiles v4 的处理器叫 tilev4（不是 tile）
  addProtocol("pmtiles", protocol.tilev4);
  pmtilesProtocol = protocol;
}

/** 用本地 .pmtiles 拼一个内联样式，彻底摆脫在线演示瓦片 */
function buildFixtureStyle(): StyleSpecification {
  // pmtiles:// 后面必须给**绝对 URL**：它内部是用 new URL() 解析的，
  // 相对地址是否落到同源不好预测，显式转成绝对地址最稳。
  const archiveUrl = new URL(FIXTURE_PATH, document.baseURI).href;

  return {
    version: 8,
    sources: {
      "power-fixture": {
        type: "vector",
        url: `pmtiles://${archiveUrl}`,
        // 夹具只做到 z3，再放大由 MapLibre 自动 overzoom
        maxzoom: 3,
        attribution: "合成测试数据（非真实电力数据）",
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#101418" },
      },
      {
        id: "fixture-substations",
        type: "fill",
        source: "power-fixture",
        "source-layer": "substations",
        paint: { "fill-color": "#007acc", "fill-opacity": 0.45 },
      },
      {
        id: "fixture-substation-borders",
        type: "line",
        source: "power-fixture",
        "source-layer": "substations",
        paint: { "line-color": "#4daafc", "line-width": 1 },
      },
      {
        id: "fixture-power-lines",
        type: "line",
        source: "power-fixture",
        "source-layer": "power-lines",
        paint: { "line-color": "#7fd4ff", "line-width": 1.5 },
      },
      {
        id: "fixture-power-plants",
        type: "circle",
        source: "power-fixture",
        "source-layer": "power-plants",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffb300",
          "circle-stroke-color": "#3a2a00",
          "circle-stroke-width": 1,
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

    // 必须在建图之前注册协议，否则第一帧就要不到瓦片
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: mapContainerRef.current,
      style: buildFixtureStyle(),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      // 保留版权信息（合规），右下角紧凑显示，不与我们左下角的比例尺冲突
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    // 比例尺改用 MapLibre 自带的 ScaleControl（库自带，零新增依赖），
    // 取代原先写死“500 km”的静态占位。
    map.addControl(
      new ScaleControl({ maxWidth: 100, unit: "metric" }),
      "bottom-left",
    );

    return () => {
      map.remove();
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
