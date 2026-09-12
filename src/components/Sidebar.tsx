import { useState } from "react";
import styles from "./AppLayout.module.css";

export type MenuKey = "map" | "stats" | "settings";

export interface MenuItem {
  key: MenuKey;
  label: string;
  hint: string;
}

/**
 * 侧边栏菜单定义。
 * 第二阶段只有空白占位页，不含任何业务数据。
 */
export const MENU_ITEMS: readonly MenuItem[] = [
  { key: "map", label: "地图", hint: "地图视窗（待开发，下一阶段接入 PMTiles 引擎）" },
  { key: "stats", label: "统计", hint: "全球电力设施统计" },
  { key: "settings", label: "设置", hint: "系统设置（规划中）" },
];

interface SidebarProps {
  items: readonly MenuItem[];
  activeKey: MenuKey;
  onSelect: (key: MenuKey) => void;
}

function Sidebar({ items, activeKey, onSelect }: SidebarProps) {
  // 折叠状态只属于侧边栏自身：不需要提升到 AppLayout，也就不需要任何全局状态库
  const [collapsed, setCollapsed] = useState(false);

  return (
    <nav
      className={
        collapsed ? `${styles.sidebar} ${styles.sidebarCollapsed}` : styles.sidebar
      }
      aria-label="主导航"
    >
      <button
        type="button"
        className={styles.sidebarToggle}
        aria-expanded={!collapsed}
        aria-controls="app-main-menu"
        aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
        onClick={() => setCollapsed((prev) => !prev)}
      >
        {collapsed ? "›" : "‹"}
      </button>

      <ul id="app-main-menu" className={styles.menu}>
        {items.map((item) => {
          const isActive = item.key === activeKey;

          return (
            <li key={item.key}>
              <button
                type="button"
                className={
                  isActive
                    ? `${styles.menuItem} ${styles.menuItemActive}`
                    : styles.menuItem
                }
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelect(item.key)}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default Sidebar;
