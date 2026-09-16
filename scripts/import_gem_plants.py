"""
阶段50-A：抓取 GEM 三类电源（煤炭 / 油气 / 生物质）机组级数据，
聚合成**电站级 GeoJSON**，供 build_pmtiles.mjs 切片。

‼️ 与阶段48-A 的 import_gem_coal.py 的本质区别：
   **不再写任何数据库**。产物是一个 GeoJSON 文件（随后切成 pmtiles 数据包），
   这样 GEM 数据可以走已经验证过的下载链路，而不是让安装包变胖。
   （现有下载管线只接受 .pmtiles —— packs.rs 的 safe_file_name 硬校验，
     所以「独立 SQLite 数据包」这条路在架构上就是不通的。）

许可：CC BY 4.0，允许再分发，要求署名（见 README 的「数据来源与许可」）。

━━━ 三个 tracker 的实测规模（2026-09-16）━━━
    coal-plant       14,509 机组 / 4,865 电站
    oil-gas-plant    14,745 机组 / 6,390 电站
    bioenergy-plant   4,536 机组 / 3,538 电站
    ------------------------------------------
    合计             33,790 机组 / 14,793 电站（编号空间可能重叠，见下）

━━━ 🔴 复合键：为什么不能只用 location_id ━━━
三个 tracker 来自**三份互不相干的 xlsx**（GCPT / GOGPT / GBPT），
它们的 location_id 是否共用同一编号空间**未知**。若真撞号，
只按 location_id 聚合会把两座不同国家的电站粘成一个（坐标取质心 → 落到海里）。
所以合并键一律用 `plant_type + ":" + location_id`，并在下面**实测报告**是否真撞。

用法：
    python scripts/import_gem_plants.py
    python scripts/import_gem_plants.py --out data/packs/gem-plants.geojson
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

API_BASE = "https://api.globalenergymonitor.org/assets"
UA = "global-power-gis/0.1 (phase50 import; github.com/pstar119/global-power-gis01)"
PAGE_SIZE = 500  # ← API 硬上限，传 1000 返回 422

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 3.0, 9.0)
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
TIMEOUT = 90

# asset_type（API 枚举值）→ plant_type（写进瓦片的短值，前端按它取色）
TYPES: list[tuple[str, str]] = [
    ("coal-plant", "coal"),
    ("oil-gas-plant", "oil-gas"),
    ("bioenergy-plant", "bioenergy"),
]

# 状态取主状态时的确定性优先级（并列时用它决出，避免渲染结果随数据顺序变）
STATUS_PRIORITY = ["operating", "planned", "retired", "cancelled"]

# GeoJSON 里保留的字段。**越少越好**：MVT 的字符串表会为每个唯一值付一次成本。
KEEP = ("plant_type", "capacity", "status", "units", "name", "owner")


class Abort(RuntimeError):
    pass


def fetch_page(asset_type: str, offset: int) -> dict:
    """抓一页。只对可恢复错误重试；其他 4xx 立刻失败并带出服务端原文。"""
    url = f"{API_BASE}?asset_type={asset_type}&limit={PAGE_SIZE}&offset={offset}"
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(400).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
            if e.code in RETRYABLE_STATUS:
                last = e
                print(f"      HTTP {e.code}（可恢复）第 {attempt}/{MAX_ATTEMPTS} 次")
            else:
                raise Abort(f"{asset_type} offset={offset} HTTP {e.code}（不可重试）: {body}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
            print(f"      连接异常（可恢复）: {e}")
        if attempt < MAX_ATTEMPTS:
            time.sleep(BACKOFF_SECONDS[attempt - 1] + random.uniform(0, 0.5))
    raise Abort(f"{asset_type} offset={offset} 连续 {MAX_ATTEMPTS} 次失败：{last}")


def fetch_type(asset_type: str) -> list[dict]:
    """抓一个类型的全量，并做**完整性硬校验**（少了就是有页静默失败）。"""
    rows: list[dict] = []
    offset = 0
    expected: int | None = None
    pages = 0
    while True:
        pages += 1
        data = fetch_page(asset_type, offset)
        if expected is None:
            expected = int(data.get("total") or 0)
            print(f"    API 声明 total={expected}，预计 {-(-expected // PAGE_SIZE)} 页")
        batch = data.get("results") or []
        rows.extend(batch)
        offset += len(batch)
        if not batch or (expected is not None and offset >= expected):
            break
        if pages > 200:
            raise Abort(f"{asset_type} 翻页超过 200 页，接口行为异常")
    if expected is not None and len(rows) != expected:
        raise Abort(f"{asset_type} 完整性校验失败：声明 {expected} 实抓 {len(rows)}")
    print(f"    ✅ {len(rows)} 条（= total）")
    return rows


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/packs/gem-plants.geojson")
    args = ap.parse_args()

    print("=" * 74)
    print("1) 全量抓取三类电源（每类独立分页 + 独立完整性校验）")
    print("=" * 74)
    t0 = time.time()
    per_type: dict[str, list[dict]] = {}
    for asset_type, plant_type in TYPES:
        print(f"\n  [{plant_type}] asset_type={asset_type}")
        per_type[plant_type] = fetch_type(asset_type)
    total_units = sum(len(v) for v in per_type.values())
    print(f"\n  合计 {total_units} 机组 / 耗时 {time.time() - t0:.1f}s")

    print()
    print("=" * 74)
    print("2) 🔴 location_id 重号实测（决定复合键是否真的必要）")
    print("=" * 74)
    ids_by_type: dict[str, set[str]] = {
        pt: {str(r.get("location_id")) for r in rows} for pt, rows in per_type.items()
    }
    for pt, ids in ids_by_type.items():
        print(f"  {pt:<12} 分别有 {len(ids)} 个不同的 location_id")
    union = set().union(*ids_by_type.values())
    naive_sum = sum(len(v) for v in ids_by_type.values())
    print(f"  各自去重后相加 : {naive_sum}")
    print(f"  全部并集去重后 : {len(union)}")
    overlap = naive_sum - len(union)
    print(f"  ⇒ 跨类型重号数量 : {overlap}")
    if overlap > 0:
        # 找出具体是哪些 id 被多个类型共用
        owners = defaultdict(list)
        for pt, ids in ids_by_type.items():
            for i in ids:
                owners[i].append(pt)
        shared = {i: pts for i, pts in owners.items() if len(pts) > 1}
        print(f"     例（最多列 5 个）:")
        for i, pts in list(shared.items())[:5]:
            print(f"       {i}  被 {pts} 共用")
        print("     🔴 确认必须使用复合键 —— 单纯按 location_id 聚合会把它们粘成一个")
    else:
        print("     ✅ 未发现跨类型重号；但脚本仍**保留复合键逻辑**（上游换版可能改变编号策略）")

    print()
    print("=" * 74)
    print("3) 聚合到电站级（复合键 = plant_type + ':' + location_id）")
    print("=" * 74)
    stations: dict[str, dict] = {}
    for plant_type, rows in per_type.items():
        for r in rows:
            key = f"{plant_type}:{r.get('location_id')}"
            st = stations.get(key)
            if st is None:
                owners0 = r.get("owners") or []
                st = {
                    "plant_type": plant_type,
                    "name": r.get("project_name") or r.get("asset_name") or "未命名电站",
                    "lat_sum": 0.0,
                    "lon_sum": 0.0,
                    "units": 0,
                    "capacity": 0.0,
                    "by_status": Counter(),
                    "owner": (owners0[0].get("name") if owners0 else None),
                }
                stations[key] = st
            # 质心：实测同一电站内机组坐标绝大多数相同，少数不一致时取均值最中立
            st["lat_sum"] += float(r.get("latitude") or 0.0)
            st["lon_sum"] += float(r.get("longitude") or 0.0)
            st["units"] += 1
            st["capacity"] += float(r.get("capacity_value") or 0.0)
            st["by_status"][r.get("operating_status") or "unknown"] += 1
            if not st["owner"] and (r.get("owners") or []):
                st["owner"] = r["owners"][0].get("name")

    def dominant(c: Counter) -> str:
        if not c:
            return "unknown"
        best_n = max(c.values())
        for s in STATUS_PRIORITY:  # 并列时按确定性优先级决出
            if c.get(s) == best_n:
                return s
        return c.most_common(1)[0][0]

    features = []
    by_type = Counter()
    by_status = Counter()
    no_owner = 0
    for _key, st in stations.items():
        n = st["units"]
        props = {
            "plant_type": st["plant_type"],
            "capacity": round(st["capacity"], 1),
            "status": dominant(st["by_status"]),
            "units": n,
            "name": st["name"],
        }
        if st["owner"]:
            props["owner"] = st["owner"]
        else:
            no_owner += 1
        by_type[st["plant_type"]] += 1
        by_status[props["status"]] += 1
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(st["lon_sum"] / n, 6), round(st["lat_sum"] / n, 6)],
                },
            }
        )

    print("  电站数（按 plant_type）：")
    for pt, c in by_type.most_common():
        print(f"    {pt:<12} {c:>7}")
    print(f"  合计电站 : {len(features)}")
    print("  主状态分布：")
    for s, c in by_status.most_common():
        print(f"    {s:<12} {c:>7}")
    print(f"  无 owner 的电站 : {no_owner}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {"type": "FeatureCollection", "features": features}
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    mb = out.stat().st_size / 1024 / 1024
    print()
    print("=" * 74)
    print(f"4) 已写出 {out}  —— {mb:.2f} MB（{len(features)} 个要素）")
    print("=" * 74)
    print("   下一步：node scripts/build_pmtiles.mjs --name gem-plants ...（见阶段50 方案）")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Abort as e:
        print(f"\n❌ 中止：{e}", file=sys.stderr)
        raise SystemExit(1)
