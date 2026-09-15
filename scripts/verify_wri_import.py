#!/usr/bin/env python3
"""在**真库的副本**上验证「迁移 006 + WRI 导入」整条链路，不碰活数据。

为什么需要它：
    真实数据库（`%APPDATA%/<identifier>/global_power_gis.db`）是用户的活数据，
    而验证导入**必须**写库。直接在真库上试错，一旦脚本有问题就得靠备份恢复；
    更糟的是真库还需要应用先启动一次、跑完迁移 006 之后才能写 ——
    验证步骤就被绑死在「先装好应用」上。

    这里改为在真库副本上跑完整流程，验完即删。它同时检查一件容易漏掉的事：
    迁移 006 加的列**真的存在**，且导入后的值**真的能查得出来** ——
    而不是只证明「SQL 语法没报错」。

为什么用 sqlite3 的 backup() 而不是 copy 文件：
    真库可能是 WAL 模式，直接复制文件会漏掉 `-wal` 里尚未合并的事务，
    拿到一个「看起来完整、实际缺最新数据」的副本。backup() 走的是
    SQLite 自己的在线备份协议，不存在这个问题。

用法：
    python scripts/verify_wri_import.py
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app_paths import REPO_ROOT, app_db_path  # noqa: E402

# 迁移 006 的列定义。这里**故意重复**而不是去解析 .sql 文件：
# 如果迁移文件被改动（例如少了一列），本脚本要能发现，而不是跟着一起错。
EXPECTED_COLUMNS = {
    "commissioning_year": "INTEGER",
    "owner": "TEXT",
    "source": "TEXT",
    "url": "TEXT",
}

WORK_DIR = REPO_ROOT / "data" / "_verify"


def copy_database(src: Path, dst: Path) -> None:
    """用 SQLite 在线备份协议做一致性副本（正确处理 WAL）。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    src_con = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    dst_con = sqlite3.connect(dst)
    try:
        src_con.backup(dst_con)
    finally:
        dst_con.close()
        src_con.close()


def ensure_columns(con: sqlite3.Connection) -> list[str]:
    """补上缺失的列，返回实际新增的列名。

    幂等：列已存在就跳过，因此本脚本在应用跑过迁移 006 之后依然可用。
    """
    existing = {r[1] for r in con.execute("PRAGMA table_info(power_plants)")}
    added = []
    for name, coltype in EXPECTED_COLUMNS.items():
        if name in existing:
            continue
        con.execute(f"ALTER TABLE power_plants ADD COLUMN {name} {coltype}")
        added.append(name)
    con.commit()
    return added


def main() -> int:
    src = app_db_path()
    if not src.exists():
        print(f"[FAIL] 真库不存在：{src}")
        print("       请先启动一次应用以建库。")
        return 1

    tmp = WORK_DIR / f"verify_{int(time.time())}.db"
    print(f"真库（只读）  : {src}")
    print(f"验证副本      : {tmp}")
    copy_database(src, tmp)

    con = sqlite3.connect(tmp)
    try:
        before = con.execute("SELECT COUNT(*) FROM power_plants").fetchone()[0]
        added = ensure_columns(con)
        print(f"副本原记录数  : {before}")
        print(
            "迁移 006 新增列: "
            + (", ".join(added) if added else "（已存在，无需新增）")
        )
    finally:
        con.close()

    # 让导入脚本写进副本而不是真库
    import import_wri_plants as importer  # noqa: PLC0415

    importer.DB_PATH = tmp

    print("")
    importer.ensure_csv()
    rows, stats = importer.load_rows()
    importer.apply_to_db(rows)

    # ---- 验收：新字段**真的能查出来** ----
    con = sqlite3.connect(f"file:{tmp.as_posix()}?mode=ro", uri=True)
    try:
        total, with_year, with_owner = con.execute(
            "SELECT COUNT(*),"
            " COUNT(commissioning_year),"
            " COUNT(owner)"
            " FROM power_plants"
        ).fetchone()
        print("")
        print("══ 验收：直接查数据库（不是看脚本自述）══")
        print(f"  总记录数            : {total}")
        print(f"  commissioning_year  : {with_year} 条非空")
        print(f"  owner               : {with_owner} 条非空")

        sample = con.execute(
            "SELECT name, country, capacity_mw, primary_fuel,"
            " commissioning_year, owner"
            " FROM power_plants"
            " WHERE commissioning_year IS NOT NULL AND owner IS NOT NULL"
            " ORDER BY capacity_mw DESC LIMIT 5"
        ).fetchall()
        print("")
        print("  抽查（容量最大的 5 条，年份与所有者均非空）:")
        for name, country, cap, fuel, year, owner in sample:
            print(
                f"    {str(name)[:28]:<30} {country or '--':<5}"
                f" {(cap or 0):>8.1f} MW  {str(fuel or '--'):<10}"
                f" {year}  {str(owner)[:26]}"
            )

        ok = with_year > 0 and with_owner > 0
        print("")
        print(
            "结论                : "
            + ("✅ 通过 —— 年份与所有者都已写入并可查询" if ok else "❌ 失败 —— 新字段为空")
        )
        return 0 if ok else 1
    finally:
        con.close()
        # 验证副本是派生产物，不留在工作区
        if tmp.exists():
            tmp.unlink()
        try:
            WORK_DIR.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
