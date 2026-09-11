import styles from "./StatsPage.module.css";

interface StatItem {
  label: string;
  value: string;
  unit: string;
}

/** 全局统计骨架：数值一律为 0，不含任何真实电力数据 */
const STATS: readonly StatItem[] = [
  { label: "全球电厂", value: "0", unit: "座" },
  { label: "变电站", value: "0", unit: "座" },
  { label: "输电线路", value: "0", unit: "km" },
  { label: "国家/地区", value: "0", unit: "个" },
];

/** 图表占位：纯 CSS 虚线框，不引入任何图表库 */
const CHARTS = [
  { key: "primary", label: "图表渲染区域（待接入数据）" },
  { key: "secondary", label: "图表渲染区域（待接入数据）" },
] as const;

interface StatsPageProps {
  /** 页面标题（来自侧边栏菜单定义，保持单一数据源） */
  hint: string;
}

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

function StatsPage({ hint }: StatsPageProps) {
  return (
    <div className={styles.page}>
      <h2 className={styles.pageTitle}>{hint}</h2>

      <div className={styles.statGrid}>
        {STATS.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </div>

      <div className={styles.chartRow}>
        {CHARTS.map((chart) => (
          <div key={chart.key} className={styles.chartBox}>
            {chart.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export default StatsPage;
