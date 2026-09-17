import { useEffect, useState, type RefObject } from "react";
import { getVersion } from "@tauri-apps/api/app";

import AiQueryPanel from "../components/AiQueryPanel";
import DbSelfCheck from "../components/DbSelfCheck";
import GreetSelfCheck from "../components/GreetSelfCheck";
import PackManager from "../components/PackManager";
import type { ConversationTurn, ParsedQuery, PlantFocus, QueryContext } from "../lib/nlq";
import { type Theme, readTheme, setTheme } from "../lib/theme";
import styles from "./SettingsPage.module.css";

/** 主题选项：只影响 UI 令牌与底图配色，**不碰任何数据图层**。 */
const THEME_OPTIONS: ReadonlyArray<readonly [Theme, string]> = [
  ["dark", "深色（默认）"],
  ["light", "浅色"],
];

/**
 * 阶段51：「关于」面板。
 *
 * ‼️ 数据来源这几行不是装饰 —— 它们是 **CC BY 4.0 与 ODbL 的署名义务载体**，
 *    与地图右下角版权区、弹窗里的数据来源行一样不能删。
 * ‼️ 版本号**只从 Tauri 读**（`getVersion()`），不在代码里写死 ——
 *    写死会与安装包名（`Global Power GIS_<version>_x64-setup.exe`）各自漂移。
 *    下面的回退值仅在「不是 Tauri 环境」（如浏览器直接打开）时才会用上，
 *    ⚠️ 改版本时它必须跟着 `tauri.conf.json` 一起改。
 */
function AboutPanel() {
  const [version, setVersion] = useState("0.2.0");

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        /* 非 Tauri 环境（纯浏览器）没有 IPC，保留回退值即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className={styles.panel}>
      <h3 className={styles.aboutTitle}>关于 Global Power GIS</h3>
      <p className={styles.aboutVersion}>v{version} · 全球电力基础设施 GIS 桌面应用</p>

      <table className={styles.aboutTable}>
        <tbody>
          <tr>
            <th>电厂数据</th>
            <td>WRI Global Power Plant Database</td>
            <td>CC BY 4.0</td>
          </tr>
          <tr>
            <th>电厂数据</th>
            <td>Global Energy Monitor（GEM Plants 数据包）</td>
            <td>CC BY 4.0</td>
          </tr>
          <tr>
            <th>电网数据</th>
            <td>OpenStreetMap contributors</td>
            <td>ODbL</td>
          </tr>
          <tr>
            <th>离线底图</th>
            <td>Protomaps（基于 OSM）</td>
            <td>ODbL</td>
          </tr>
          <tr>
            <th>本机推理</th>
            <td>Ollama + Qwen 2.5 7B</td>
            <td>—</td>
          </tr>
          <tr>
            <th>云端 API</th>
            <td>DeepSeek / 通义 / 智谱（可选，需自行填 API Key）</td>
            <td>—</td>
          </tr>
          <tr>
            <th>技术栈</th>
            <td>Tauri 2 · React 19 · TypeScript · Vite · MapLibre GL</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>

      <p className={styles.aboutNote}>
        全部内置数据集均为**开放许可**，界面上的署名不得删除或改写。
      </p>
    </section>
  );
}

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
  /** 发起新查询时，先把地图上的旧高亮清掉 */
  onClearMap?: () => void;
  /** 阶段31：地图视野上下文（透传给 AI 查询面板，用于「当前视野」类问题） */
  viewportRef?: RefObject<QueryContext | null>;
  /** 阶段31：视野移动导致上次结果失效的信号 */
  staleSeq?: number;
  /** 阶段32：点击结果行 → 飞到该电厂并单点高亮 */
  onFocusPlant?: (plant: PlantFocus) => void;
  /** 阶段32：当前被聚焦的电厂（两个表格据此标出同一行） */
  focusedPlant?: PlantFocus | null;
  /** 阶段33：共享的多轮对话记忆 */
  history?: readonly ConversationTurn[];
  onQueryDone?: (turn: ConversationTurn) => void;
}

function SettingsPage({
  hint,
  onViewOnMap,
  onClearMap,
  viewportRef,
  staleSeq,
  onFocusPlant,
  focusedPlant,
  history,
  onQueryDone,
}: SettingsPageProps) {
  /**
   * 阶段51：外观主题。
   * ‼️ 只用原生 `<select>` —— 主题切换本身是**纯 CSS 令牌**的事，
   *    控件长什么样完全不影响它，不值得为此引入任何 UI 库。
   * ⚠️ 初值从 `readTheme()` 取（与 `<html data-theme>` 同源），
   *    不写死 "dark"，否则设置页会与真实主题不一致。
   */
  const [theme, setThemeState] = useState<Theme>(() => readTheme());
  const changeTheme = (next: Theme) => {
    setThemeState(next);
    setTheme(next); // 持久化 + 写 data-theme + 广播给地图重着色
  };

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

      {/* 阶段51：外观主题。把它放在静态占位选项**之前** —— 它是本页第一个真正生效的设置，
          而下面那三组仍是 disabled 占位，先可用后占位才符合阅读顺序。 */}
      <section className={styles.panel}>
        <div className={styles.settingRow}>
          <label className={styles.settingLabel} htmlFor="appearance-theme">
            外观主题
          </label>
          <select
            id="appearance-theme"
            className={styles.settingSelect}
            value={theme}
            onChange={(e) => changeTheme(e.target.value === "light" ? "light" : "dark")}
          >
            {THEME_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* 阶段44：区域数据包下载 / 断点续传 / SHA256 校验。
          单独成组件：它有独立的状态机（未下载/下载中/已下载/失败），
          与上面那几组静态占位选项不是一回事。 */}
      <PackManager />

      <GreetSelfCheck />

      <DbSelfCheck />

      {/* 阶段51：关于 / 数据来源与许可。按用户要求放在设置页底部。 */}
      <AboutPanel />

      {/* 阶段17：本地规则引擎的自然语言查询（尚未接入真实大模型 API） */}
      <AiQueryPanel
        onViewOnMap={onViewOnMap}
        onClearMap={onClearMap}
        viewportRef={viewportRef}
        staleSeq={staleSeq}
        onFocusPlant={onFocusPlant}
        focusedPlant={focusedPlant}
        history={history}
        onQueryDone={onQueryDone}
      />
    </div>
  );
}

export default SettingsPage;
