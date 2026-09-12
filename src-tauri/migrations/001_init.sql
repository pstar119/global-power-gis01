-- ============================================================
-- 阶段12 初始化脚本：建立三张空表
--
-- ⚠️ 红线：本文件**只创建表结构，绝不插入任何数据**。
--    执行后三张表的 COUNT(*) 必须全部为 0。
--
-- 由 src-tauri/src/lib.rs 通过 include_str! 载入，
-- 交给 tauri-plugin-sql 的迁移机制执行（在事务里，可安全重复运行）。
-- ============================================================

CREATE TABLE IF NOT EXISTS power_plants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  country     TEXT,
  capacity_mw REAL,
  lat         REAL,
  lon         REAL
);

CREATE TABLE IF NOT EXISTS substations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  country    TEXT,
  voltage_kv REAL,
  lat        REAL,
  lon        REAL
);

CREATE TABLE IF NOT EXISTS transmission_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  voltage_kv REAL,
  start_lat  REAL,
  start_lon  REAL,
  end_lat    REAL,
  end_lon    REAL
);
