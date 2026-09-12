import AiQueryPanel from "../components/AiQueryPanel";
import DbSelfCheck from "../components/DbSelfCheck";
import GreetSelfCheck from "../components/GreetSelfCheck";
import type { ParsedQuery } from "../lib/nlq";
import styles from "./SettingsPage.module.css";

interface SettingGroup {
  id: string;
  label: string;
  options: readonly string[];
}

/** 系统设置骨架：全部为禁用占位，仅展示规划，不含任何真实配置或数据 */
const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: "data-source",
    label: "数据源设置",
    options: ["本地离线数据库（待接入）", "在线 API（未配置）"],
  },
  {
    id: "map-engine",
    label: "地图引擎设置",
    options: ["PMTiles（推荐）", "MapLibre（未安装）"],
  },
  {
    id: "ai-model",
    label: "AI 模型设置",
    options: ["Qwen（未接入）", "DeepSeek（未接入）", "GLM（未接入）"],
  },
];

interface SettingsPageProps {
  /** 页面标题（来自侧边栏菜单定义，保持单一数据源） */
  hint: string;
  /** 「在地图上查看」：把查询意图交给地图页（带 id 的指令由 AppLayout 生成） */
  onViewOnMap?: (query: ParsedQuery) => void;
}

function SettingsPage({ hint, onViewOnMap }: SettingsPageProps) {
  return (
    <div className={styles.page}>
      <h2 className={styles.pageTitle}>{hint}</h2>

      <div className={styles.panel}>
        {SETTING_GROUPS.map((group) => (
          <div key={group.id} className={styles.settingRow}>
            <label className={styles.settingLabel} htmlFor={group.id}>
              {group.label}
            </label>

            {/* 静态占位：用 defaultValue 而非 value，避免 React 的
                "value without onChange" 警告 */}
            <select
              id={group.id}
              className={styles.settingSelect}
              defaultValue={group.options[0]}
              disabled
            >
              {group.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <GreetSelfCheck />

      <DbSelfCheck />

      {/* 阶段17：本地规则引擎的自然语言查询（尚未接入真实大模型 API） */}
      <AiQueryPanel onViewOnMap={onViewOnMap} />
    </div>
  );
}

export default SettingsPage;
