"""
阶段48-A：把 GEM（Global Energy Monitor）的煤炭数据导入本地 SQLite。

数据源：`https://api.globalenergymonitor.org/assets?asset_type=coal-plant`
        —— GEM 的公开接口，**无需鉴权**（实测 200）。

许可：CC BY 4.0。要求署名（见本文件与迁移 008 里的版权串）。
      ⇒ 抓取与再分发都是被明确允许的，但署名不能丢。

━━━ 为什么是 Python，为什么用 stdlib ━━━
这是**开发期的一次性导入工具**，不是随应用分发的功能。
  · 不引入 `requests`：stdlib 的 `urllib` 实测够用（全量 30 次请求 / 45 秒）。
  · 不写进 Rust：那会把网络依赖塞进发行版，刷新数据不该是用户点按钮的动作。
  · 不写进前端：数据要在**建库期**落盘，生产环境要能离线跑。

━━━ API 的实测约束（别照文档猜，这些是打出来的）━━━
  · `limit` 上限 = **500**。传 1000 会返回 422：
        {"detail":[{"msg":"Input should be less than or equal to 500"}]}
  · `asset_type` 必须写**枚举值 `coal-plant`**。写成 `Coal Plant` / `Coal Mine`
    会**静默返回 total=0**（不报错）—— 极易误判成「这个接口没有电厂数据」。
  · 全量 14,509 条 / 29 页满页 + 1 页 9 条 / 约 12.67 MB / 约 45 秒。
  · 坐标与容量完整率均为 100%，capacity_unit 恒为 MW。

━━━ ⚠️⚠️ 已归档（阶段51-A）：本脚本现已无法运行 ━━━
它要写入的 `gem_coal_plants` 表已被**迁移 009** 删除（阶段50-C.4 已实例验证）。
GEM 数据现在走 pmtiles 数据包通道：
    scripts/import_gem_plants.py  →  scripts/build_pmtiles.mjs  →  packs/gem-plants.pmtiles

保留本文件**只为历史与许可追溯**（README 的署名表把它列为署名位置之一）。
现在误跑它会是**响亮失败**而非静默出错：它先查表是否存在，不存在就抛 ImportAbort，
且**刻意不自建表** —— 避免 DDL 出现第二个来源而与迁移漂移。

用法（仅作记录，现已不可用）：
    # 演练模式（默认）：只抓取与校验，**不写库**
    python scripts/archive/import_gem_coal_legacy.py
    # 真正写入
    python scripts/archive/import_gem_coal_legacy.py --apply
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# ⚠️ scripts/ 下的路径工具是**唯一**的标识符来源，绝不硬编码数据目录
#    （阶段46 就因为两处各硬编码一份 identifier，把数据写进了应用永远不读的目录）
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from app_paths import app_db_path  # noqa: E402

API_BASE = "https://api.globalenergymonitor.org/assets"
UA = "global-power-gis/0.1 (data import; https://github.com/pstar119/global-power-gis01)"
ASSET_TYPE = "coal-plant"
PAGE_SIZE = 500  # ← API 硬上限，传更大返回 422

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 3.0, 9.0)  # 指数退避，外加抖动
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
TIMEOUT = 90


class ImportAbort(RuntimeError):
    """任何**不可恢复**的问题都直接抛这个，绝不静默跳过。"""


def fetch_page(offset: int) -> tuple[dict[str, Any], int]:
    """
    抓一页。带**有界重试**。

    重试策略（写在注释里，因为「什么时候不该重试」比什么时候该重试更重要）：
      · 只对**可恢复**的错误重试：连接类异常（超时/重置/DNS）、429、5xx。
      · 其他 4xx **立刻失败**并打印原始响应体 —— 重试只会把「参数写错」
        拖成三次无意义的等待，而且掩盖掉真正的原因（`limit` 超限报 422 就是这类）。
      · 退避 1s → 3s → 9s + 抖动，避免与其它客户端同步重试。
    """
    url = f"{API_BASE}?asset_type={ASSET_TYPE}&limit={PAGE_SIZE}&offset={offset}"
    last_err: Exception | None = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8")), len(raw)

        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(600).decode("utf-8", "replace")
            except Exception:
                pass
            if e.code in RETRYABLE_STATUS:
                last_err = e
                print(f"    ⚠️ HTTP {e.code}（可恢复），第 {attempt}/{MAX_ATTEMPTS} 次")
            else:
                # 不可恢复：立刻死，并把服务端说的话原样带出来
                raise ImportAbort(
                    f"offset={offset} 返回 HTTP {e.code}（不可重试）。\n"
                    f"  服务端正文: {body.strip()}\n"
                    f"  地址: {url}"
                ) from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last_err = e
            print(f"    ⚠️ 连接异常（可恢复）: {e}，第 {attempt}/{MAX_ATTEMPTS} 次")

        if attempt < MAX_ATTEMPTS:
            time.sleep(BACKOFF_SECONDS[attempt - 1] + random.uniform(0, 0.5))

    raise ImportAbort(f"offset={offset} 连续 {MAX_ATTEMPTS} 次失败：{last_err}")


def fetch_all() -> tuple[list[dict[str, Any]], int]:
    """
    翻页抓全量。

    🔴 最后做**完整性硬校验**：拼出来的条数必须等于第一页声明的 `total`。
       这条断言是整个脚本最重要的部分 —— 少了它，一次静默的漏页
       会产出一个「看起来正常」但缺斤少两的库，而且**没有任何报错**。
       （教训来自 overpass 那次：超时被当成「该区域 0 要素」写进了覆盖表。）
    """
    rows: list[dict[str, Any]] = []
    offset = 0
    total_bytes = 0
    expected: int | None = None
    page_no = 0

    while True:
        page_no += 1
        data, nbytes = fetch_page(offset)
        total_bytes += nbytes

        if expected is None:
            expected = int(data.get("total") or 0)
            print(f"  API 声明 total = {expected}，每页 {PAGE_SIZE}，预计 { -(-expected // PAGE_SIZE) } 页")

        batch = data.get("results") or []
        rows.extend(batch)
        offset += len(batch)
        print(f"  第 {page_no:>2} 页  offset={offset:<6} +{len(batch):<4} 累计 {len(rows)}")

        if not batch:
            break
        if expected is not None and offset >= expected:
            break
        if page_no > 200:  # 保险丝：绝不允许无限翻页
            raise ImportAbort("翻页超过 200 页，疑似接口行为异常，已中止")

    if expected is not None and len(rows) != expected:
        raise ImportAbort(
            f"完整性校验失败：API 声明 {expected} 条，实际抓到 {len(rows)} 条。\n"
            f"  ⇒ 很可能有页面静默失败。**不写库**，请重跑。"
        )

    print(f"  ✅ 完整性校验通过：{len(rows)} 条（= API 声明的 total）/ {total_bytes / 1024 / 1024:.2f} MB")
    return rows, total_bytes


def to_record(r: dict[str, Any]) -> tuple:
    """把 API 记录摊平成一行。字段缺失一律存 NULL，**绝不编造**。"""
    owners = r.get("owners") or []
    first = owners[0] if owners else {}
    return (
        r.get("asset_id"),
        r.get("location_id"),
        r.get("unit_name"),
        r.get("project_name"),
        r.get("country"),
        r.get("state_province"),
        r.get("capacity_value"),
        r.get("operating_status"),
        r.get("operating_sub_status"),
        r.get("latitude"),
        r.get("longitude"),
        first.get("name"),
        first.get("ownership_share"),
        r.get("wiki_url"),
        None,  # fetched_at 由调用方统一填
    )


COLUMNS = (
    "unit_id, location_id, unit_name, station_name, country, state_province, "
    "capacity_mw, status, sub_status, latitude, longitude, owner, owner_share, "
    "wiki_url, fetched_at"
)


def summarise(records: list[tuple]) -> None:
    from collections import Counter

    status = Counter(r[7] for r in records)
    locs = {r[1] for r in records}
    no_coord = sum(1 for r in records if r[9] is None or r[10] is None)
    no_cap = sum(1 for r in records if r[6] is None)
    with_owner = sum(1 for r in records if r[11])

    print("\n=== 抓取结果概览 ===")
    print(f"  机组记录 : {len(records)}")
    print(f"  电站数量 : {len(locs)}（按 location_id 去重）")
    print(f"  缺坐标   : {no_coord}    缺容量: {no_cap}    有 owner: {with_owner}")
    print("  状态分布 :")
    for k, v in status.most_common():
        print(f"    {str(k):<12} {v:>6}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="导入 GEM 煤炭数据（CC BY 4.0）")
    ap.add_argument("--apply", action="store_true", help="真正写入数据库（默认只演练）")
    args = ap.parse_args()

    db = app_db_path()
    print(f"数据库 : {db}")
    print(f"接口   : {API_BASE}?asset_type={ASSET_TYPE}&limit={PAGE_SIZE}\n")

    print("=== 1) 抓取 ===")
    rows, _ = fetch_all()
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    records = [to_record(r)[:-1] + (fetched_at,) for r in rows]
    summarise(records)

    if not args.apply:
        print("\n（演练模式：未写入任何数据。确认无误后加 --apply 重跑）")
        return 0

    print("\n=== 2) 写入 SQLite ===")
    if not db.exists():
        raise ImportAbort(f"数据库不存在：{db}\n  请先启动一次应用以完成建库与迁移。")

    # timeout 放宽：应用可能正开着（WAL 模式下读不阻塞，写要等锁）
    conn = sqlite3.connect(str(db), timeout=30)
    try:
        cur = conn.cursor()
        exists = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='gem_coal_plants'"
        ).fetchone()
        if not exists:
            raise ImportAbort(
                "表 gem_coal_plants 不存在。\n"
                "  请先启动一次应用，让迁移 008 建表（迁移是 DDL 的唯一来源，"
                "本脚本刻意不自行建表，否则两处 DDL 会漂移）。"
            )

        conf = cur.execute("SELECT COUNT(*) FROM gem_coal_plants").fetchone()[0]
        print(f"  写入前行数 : {conf}")

        # 单事务：要么全进，要么全不进，绝不留下半新半旧的混合状态
        cur.execute("BEGIN")
        cur.execute("DELETE FROM gem_coal_plants")
        cur.executemany(
            f"INSERT INTO gem_coal_plants ({COLUMNS}) VALUES ({','.join('?' * 15)})",
            records,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print("\n=== 3) 回读校验 ===")
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        n = cur.execute("SELECT COUNT(*) FROM gem_coal_plants").fetchone()[0]
        locs = cur.execute("SELECT COUNT(DISTINCT location_id) FROM gem_coal_plants").fetchone()[0]
        cap = cur.execute("SELECT SUM(capacity_mw) FROM gem_coal_plants").fetchone()[0]
        print(f"  行数        : {n}（期望 {len(records)}）")
        print(f"  电站数      : {locs}")
        print(f"  容量合计    : {cap:,.1f} MW")
        if n != len(records):
            raise ImportAbort(f"回读行数 {n} != 期望 {len(records)}")
        print("  ✅ 回读一致")
    finally:
        conn.close()

    print("\n完成。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ImportAbort as e:
        print(f"\n❌ 中止：{e}", file=sys.stderr)
        raise SystemExit(1)
