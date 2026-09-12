#!/usr/bin/env python3
"""把 WRI Global Power Plant Database 导入 Global Power GIS 的 SQLite 数据库。

用法：
    python scripts/import_wri_plants.py            # 演练：只生成 .sql 并打印统计
    python scripts/import_wri_plants.py --apply    # 实际写入数据库

为什么用 Python 脚本而不是前端逐条 INSERT：
    3.5 万条数据若在前端用 for 循环逐条 INSERT，会产生 3.5 万次 IPC 往返，
    既慢又会卡死界面。本脚本在进程内用**单事务**批量写入，耗时不到 1 秒；
    同时它不引入任何 npm 依赖，也不需要在 Rust 侧新增命令或放开数据库写权限。

为什么同时生成 .sql 文件：
    它是可人工审查的中间产物 —— 可以直接用 sqlite3 CLI 执行，也方便抽检
    任意一段数据。该文件是派生产物，已被 .gitignore 忽略，不进仓库。

⚠️ 执行 --apply 前必须先**完全关闭应用**，否则 SQLite 文件被占用。
⚠️ 数据库必须先被应用创建过（迁移负责建表），本脚本不建表结构。
"""

import argparse
import csv
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

DATA_URL = (
    "https://raw.githubusercontent.com/wri/global-power-plant-database/"
    "master/output_database/global_power_plant_database.csv"
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "data" / "global_power_plant_database.csv"
SQL_PATH = REPO_ROOT / "scripts" / "wri_plants.sql"
DB_PATH = (
    Path(os.environ.get("APPDATA", ""))
    / "com.yourname.globalpowergis"
    / "global_power_gis.db"
)

# 依赖的上游字段：任一缺失都说明数据源结构变了，应立刻停止而不是导入错数据
REQUIRED_COLUMNS = {
    "name",
    "country",
    "capacity_mw",
    "latitude",
    "longitude",
    "gppd_idnr",
    "primary_fuel",
}

# SQLite 的多值 INSERT 受 SQLITE_MAX_COMPOUND_SELECT 限制（编译期默认 500），
# 超出会直接报 "too many terms in compound SELECT"，所以按此批量拆分。
BATCH_SIZE = 500

COLUMNS = ("name", "country", "capacity_mw", "lat", "lon", "gppd_idnr", "primary_fuel")


def log(msg: str) -> None:
    print(msg, flush=True)


def ensure_csv() -> None:
    """本地没有 CSV 就下载一份并缓存，避免每次重复拉取约 11 MB。"""
    if CSV_PATH.exists():
        log(f"使用本地缓存 : {CSV_PATH}  ({CSV_PATH.stat().st_size:,} 字节)")
        return

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    log(f"本地无缓存，开始下载：{DATA_URL}")
    tmp = CSV_PATH.with_suffix(".csv.part")
    urllib.request.urlretrieve(DATA_URL, tmp)  # noqa: S310 - 固定 https 地址
    tmp.replace(CSV_PATH)
    log(f"下载完成     : {CSV_PATH}  ({CSV_PATH.stat().st_size:,} 字节)")


def load_rows():
    """读取并清洗 CSV，返回 (行元组列表, 统计信息)。"""
    rows = []
    skipped_no_coord = 0
    skipped_no_id = 0
    seen_ids = set()
    duplicate_ids = []
    fuels = {}

    with CSV_PATH.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)

        missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
        if missing:
            sys.exit(f"❌ 上游 CSV 缺少必需字段：{sorted(missing)}，已中止导入")

        total = 0
        for rec in reader:
            total += 1

            gppd_id = (rec.get("gppd_idnr") or "").strip()
            if not gppd_id:
                skipped_no_id += 1
                continue

            # 唯一索引要求 ID 不重复；上游若出现重复必须先暴露出来
            if gppd_id in seen_ids:
                duplicate_ids.append(gppd_id)
                continue
            seen_ids.add(gppd_id)

            try:
                lat = float(rec["latitude"])
                lon = float(rec["longitude"])
            except (TypeError, ValueError):
                # 没有坐标的点无法在地图上定位，跳过
                skipped_no_coord += 1
                continue

            try:
                capacity = float(rec["capacity_mw"])
            except (TypeError, ValueError):
                capacity = None

            fuel = (rec.get("primary_fuel") or "").strip() or None
            fuels[fuel] = fuels.get(fuel, 0) + 1

            rows.append(
                (
                    (rec.get("name") or "").strip() or gppd_id,
                    (rec.get("country") or "").strip() or None,
                    capacity,
                    lat,
                    lon,
                    gppd_id,
                    fuel,
                )
            )

    stats = {
        "total": total,
        "kept": len(rows),
        "skipped_no_coord": skipped_no_coord,
        "skipped_no_id": skipped_no_id,
        "duplicate_ids": duplicate_ids,
        "fuels": fuels,
    }
    return rows, stats


