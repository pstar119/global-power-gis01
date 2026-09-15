-- ============================================================================
-- 阶段46：补回 WRI 数据集里**本来就有、但我们一直没导入**的元数据字段
-- ============================================================================
--
-- 背景（这是本次改造最有价值的一条结论）：
--   WRI Global Power Plant Database v1.3.0 的 CSV 实测有 **36 列**，
--   而 import_wri_plants.py 的 COLUMNS 只取了 7 列 ——
--   `commissioning_year` / `owner` / `source` / `url` 被**静默丢弃**。
--   所以「弹窗里没有投产年份和所有者」并不是数据源能力不足，
--   而是我们自己的导入管道把字段扔掉了（不需要引入任何新数据源）。
--
-- commissioning_year : 投产年份（整数）。上游是脏数据：有空串，也有 "1985.0"
--                      这种浮点写法，解析失败一律写 NULL 而不是 0 ——
--                      0 会被误读成「公元 0 年」，而 NULL 在 UI 上显示为 "--"。
-- owner              : 电站所有者 / 运营方（自由文本，上游未规范化）。
-- source             : 该条记录的原始出处（WRI 的溯源字段）。
-- url                : 该条记录的来源链接。
--
-- ⚠️ 与 002 一样用 ALTER TABLE ADD COLUMN 而非重建表：
--    SQLite 的 ADD COLUMN 是纯元数据操作，不重写任何已有行，
--    对现有 3.5 万条电厂记录完全安全，也不需要停机迁移。
ALTER TABLE power_plants ADD COLUMN commissioning_year INTEGER;
ALTER TABLE power_plants ADD COLUMN owner TEXT;
ALTER TABLE power_plants ADD COLUMN source TEXT;
ALTER TABLE power_plants ADD COLUMN url TEXT;
