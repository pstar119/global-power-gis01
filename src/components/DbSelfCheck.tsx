import { useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import styles from "./DbSelfCheck.module.css";

/** 必须与 src-tauri/src/lib.rs 里的 DB_URL 一致 */
const DB_URL = "sqlite:global_power_gis.db";

const TABLES = ["power_plants", "substations", "transmission_lines"] as const;
type TableName = (typeof TABLES)[number];

/** 查询返回的一行：三张表各自的记录数 + 非测试数据计数 */
type CountRow = Record<TableName, number> & { non_test: number };

/**
 * 一次往返拿回三张表的记录数，外加一个 `non_test` 计数。
 *
 * `non_test` 是**红线守卫**：统计所有名字不以 `Test` 开头的记录。
 * 本阶段允许存在阶段13 播种的 Test 测试数据，但绝不允许出现真实电力数据，
 * 所以判定标准从"表必须为空"升级为"记录必须全部带 Test 标记"。
 * TODO: 接入真实数据后，本守卫要连同播种逻辑一起改造。
 */
const COUNT_SQL = `SELECT
  (SELECT COUNT(*) FROM power_plants)       AS power_plants,
  (SELECT COUNT(*) FROM substations)        AS substations,
  (SELECT COUNT(*) FROM transmission_lines) AS transmission_lines,
  (SELECT COUNT(*) FROM power_plants       WHERE name NOT LIKE 'Test%')
+ (SELECT COUNT(*) FROM substations        WHERE name NOT LIKE 'Test%')
+ (SELECT COUNT(*) FROM transmission_lines WHERE name NOT LIKE 'Test%') AS non_test`;

const IDLE_MESSAGE = "点击按钮连接本地 SQLite 数据库，统计三张表的记录数。";

/**
 * 本地数据库连通性自检。
 *
 * `Database.load()` / `db.select()` 本身就是走 Tauri IPC 调用 Rust 侧的
 * `plugin:sql|load` / `plugin:sql|select` 命令，所以不需要另外手写
 * `#[tauri::command]`，也就不必在 Rust 侧再开一个连接池去连同一个文件。
 */
function DbSelfCheck() {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<boolean | null>(null);
  const [message, setMessage] = useState(IDLE_MESSAGE);

  const run = async () => {
    setBusy(true);
    setOk(null);
    setMessage("正在查询…");

    try {
      const db = await Database.load(DB_URL);
      const rows = (await db.select(COUNT_SQL)) as CountRow[];
      const counts = rows[0];
      const total = TABLES.reduce((sum, t) => sum + Number(counts?.[t] ?? 0), 0);
      const nonTest = Number(counts?.non_test ?? 0);

      if (nonTest > 0) {
        // 红线守卫：出现了不带 Test 标记的记录，说明混入了非测试数据
        setOk(false);
        setMessage(
          `⚠️ 检测到 ${nonTest} 条非测试数据 —— 违反「不得写入真实电力数据」的红线`,
        );
      } else if (total === 0) {
        setOk(true);
        setMessage(
          `数据库已就绪，当前有 0 条记录（${TABLES.map((t) => `${t} 0`).join(" / ")}）`,
        );
      } else {
        setOk(true);
        setMessage(
          `数据库已就绪，当前有 ${total} 条记录（全部为 Test 标记的测试数据）`,
        );
      }
    } catch (err) {
      setOk(false);
      setMessage(
        `数据库自检失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>本地数据库连通性自检</h2>
      <p className={styles.hint}>
        通过 <code>@tauri-apps/plugin-sql</code> 连接 <code>global_power_gis.db</code>
        ，统计三张表的记录数，并校验记录是否全部带 Test 标记。
      </p>

      <button
        type="button"
        className={styles.button}
        onClick={run}
        disabled={busy}
      >
        {busy ? "查询中…" : "测试数据库连接"}
      </button>

      <p
        className={styles.result}
        data-state={ok === null ? "idle" : ok ? "ok" : "error"}
      >
        {message}
      </p>
    </section>
  );
}

export default DbSelfCheck;
