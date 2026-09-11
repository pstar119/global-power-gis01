import { useState } from "react";
import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

interface MapPageProps {
  /** 视窗占位提示（来自侧边栏菜单定义，保持单一数据源） */
  hint: string;
}

function MapPage({ hint }: MapPageProps) {
  // 图层控制面板的展开 / 折叠
  const [panelOpen, setPanelOpen] = useState(true);

  // 图层可见性：纯视觉开关，不加载任何数据、不影响任何渲染
  const [visibleLayers, setVisibleLayers] = useState<readonly string[]>(() => [
    ...LAYERS,
  ]);

  const toggleLayer = (name: string) => {
    setVisibleLayers((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  return (
    <div className={styles.viewport}>
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

      {/* 右上角：缩放控件（只有 :active 按压反馈，不改变任何状态） */}
      <div className={styles.zoomControl} role="group" aria-label="缩放控件">
        <button type="button" className={styles.zoomBtn} aria-label="放大">
          +
        </button>
        <button type="button" className={styles.zoomBtn} aria-label="缩小">
          −
        </button>
      </div>

      {/* 左下角：比例尺 */}
      <div className={styles.scaleBar}>
        <span className={styles.scaleTrack} aria-hidden="true" />
        <span className={styles.scaleLabel}>500 km</span>
      </div>

      {/* 视窗中央：占位提示 */}
      <p className={styles.viewportHint}>{hint}</p>
    </div>
  );
}

export default MapPage;
