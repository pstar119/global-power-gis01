-- ============================================================================
-- 阶段14：接入真实数据源（WRI Global Power Plant Database）所需的两个字段
-- ============================================================================

-- gppd_idnr    : WRI 数据集里的稳定唯一编号（实测 34,936 条**零重复**）。
--                它是后续数据更新、去重，以及与地图要素建立对应关系的核心依据。
-- primary_fuel : 燃料类型（Solar / Hydro / Wind / Gas / Coal / ...）。
--                用于地图按能源类型着色，是数据的天然分类维度。
--
-- ⚠️ 用 ALTER TABLE ADD COLUMN 而非重建表：SQLite 的 ADD COLUMN 是纯元数据操作，
--    不重写任何已有数据，因此对现有记录完全安全。
ALTER TABLE power_plants ADD COLUMN gppd_idnr TEXT;
ALTER TABLE power_plants ADD COLUMN primary_fuel TEXT;

-- gppd_idnr 必须唯一。
-- ⚠️ SQLite 的 ALTER TABLE **不支持**直接添加 UNIQUE 约束，所以改用唯一索引。
--    唯一索引恰好还有一个必要特性：它允许 NULL 重复（SQLite 的规定），
--    因此在数据尚未导入、该列全为 NULL 时也能安全建立。
--    同时它让「按 ID 查找 / 更新」这一最常用的操作走索引而不是全表扫描。
CREATE UNIQUE INDEX IF NOT EXISTS idx_power_plants_gppd_idnr
  ON power_plants (gppd_idnr);