def sql_literal(value):
    """把 Python 值转成 SQL 字面量（生成 .sql 文件时用）。"""
    if value is None:
        return "NULL"
    if isinstance(value, float):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def write_sql(rows) -> None:
    """生成可人工审查的 .sql 文件。"""
    batches = (len(rows) + BATCH_SIZE - 1) // BATCH_SIZE

    with SQL_PATH.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("-- 本文件由 scripts/import_wri_plants.py 自动生成，请勿手工编辑。\n")
        fh.write("-- 数据来源：WRI Global Power Plant Database (CC BY 4.0)\n")
        fh.write(f"-- 记录数：{len(rows)}，共 {batches} 批（每批最多 {BATCH_SIZE} 条）\n")
        fh.write("\nBEGIN TRANSACTION;\n\n")
        fh.write("-- 全量替换语义：先清空，保证脚本可重复执行而不产生重复数据\n")
        fh.write("DELETE FROM power_plants;\n\n")

        for start in range(0, len(rows), BATCH_SIZE):
            batch = rows[start : start + BATCH_SIZE]
            fh.write(
                f"INSERT INTO power_plants ({', '.join(COLUMNS)}) VALUES\n"
            )
            for i, row in enumerate(batch):
                sep = "," if i < len(batch) - 1 else ";"
                values = ", ".join(sql_literal(v) for v in row)
                fh.write(f"  ({values}){sep}\n")
            fh.write("\n")

        fh.write("COMMIT;\n")

    log(f"生成 SQL     : {SQL_PATH}  ({SQL_PATH.stat().st_size:,} 字节，{batches} 批)")


def apply_to_db(rows) -> None:
    """在单个事务内批量写入数据库（全量替换）。"""
    if not DB_PATH.exists():
        sys.exit(f"❌ 找不到数据库 {DB_PATH}，请先至少启动一次应用以建库")

    if not os.access(DB_PATH, os.W_OK):
        sys.exit("❌ 数据库文件不可写，请确认应用已完全关闭")

    con = sqlite3.connect(DB_PATH)
    try:
        before = con.execute("SELECT COUNT(*) FROM power_plants").fetchone()[0]

        con.execute("BEGIN")
        con.execute("DELETE FROM power_plants")
        # executemany 复用同一条预编译语句，是一次事务里的批量写入
        # （与前端逐条走 IPC 完全不同：这里没有任何进程间往返）
        con.executemany(
            f"INSERT INTO power_plants ({', '.join(COLUMNS)}) "
            f"VALUES ({', '.join('?' * len(COLUMNS))})",
            rows,
        )
        con.commit()

        after = con.execute("SELECT COUNT(*) FROM power_plants").fetchone()[0]
        log(f"写入数据库   : {DB_PATH}")
        log(f"               {before} 条 -> {after} 条")
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="导入 WRI 全球电厂数据")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="实际写入数据库（默认只生成 .sql 并打印统计）",
    )
    args = parser.parse_args()

    ensure_csv()
    rows, stats = load_rows()

    log("")
    log(f"CSV 总记录数 : {stats['total']}")
    log(f"可导入记录数 : {stats['kept']}")
    log(f"跳过（无坐标）: {stats['skipped_no_coord']}")
    log(f"跳过（无 ID） : {stats['skipped_no_id']}")
    log(f"重复 ID 数    : {len(stats['duplicate_ids'])}")
    log(f"燃料类型数    : {len(stats['fuels'])}")
    top = sorted(stats["fuels"].items(), key=lambda kv: -kv[1])[:8]
    log("燃料 Top8     : " + ", ".join(f"{k}={v}" for k, v in top))

    write_sql(rows)

    if args.apply:
        apply_to_db(rows)
        log("\n结论         : 已写入数据库")
    else:
        log("\n结论         : 演练模式，未改动数据库（加 --apply 才会写入）")


if __name__ == "__main__":
    main()
