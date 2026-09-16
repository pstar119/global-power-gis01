-- 阶段48-A：GEM 煤炭数据（Global Energy Monitor，CC BY 4.0）
--
-- ‼️ 为什么新建一张表而不是并进 power_plants：
--    两者**粒度不同**。power_plants 是 WRI 的**电站级**记录（一厂一行），
--    而 GEM 的 GCPT 是**机组级**（一台机组一行，同一电站多行）。
--    混进一张表就必须加「粒度」判别列，之后每条查询都要带着它，
--    迟早会有人漏 —— 而漏了的后果是容量被重复求和。
--    分开存，粒度就是表名自带的语义，不会搞错。
--
-- ‼️ 为什么存机组级而不是先聚合好：
--    聚合会**永久丢掉**机组明细（机组数、最大机组、单机退役年份）。
--    聚合放在**读取时**做（GROUP BY location_id），既拿到了电站级视图，
--    又保留了将来「按机组查退役年份」的可能。与 WRI 那条
--    `GROUP BY primary_fuel` 的视野统计是同一套思路。
--
-- 数据来源与许可（CC BY 4.0 要求署名，**这段必须保留**）：
--   © Global Energy Monitor. Global Coal Plant Tracker, January 2026 release.
--   Distributed under a Creative Commons Attribution 4.0 International License.
--   抓取自 https://api.globalenergymonitor.org/ （无鉴权公开接口）
--
-- ⚠️ 本表**只由 `scripts/import_gem_coal.py` 写入**，前端只读不写
--    （capabilities 里没有 `sql:allow-execute`，物理上写不了库）。

CREATE TABLE IF NOT EXISTS gem_coal_plants (
  -- GEM 的资产 ID，形如 L100000103878_G100000100001（= location_id + "_" + unit_id）
  unit_id          TEXT PRIMARY KEY,
  -- GEM 的电站 ID，形如 L100000103878。**聚合就按这一列分组**。
  location_id      TEXT NOT NULL,
  unit_name        TEXT,
  station_name     TEXT,
  country          TEXT,
  state_province   TEXT,
  capacity_mw      REAL,
  -- 实测只有 4 个取值：operating / retired / cancelled / planned
  status           TEXT,
  sub_status       TEXT,
  latitude         REAL,
  longitude        REAL,
  -- 首个所有者（实测 99.7% 的电站有值）；完整份额明细不落库，只取首页主
  owner            TEXT,
  owner_share      REAL,
  wiki_url         TEXT,
  -- 抓取时间（ISO8601）。用于在界面上说清「这是哪一版快照」，
  -- 也是 CC BY 署名里 "August 2026 release" 这类信息的落点。
  fetched_at       TEXT
);

-- 聚合查询（GROUP BY location_id）与按状态过滤都走这条
CREATE INDEX IF NOT EXISTS idx_gem_coal_location ON gem_coal_plants (location_id, status);

-- 展示用：按坐标范围筛选时用得上（与 power_plants 的 v5/v7 索引同思路）
CREATE INDEX IF NOT EXISTS idx_gem_coal_lat_lon ON gem_coal_plants (latitude, longitude);
