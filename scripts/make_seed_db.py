"""生成首次运行播种用的 seed 数据库。

用 SQLite 的 VACUUM INTO 生成一份「紧凑且一致」的副本：
  - 不是简单 copy 文件，VACUUM INTO 会重建整个库，去掉空闲页与碎片
  - WAL 模式下未落盘的内容也会被正确合并，不会拷到半个事务

用法：python make_seed_db.py
"""

import os
import sqlite3
import sys

# ⚠️ 与 import_wri_plants.py 共用同一个真相源（app_paths 读 tauri.conf.json）。
#    这里曾经硬编码 "com.yourname.globalpowergis"，而真实 identifier 是
#    "com.pstar119.globalpowergis" —— 后果是会把一个**空库或过期库**
#    当成种子打包进安装包，且脚本自检（表 + 行数 + 抽查）全部通过。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app_paths import app_db_path  # noqa: E402

SRC = str(app_db_path())
DST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "src-tauri",
    "resources",
    "seed",
    "global_power_gis.db",
)
DST = os.path.normpath(DST)


def main() -> int:
    if not os.path.exists(SRC):
        print(f"[FAIL] 源数据库不存在: {SRC}")
        return 1

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    if os.path.exists(DST):
        os.remove(DST)

    # VACUUM INTO 不支持参数绑定，路径统一用正斜杠避免反斜杠转义问题
    con = sqlite3.connect(SRC)
    con.execute("VACUUM INTO ?", (DST.replace("\\", "/"),))
    con.close()

    # 校验
    con = sqlite3.connect(DST)
    tables = [
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
    ]
    print(f"[OK] seed 已生成: {DST}")
    print(f"     体积: {os.path.getsize(DST) / 1024 / 1024:.2f} MB")
    print(f"     表: {tables}")
    for t in tables:
        if t.startswith("sqlite_"):
            continue
        n = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        print(f"     {t}: {n} 行")
    # 抽查一条，确认数据没被搬坏
    row = con.execute(
        "SELECT name, country, capacity_mw FROM power_plants "
        "WHERE primary_fuel='Coal' AND country='CHN' ORDER BY capacity_mw DESC LIMIT 1"
    ).fetchone()
    print(f"     抽查（中国最大煤电）: {row}")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
