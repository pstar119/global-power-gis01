#!/usr/bin/env python3
"""应用数据目录的**唯一真相源**。

⚠️ 为什么必须有这个模块（真实事故，不是假设）：
    `import_wri_plants.py` 与 `make_seed_db.py` 曾各自硬编码

        %APPDATA%/com.yourname.globalpowergis/global_power_gis.db

    而 `src-tauri/tauri.conf.json` 里的**真实** identifier 是

        com.pstar119.globalpowergis

    后果：脚本把数据写进一个应用**永远不会读**的目录，而脚本自己完全察觉不到 ——
    目录存在、权限正常、写入成功、行数也对，只是打开应用什么都查不到。
    实测该「幽灵目录」确实已被创建过，说明这个坑已经发作过一次，只是没人发现。

    **根因是同一份常量被抄了两遍**，所以这里改成从 `tauri.conf.json` 读取 ——
    那是 Tauri 运行时自己用的那一份，不可能与真实应用脱节。

用法：
    from app_paths import app_db_path
    DB_PATH = app_db_path()
"""

from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TAURI_CONF_PATH = REPO_ROOT / "src-tauri" / "tauri.conf.json"

DB_FILE_NAME = "global_power_gis.db"


def app_identifier() -> str:
    """从 `tauri.conf.json` 读取应用 identifier。

    ⚠️ 读不到就**直接报错退出**，绝不回退到某个默认值 ——
       静默回退正是这个 bug 的成因（写错目录还当成成功）。
    """
    if not TAURI_CONF_PATH.exists():
        raise SystemExit(
            f"[FAIL] 找不到 {TAURI_CONF_PATH}，无法确定应用数据目录。\n"
            "       请在仓库根目录的 scripts/ 下运行本脚本。"
        )

    with TAURI_CONF_PATH.open(encoding="utf-8") as fh:
        conf = json.load(fh)

    identifier = (conf.get("identifier") or "").strip()
    if not identifier:
        raise SystemExit(f"[FAIL] {TAURI_CONF_PATH} 里没有 identifier 字段")

    return identifier


def app_data_dir() -> Path:
    """与 tauri-plugin-sql 保持一致的数据目录：`%APPDATA%/<identifier>`。"""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise SystemExit("[FAIL] 环境变量 APPDATA 不存在（本工具仅面向 Windows）")
    return Path(appdata) / app_identifier()


def app_db_path() -> Path:
    """应用实际使用的 SQLite 文件路径。"""
    return app_data_dir() / DB_FILE_NAME
