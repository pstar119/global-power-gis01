/**
 * 阶段46 · UI 静态原型：左侧「数据看板」。
 *
 * 定位：把左上角从**纯图层面板**升级为**数据看板** —— 用户打开应用先看到
 * 「有多少、装了多少」，再决定开哪些图层，而不是面对一排裸开关。
 * 视觉层级参考 OpenInfraMap 的侧栏（总量 → 分类 → 分级图例）。
 *
 * ⚠️ 这是**静态原型**，刻意的取舍：
 *   · 数字是**写死**的常量（取自 WRI GPPD v1.3.0 的真实离线快照，
 *     不是随手编的假数），**不跟随视野移动、不跟随图层开关**。
 *   · 为什么不一步到位接真数据：布局要先被确认。若先接数据，一旦视觉要改，
 *     改动会横跨 SQL、状态管理与样式三处，返工成本远高于先定布局。
 *   · 页面上有明确的「静态原型」徽标与脚注，**避免被误认为已完成的功能**。
 *
 * ⚠️ 零新增依赖：没有图表库、没有 d3、没有 CSS-in-JS。
 *    条形图都刻意没做 —— 一排数字 + 色块已经足够，且与地图图例天然呼应。
 */
import { useState } from "react";

import { fuelColor, fuelLabel } from "../lib/fuel";
import styles from "./StatsDashboard.module.css";

type FuelStat = {
  /** WRI 的 primary_fuel 取值，用于取中文名与配色 */
  fuel: string;
  count: number;
  capacityMw: number;
};

/**
 * 按能源类型的聚合 —— 真实数据，来自 WRI GPPD v1.3.0。
 *
 * 口径说明（比数字本身更重要）：
 *   · count      = 电站**座数**（34,936 条记录，实测零重复 ID）
 *   · capacityMw = 该类型的装机容量**求和**，单位 MW
 *   · 容量为空的记录**不计入求和**（也不当成 0）——
 *     当成 0 会让「总装机」系统性偏小，且没有任何迹象可循。
 *     界面上对应显示 "--"，与用户的约定一致。
 *   · 因此各分类容量之和 = 总量，但各分类座数之和也 = 总座数（座数不受该规则影响）
 */
const PLACEHOLDER_FUELS: readonly FuelStat[] = [
  { fuel: "Coal", count: 2330, capacityMw: 1965541.0 },
  { fuel: "Gas", count: 3998, capacityMw: 1493050.6 },
  { fuel: "Hydro", count: 7156, capacityMw: 1053159.6 },
  { fuel: "Nuclear", count: 195, capacityMw: 407911.8 },
  { fuel: "Wind", count: 5344, capacityMw: 263053.7 },
  { fuel: "Oil", count: 2320, capacityMw: 261878.7 },
  { fuel: "Solar", count: 10665, capacityMw: 188312.3 },
  { fuel: "Biomass", count: 1430, capacityMw: 34281.3 },
  { fuel: "Waste", count: 1068, capacityMw: 14748.7 },
  { fuel: "Geothermal", count: 189, capacityMw: 12687.8 },
  { fuel: "Cogeneration", count: 41, capacityMw: 4048.0 },
  { fuel: "Other", count: 43, capacityMw: 3612.9 },
  { fuel: "Petcoke", count: 12, capacityMw: 2424.6 },
  { fuel: "Storage", count: 135, capacityMw: 1712.3 },
  { fuel: "Wave and Tidal", count: 10, capacityMw: 552.2 },
];

const PLACEHOLDER_TOTAL_COUNT = 34936;
const PLACEHOLDER_TOTAL_CAPACITY_MW = 5706975.4;

/**
 * 折叠时展示的行数。
 * 按容量降序取前 6 类 ≈ 95% 的装机 —— 真正需要「展开」的是长尾。
 */
const COLLAPSED_ROWS = 6;

/**
 * 容量分级（与地图上电厂点的 circle-radius 分级**严格一致**）。
 *
 * ⚠️ 这四档不是随手定的：它们直接对应 MapPage 里 PLANT_LAYER_ID 的
 *    `["step", ["get","capacity"], 1.2, 100, 2, 500, 3, 1000, 4.5]`。
 *    图例与地图共用同一套断点，改一处必须同时改另一处 ——
 *    否则图例会变成「说一套、画一套」，比没有图例更糟。
 */
const SIZE_TIERS: ReadonlyArray<{ label: string; dot: string }> = [
  { label: "≥ 1000 MW", dot: "xl" },
  { label: "500 ~ 999 MW", dot: "lg" },
  { label: "100 ~ 499 MW", dot: "md" },
  { label: "< 100 MW", dot: "sm" },
];

