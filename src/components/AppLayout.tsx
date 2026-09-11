import { useState } from "react";
import Sidebar, { MENU_ITEMS, type MenuKey } from "./Sidebar";
import TopBar from "./TopBar";
import MapPage from "../pages/MapPage";
import StatsPage from "../pages/StatsPage";
import SettingsPage from "../pages/SettingsPage";
import styles from "./AppLayout.module.css";

const APP_TITLE = "Global Power GIS";

/** 按当前菜单项渲染内容区；三个页面各自管理留白与内容 */
function renderContent(key: MenuKey, hint: string) {
  switch (key) {
    case "map":
      return <MapPage />;

    case "stats":
      return <StatsPage hint={hint} />;

    case "settings":
      return <SettingsPage hint={hint} />;

    default:
      return null;
  }
}

function AppLayout() {
  const [activeKey, setActiveKey] = useState<MenuKey>("map");

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
          {renderContent(activeKey, activeItem.hint)}
        </section>
      </div>
    </div>
  );
}

export default AppLayout;
