import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { countryLabel } from "../lib/country";
import { fuelColor, fuelLabel } from "../lib/fuel";
import styles from "./StatsPage.module.css";

/** 必须与 src-tauri/src/lib.rs 里的 DB_URL 一致 */
const DB_URL = "sqlite:global_power_gis.db";

/**
 * Q1：一次往返取回 4 个核心指标。
 * ⚠️ 全部交给 SQLite 引擎聚合，绝不把 3.5 万行拉到前端用 JS 循环计算。
 */
const CORE_SQL = `SELECT
  (SELECT COUNT(*)                     FROM power_plants) AS total_plants,
  (SELECT SUM(capacity_mw)             FROM power_plants) AS total_capacity_mw,
  (SELECT COUNT(DISTINCT country)      FROM power_plants) AS countries,
  (SELECT COUNT(DISTINCT primary_fuel) FROM power_plants) AS fuels`;

/** Q2：装机容量 Top5 国家（GROUP BY / ORDER BY / LIMIT 全部下推到 SQLite） */
const TOP_COUNTRIES_SQL = `SELECT country,
       SUM(capacity_mw) AS capacity_mw,
       COUNT(*)         AS plants
FROM power_plants
WHERE country IS NOT NULL AND capacity_mw IS NOT NULL
GROUP BY country
ORDER BY capacity_mw DESC
LIMIT 5`;

/** Q3：燃料分布，按总容量降序 */
const FUELS_SQL = `SELECT primary_fuel,
       COUNT(*)         AS plants,
       SUM(capacity_mw) AS capacity_mw
FROM power_plants
WHERE primary_fuel IS NOT NULL AND capacity_mw IS NOT NULL
GROUP BY primary_fuel
ORDER BY capacity_mw DESC`;

type CoreStats = {
  total_plants: number;
  total_capacity_mw: number;
  countries: number;
  fuels: number;
};

type CountryRow = { country: string; capacity_mw: number; plants: number };
type FuelRow = { primary_fuel: string; plants: number; capacity_mw: number };

/** 用可辨识联合表达三种状态，避免散落的 `data === undefined` 判断 */
type StatsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      core: CoreStats;
      countries: CountryRow[];
      fuels: FuelRow[];
    };

interface StatItem {
  label: string;
  value: string;
  unit: string;
}

interface BarItem {
  key: string;
  label: string;
  /** 0~1，决定条形长度 */
  ratio: number;
  /** 右侧显示的数值文本 */
  display: string;
  /** 不传则用主题强调色 */
  color?: string;
}

interface StatsPageProps {
  /** 页面标题（来自侧边栏菜单定义，保持单一数据源） */
  hint: string;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("zh-CN");

function StatCard({ label, value, unit }: StatItem) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>
        {value}
        <span className={styles.statUnit}>{unit}</span>
      </span>
    </div>
  );
}

/** 纯 CSS 横向条形图：轨道宽度固定，内层矩形的宽度按比例设置 */
function BarChart({ items }: { items: BarItem[] }) {
  return (
    <ul className={styles.barList}>
      {items.map((it) => (
        <li key={it.key} className={styles.barRow}>
          <span className={styles.barLabel} title={it.label}>
            {it.label}
          </span>
          <span className={styles.barTrack}>
            <span
              className={styles.barFill}
              style={{
                // 最小取 1% 兜底：占比极小的档位若按真实比例会是 0.02%，
                // 条形几乎不可见，看起来像渲染失败
                width: `${Math.max(it.ratio * 100, 1)}%`,
                backgroundColor: it.color,
              }}
            />
          </span>
          <span className={styles.barValue}>{it.display}</span>
        </li>
      ))}
    </ul>
  );
}

function StatsPage({ hint }: StatsPageProps) {
  const [state, setState] = useState<StatsState>({ status: "loading" });

  useEffect(() => {
    // ⚠️ StrictMode 下 effect 会「执行 → 清理 → 再执行」，用户切走页面时组件也会卸载。
    //    没有这个标志就会在卸载后 setState（React 会警告，且可能写入已过期的状态）。
    let cancelled = false;

    (async () => {
      try {
        const db = await Database.load(DB_URL);

        // 三条查询串行发出；分别返回 1 / 5 / 15 行，IPC 开销可忽略
        const coreRows = (await db.select(CORE_SQL)) as CoreStats[];
        const countries = (await db.select(TOP_COUNTRIES_SQL)) as CountryRow[];
        const fuels = (await db.select(FUELS_SQL)) as FuelRow[];

        if (cancelled) return;
        setState({ status: "ready", core: coreRows[0], countries, fuels });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const ready = state.status === "ready";

  const cards: StatItem[] = [
    {
      label: "全球电厂",
      value: ready ? fmtInt(state.core.total_plants) : "—",
      unit: "座",
    },
    {
      label: "总装机容量",
      value: ready ? fmtInt(state.core.total_capacity_mw / 1000) : "—",
      unit: "GW",
    },
    {
      label: "国家/地区",
      value: ready ? fmtInt(state.core.countries) : "—",
      unit: "个",
    },
    {
      label: "燃料类型",
      value: ready ? fmtInt(state.core.fuels) : "—",
      unit: "种",
    },
  ];

  // 国家榜：以**榜首**为基准归一化，让第一名满格、横向对比最直观
  const maxCountryCap = ready
    ? Math.max(...state.countries.map((c) => c.capacity_mw), 1)
    : 1;
  const countryItems: BarItem[] = ready
    ? state.countries.map((c) => ({
        key: c.country,
        label: countryLabel(c.country),
        ratio: c.capacity_mw / maxCountryCap,
        display: `${fmtInt(c.capacity_mw / 1000)} GW · ${fmtInt(c.plants)} 座`,
      }))
    : [];

  // 燃料占比：以**全球总容量**为基准，得到真正的占比
  const totalCap = ready ? state.core.total_capacity_mw || 1 : 1;
  const fuelItems: BarItem[] = ready
    ? state.fuels.map((f) => ({
        key: f.primary_fuel,
        label: fuelLabel(f.primary_fuel),
        ratio: f.capacity_mw / totalCap,
        display: `${((f.capacity_mw / totalCap) * 100).toFixed(1)}%`,
        // 颜色取自与地图上的点、左上角图例**同一份**映射
        color: fuelColor(f.primary_fuel),
      }))
    : [];

  return (
    <div className={styles.page}>
      <h2 className={styles.pageTitle}>{hint}</h2>

      <div className={styles.statGrid}>
        {cards.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </div>

      {state.status === "error" && (
        <p className={styles.stateHint} data-state="error">
          统计数据加载失败：{state.message}
        </p>
      )}
      {ready && state.core.total_plants === 0 && (
        <p className={styles.stateHint}>
          数据库中暂无数据，请先运行 scripts/import_wri_plants.py 导入。
        </p>
      )}

      <div className={styles.chartRow}>
        <section className={styles.chartBox}>
          <h3 className={styles.chartTitle}>装机容量 Top5 国家 / 地区</h3>
          {state.status === "loading" && (
            <p className={styles.stateHint}>正在统计…</p>
          )}
          {ready && <BarChart items={countryItems} />}
        </section>

        <section className={styles.chartBox}>
          <h3 className={styles.chartTitle}>燃料类型占比（按装机容量）</h3>
          {state.status === "loading" && (
            <p className={styles.stateHint}>正在统计…</p>
          )}
          {ready && <BarChart items={fuelItems} />}
        </section>
      </div>
    </div>
  );
}

export default StatsPage;
