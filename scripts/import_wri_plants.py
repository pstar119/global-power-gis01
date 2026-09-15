#!/usr/bin/env python3
"""把 WRI Global Power Plant Database 导入 Global Power GIS 的 SQLite 数据库。

用法：
    python scripts/import_wri_plants.py            # 演练：只生成 .sql 并打印统计
    python scripts/import_wri_plants.py --apply    # 实际写入数据库

阶段46：导入字段从 7 个增加到 11 个。
    上游 CSV v1.3.0 实测有 **36 列**，此前只取了 7 列，
    `commissioning_year` / `owner` / `source` / `url` 被**静默丢弃** ——
    所以界面上「没有投产年份和所有者」的根因在**我们自己的管道**里，
    而不是数据源能力不足（不需要引入任何新数据源）。
    对应的数据库列由迁移 `006_add_plant_metadata.sql` 补齐。

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
import datetime
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

# 同目录下的 app_paths 是「应用数据目录」的唯一真相源（它读 tauri.conf.json）。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_paths import REPO_ROOT, app_db_path  # noqa: E402

DATA_URL = (
    "https://raw.githubusercontent.com/wri/global-power-plant-database/"
    "master/output_database/global_power_plant_database.csv"
)

CSV_PATH = REPO_ROOT / "data" / "global_power_plant_database.csv"
SQL_PATH = REPO_ROOT / "scripts" / "wri_plants.sql"

# ⚠️ 不再硬编码目录名。这里曾经写死 "com.yourname.globalpowergis"，
#    与 tauri.conf.json 的真实 identifier "com.pstar119.globalpowergis" 不符，
#    导入的数据会落进应用**永远不读**的目录（详见 app_paths.py 的事故记录）。
DB_PATH = app_db_path()

# 依赖的上游字段：任一缺失都说明数据源结构变了，应立刻停止而不是导入错数据。
# ⚠️ 这 4 个元数据字段同样纳入校验：它们在上游 CSV v1.3.0 的表头里**一直存在**
#    （已实测 36 列），一旦哪天消失，继续导入会静默丢掉年份 / 所有者 ——
#    那正是本次要修的 bug，所以必须让它在最早的时刻就炸出来。
REQUIRED_COLUMNS = {
    "name",
    "country",
    "capacity_mw",
    "latitude",
    "longitude",
    "gppd_idnr",
    "primary_fuel",
    "commissioning_year",
    "owner",
    "source",
    "url",
}

# SQLite 的多值 INSERT 受 SQLITE_MAX_COMPOUND_SELECT 限制（编译期默认 500），
# 超出会直接报 "too many terms in compound SELECT"，所以按此批量拆分。
BATCH_SIZE = 500

# ⚠️ 顺序必须与 load_rows() 里 rows.append(...) 的元组顺序**严格一致**：
#    脚本不做按名映射（位置绑定更快，代价是改一处必须同时改另一处）。
COLUMNS = (
    "name",
    "country",
    "capacity_mw",
    "lat",
    "lon",
    "gppd_idnr",
    "primary_fuel",
    "commissioning_year",
    "owner",
    "source",
    "url",
)

# 合理年份下界：世界第一座商用火电厂建于 1882 年，留一点余量。
YEAR_MIN = 1880


def log(msg: str) -> None:
    print(msg, flush=True)


def clean_text(raw) -> str | None:
    """去空白，空串一律转成 None。

    ⚠️ 不能留空串：空串在 UI 上会渲染成一片空白，看起来像渲染坏了；
       None 才能稳定地显示为占位符 "--"。
    """
    text = (raw or "").strip()
    return text or None


def parse_year(raw) -> int | None:
    """把上游的 commissioning_year 解析成整数年份。

    ⚠️ 上游实测是脏数据：既有空串，也有 "1985.0" 这种浮点写法，
       所以先走 float 再取整。
    ⚠️ 解析失败返回 None，**绝不当成 0**：0 会在界面上变成「公元 0 年」，
       是比缺失更糟糕的错误信息。也绝不因此丢弃整行 ——
       年份缺失不影响坐标与容量，这条电站依然应该出现在地图上。
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        year = int(float(text))
    except (TypeError, ValueError):
        return None
    # 明显越界的值（1、99999 之类）是上游录入错误，宁可不显示
    if not YEAR_MIN <= year <= datetime.date.today().year + 10:
        return None
    return year


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
    # 阶段46：新增字段的覆盖率统计 —— 用来判断「字段拿到没有」
    # 以及「上游到底有多少是空的」，避免把上游的空值误判成本脚本的 bug
    year_ok = 0
    owner_ok = 0
    url_ok = 0

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

            fuel = clean_text(rec.get("primary_fuel"))
            fuels[fuel] = fuels.get(fuel, 0) + 1

            year = parse_year(rec.get("commissioning_year"))
            owner = clean_text(rec.get("owner"))
            url = clean_text(rec.get("url"))
            if year is not None:
                year_ok += 1
            if owner:
                owner_ok += 1
            if url:
                url_ok += 1

            rows.append(
                (
                    clean_text(rec.get("name")) or gppd_id,
                    clean_text(rec.get("country")),
                    capacity,
                    lat,
                    lon,
                    gppd_id,
                    fuel,
                    year,
                    owner,
                    clean_text(rec.get("source")),
                    url,
                )
            )

    stats = {
        "total": total,
        "kept": len(rows),
        "skipped_no_coord": skipped_no_coord,
        "skipped_no_id": skipped_no_id,
        "duplicate_ids": duplicate_ids,
        "fuels": fuels,
        "year_ok": year_ok,
        "owner_ok": owner_ok,
        "url_ok": url_ok,
    }
    return rows, stats


def sql_literal(value):
    """把 Python 值转成 SQL 字面量（生成 .sql 文件时用）。"""
    if value is None:
        return "NULL"
    if isinstance(value, float):
        return repr(value)
    # 阶段46：整数（commissioning_year）必须写成裸数字而不是 '1985'。
    # SQLite 虽然靠列亲和性也能把字符串转成整数，但那是**隐式**转换：
    # 生成的 .sql 是给人审查的中间产物，写 '1985' 会让人以为这一列是 TEXT。
    if isinstance(value, int):
        return str(value)
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

    # 阶段46：新增字段的覆盖率。
    # ‼️ 这两行是本次修复的**验收指标** —— 全是 0 就说明字段又丢了。
    #    但要注意区分「字段丢了」和「上游本身为空」：
    #    上游确实有大量记录没填年份 / 所有者，所以这里不设阈值，只如实报告。
    kept = stats["kept"] or 1
    log("")
    log(f"投产年份有值  : {stats['year_ok']} ({stats['year_ok'] / kept:.1%})")
    log(f"所有者有值    : {stats['owner_ok']} ({stats['owner_ok'] / kept:.1%})")
    log(f"来源链接有值  : {stats['url_ok']} ({stats['url_ok'] / kept:.1%})")

    write_sql(rows)

    if args.apply:
        apply_to_db(rows)
        log("\n结论         : 已写入数据库")
    else:
        log("\n结论         : 演练模式，未改动数据库（加 --apply 才会写入）")


if __name__ == "__main__":
    main()
