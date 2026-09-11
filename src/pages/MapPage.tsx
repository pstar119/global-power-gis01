import styles from "./MapPage.module.css";

/** 图层清单：纯 UI 占位，不含任何真实数据 */
const LAYERS = ["电厂", "变电站", "输电线路"] as const;

function MapPage() {
  return (
    <div className={styles.viewport}>
      {/* 左上角：图层控制 */}
      <section className={styles.layerPanel} aria-label="图层控制">
        <p className={styles.panelTitle}>图层控制</p>
        <ul className={styles.layerList}>
          {LAYERS.map((name) => (
            <li key={name}>
              <button type="button" disabled className={styles.layerBtn}>
                <span className={styles.layerSwatch} aria-hidden="true" />
                {name}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* 右上角：缩放控件 */}
      <div className={styles.zoomControl} role="group" aria-label="缩放控件">
        <button type="button" disabled className={styles.zoomBtn} aria-label="放大">
          +
        </button>
        <button type="button" disabled className={styles.zoomBtn} aria-label="缩小">
          −
        </button>
      </div>

      {/* 左下角：比例尺 */}
      <div className={styles.scaleBar}>
        <span className={styles.scaleTrack} aria-hidden="true" />
        <span className={styles.scaleLabel}>500 km</span>
      </div>
    </div>
  );
}

export default MapPage;
