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
  { key: "map", label: "地图", hint: "地图页面（待开发，目前处于第二阶段）" },
  { key: "stats", label: "统计", hint: "统计页面（待开发，目前处于第二阶段）" },
  { key: "settings", label: "设置", hint: "设置页面（待开发，目前处于第二阶段）" },
];

interface SidebarProps {
  items: readonly MenuItem[];
  activeKey: MenuKey;
  onSelect: (key: MenuKey) => void;
}

function Sidebar({ items, activeKey, onSelect }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="主导航">
      <ul className={styles.menu}>
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
