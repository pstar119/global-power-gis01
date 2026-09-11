import styles from "./AppLayout.module.css";

interface TopBarProps {
  title: string;
}

function TopBar({ title }: TopBarProps) {
  return (
    <header className={styles.topbar}>
      <span className={styles.topbarTitle}>{title}</span>
    </header>
  );
}

export default TopBar;
