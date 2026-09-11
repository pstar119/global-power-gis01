import { useState } from "react";
import Sidebar, { MENU_ITEMS, type MenuKey } from "./Sidebar";
import TopBar from "./TopBar";
import GreetSelfCheck from "./GreetSelfCheck";
import MapPage from "../pages/MapPage";
import StatsPage from "../pages/StatsPage";
import styles from "./AppLayout.module.css";

const APP_TITLE = "Global Power GIS";

/** 按当前菜单项渲染内容区：地图页全出血，统计/设置页自带留白 */
function renderContent(key: MenuKey, hint: string) {
  switch (key) {
    case "map":
      return <MapPage hint={hint} />;

    case "stats":
      return <StatsPage />;

    case "settings":
      return (
        <div className={styles.padded}>
          <p className={styles.placeholder}>{hint}</p>
          <GreetSelfCheck />
        </div>
      );

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
