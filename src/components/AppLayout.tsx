import { useState } from "react";
import Sidebar, { MENU_ITEMS, type MenuKey } from "./Sidebar";
import TopBar from "./TopBar";
import GreetSelfCheck from "./GreetSelfCheck";
import styles from "./AppLayout.module.css";

const APP_TITLE = "Global Power GIS";

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
          <p className={styles.placeholder}>{activeItem.hint}</p>

          {activeKey === "settings" && <GreetSelfCheck />}
        </section>
      </div>
    </div>
  );
}

export default AppLayout;
