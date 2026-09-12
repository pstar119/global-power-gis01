import { useRef, useState } from "react";
import Sidebar, { MENU_ITEMS, type MenuKey } from "./Sidebar";
import TopBar from "./TopBar";
import MapPage from "../pages/MapPage";
import StatsPage from "../pages/StatsPage";
import SettingsPage from "../pages/SettingsPage";
import type { MapCommand, ParsedQuery } from "../lib/nlq";
import styles from "./AppLayout.module.css";

const APP_TITLE = "Global Power GIS";

/** 取某个菜单项固定的 hint（页面标题），与当前激活项无关 */
const hintOf = (key: MenuKey) =>
  MENU_ITEMS.find((item) => item.key === key)?.hint ?? "";

function AppLayout() {
  const [activeKey, setActiveKey] = useState<MenuKey>("map");

  /**
   * 跨页面向地图下达的指令。
   *
   * ⚠️ 刻意只用 useState 提升到这里，不引入 Zustand 等状态库：
   *    跨页数据只有「一个可选命令」这一种，为它加一层依赖不划算。
   * ⚠️ id 自增：MapPage 靠它去重，避免同一个命令被重复执行。
   */
  const [mapCommand, setMapCommand] = useState<MapCommand | null>(null);
  const commandSeq = useRef(0);

  const handleViewOnMap = (query: ParsedQuery) => {
    commandSeq.current += 1;
    setMapCommand({ ...query, id: commandSeq.current });
    setActiveKey("map");
  };

  /**
   * 只清空地图高亮，不切页、不动视角。
   *
   * ⚠️ intent 在这里是必填字段但**不会被使用** —— MapPage 的 applyCommand
   *    看到 clearOnly 就会提前 return。填 global_stats 只是为满足类型。
   */
  const handleClearMap = () => {
    commandSeq.current += 1;
    setMapCommand({
      intent: "global_stats",
      id: commandSeq.current,
      clearOnly: true,
    });
  };

  const activeItem =
    MENU_ITEMS.find((item) => item.key === activeKey) ?? MENU_ITEMS[0];

  return (
    <div className={styles.shell}>
      <Sidebar
        items={MENU_ITEMS}
        activeKey={activeKey}
        onSelect={setActiveKey}
      />

      <div className={styles.main}>
        <TopBar title={APP_TITLE} />

        <section className={styles.content} aria-label={activeItem.label}>
          {/* ⚠️ 三个页面**同时挂载**，只切换可见性而非卸载。
              这样 MapLibre 实例、3.5 万个点与聚合索引只创建一次，
              切页不再重建 —— 既让「在地图上查看」能瞬间响应，
              也避免了反复 create/destroy 地图带来的泄漏风险。
              代价是三页常驻内存，而地图那部分本来就只占一份，增量很小。 */}
          <div className={styles.pageSlot} hidden={activeKey !== "map"}>
            <MapPage command={mapCommand} />
          </div>

          <div className={styles.pageSlot} hidden={activeKey !== "stats"}>
            <StatsPage hint={hintOf("stats")} />
          </div>

          <div className={styles.pageSlot} hidden={activeKey !== "settings"}>
            <SettingsPage
              hint={hintOf("settings")}
              onViewOnMap={handleViewOnMap}
              onClearMap={handleClearMap}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

export default AppLayout;