/** 数量：带千分位。`toLocaleString` 是内置能力，不是依赖。 */
function formatCount(n: number): string {
  return n.toLocaleString("zh-CN");
}

/**
 * 容量：MW → GW，固定一位小数。
 * 为什么用 GW：全球总量是 570 万 MW，用 MW 会变成 7 位数字，一眼读不出量级。
 */
function formatGw(mw: number): string {
  return `${(mw / 1000).toLocaleString("zh-CN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GW`;
}

export default function StatsDashboard() {
  /**
   * 阶段47：看板整体的展开 / 折叠。**默认折叠**。
   *
   * ‼️ 为什么必须有它（实测数据，不是拍脑袋）：
   *    看板 + 图层控制 + 图例展开后内容高达 **1169px**，而 `.layerPanel` 的
   *    `max-height: calc(100% - 140px)` 在 1280×800 下只有 **609px**
   *    —— 展开态必然出现长滚动条，把地图主视觉挤掉。
   *
   * ‼️ 为什么默认是**折叠**而不是展开：
   *    用户的要求是「不要让面板内部出现长滚动条，让用户能一眼看到地图的主视觉」。
   *    实测折叠态内容 645px、可视 609px，只差 36px（基本可忽略）；
   *    而展开态溢出 560px，那是坐实的「长滚动条」。
   *    想看明细点一下标题行就行，代价为 1 次点击；
   *    但地图被面板埋掉是每时每刻的代价。
   *    （若日后想改回「默认展开」，只需把下面的 false 改成 true。）
   */
  const [open, setOpen] = useState(false);

  /** 能源明细是否展开到全部 15 类（默认只显示最常用的 6 类） */
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? PLACEHOLDER_FUELS
    : PLACEHOLDER_FUELS.slice(0, COLLAPSED_ROWS);

  return (
    <section className={styles.dashboard} aria-label="数据看板（静态原型）">
      {/*
        ⚠️ 折叠开关做成**整个标题行**，而不是一个小三角图标：
           用户要的是「一键折叠」，可点击面积越大越好；
           同时这也更规范 —— 一个带 aria-expanded 的 button，
           比在 <span> 上挂 onClick 在无障碍上正当得多。
      */}
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        aria-controls="stats-dashboard-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.title}>数据看板</span>
        <span className={styles.headerRight}>
          <span
            className={styles.badge}
            title="数字为写死的离线快照，尚未接入实时统计"
          >
            静态原型
          </span>
          <span className={styles.chevron} aria-hidden="true">
            {open ? "▼" : "▶"}
          </span>
        </span>
      </button>

      <div id="stats-dashboard-body" className={styles.body} hidden={!open}>
        {/* 总量：先给量级，再给细分 —— 这是看板与「一排开关」的根本差别 */}
        <dl className={styles.totals}>
          <div className={styles.totalRow}>
            <dt className={styles.totalLabel}>全球电厂</dt>
            <dd className={styles.totalValue}>
              {formatCount(PLACEHOLDER_TOTAL_COUNT)}
              <span className={styles.unit}>座</span>
            </dd>
          </div>
          <div className={styles.totalRow}>
            <dt className={styles.totalLabel}>总装机容量</dt>
            <dd className={styles.totalValue}>
              {formatGw(PLACEHOLDER_TOTAL_CAPACITY_MW)}
            </dd>
          </div>
        </dl>

        <p className={styles.subtitle}>按能源类型</p>
        <ul className={styles.fuelList}>
          {visible.map((row) => (
            <li key={row.fuel} className={styles.fuelRow}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: fuelColor(row.fuel) }}
                aria-hidden="true"
              />
              <span className={styles.fuelName}>{fuelLabel(row.fuel)}</span>
              <span className={styles.fuelCount}>{formatCount(row.count)}</span>
              <span className={styles.fuelCap}>{formatGw(row.capacityMw)}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className={styles.moreBtn}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部 ${PLACEHOLDER_FUELS.length} 类`}
        </button>

        <p className={styles.subtitle}>气泡大小（装机容量）</p>
        <ul className={styles.sizeLegend}>
          {SIZE_TIERS.map((tier) => (
            <li key={tier.dot} className={styles.sizeItem}>
              <i className={styles.dot} data-size={tier.dot} aria-hidden="true" />
              {tier.label}
            </li>
          ))}
        </ul>

        <p className={styles.footNote}>
          容量缺失的记录显示为 <b>--</b>，且<b>不计入</b>合计 —— 按 0 计入会让总装机系统性偏小。
        </p>

        <p className={styles.protoNote}>
          原型说明：数字取自 WRI GPPD v1.3.0 离线快照，
          <b>尚未跟随视野与图层开关实时变化</b>。
        </p>
      </div>
    </section>
  );
}
