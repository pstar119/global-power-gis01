#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段56-C：**只补面层**的定向回填（不是重抓整个区域）。

🔴 为什么需要它（2026-09-26 实测）：`fetch_osm_power.py` 为「没有完整覆盖标记」的桶
   会重抓**该区域全部块**，而每块的 power 查询包含 `way[power=line]` —— 华东一块就
   返回 2000+ 条线路几何，正是最容易把 Overpass 打到 504 的那类请求。
   实测（maps.mail.ru 与 overpass-api.de 都是）：**每块要 3~4 次 504 重试**，
   1 块 ≈ 4 分钟 ⇒ 190 块批次 ≈ 13 小时，946 块 ≈ 60 小时以上。

   但回填**根本不需要重抓** lines/substations/plants —— 它们在上一轮就是完整的
   （逐区要素数已核对，且已打上覆盖标记）。缺的只有 `plant_areas`。
   而 `way["power"="plant"]` 的结果集极小（华东全区域才几千条，且不带线路），
   所以定向查询把 Overpass 成本降到原来的**很小一部分**。

   ⇒ 本脚本对每个区域：按与主脚本**完全相同**的网格分块，只查 `way[power=plant]`，
     用主脚本的 `build_feature(el,'plant_area')` 构造要素，再按 osm_id 与**已有产物合并**
     （不是覆盖），最后落盘 + 打覆盖标记。

‼️ 它**不碰** lines / substations / plants / converters 四个桶，一个字节都不改。
   也不碰断点文件（那会让主脚本以为这些块"已完成"，而它们确实已完成）。

用法：
    python scripts/backfill_plant_areas.py --regions huadong,huazhong
    python scripts/backfill_plant_areas.py --regions kp-kr --dry-run
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_fetcher():
    """把主脚本当模块加载，**复用**它的查询/几何/写盘/覆盖标记等全部实现。

    ⚠️ 刻意不复制一份：面层的判据（首尾顶点相同）与产物格式必须与主脚本**逐字一致**，
       复制一份就是给"两处判据漂移"埋雷。
    """
    path = os.path.join(ROOT, "scripts", "fetch_osm_power.py")
    spec = importlib.util.spec_from_file_location("fetch_osm_power", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["fetch_osm_power"] = mod
    spec.loader.exec_module(mod)
    return mod


F = load_fetcher()


def region_grid(key: str) -> tuple[tuple[float, float, float, float], int, int]:
    """从 `pipeline_regions.mjs` 读区域 bbox 与网格（**唯一权威定义**）。

    ‼️ 用 node 去读那一份，而不是在 Python 里再抄一遍 bbox/grid ——
       抄错一个数字就会抓到相邻区域的边界带，而且不会报错。
    ‼️ 必须走 `gridFor()` 而不是自己按 (e-w)/1.1875 算：
       稀疏邻国批次自带 `region.target`（蒙古/中亚等），自己算会得到**不同的网格**，
       于是分块与主脚本的断点键对不上。
    """
    import subprocess

    js = (
        "import {REGIONS, gridFor} from './scripts/pipeline_regions.mjs';"
        f"const r=REGIONS.find(x=>x.key==='{key}');"
        "if(!r){console.error('NOT_FOUND');process.exit(3);}"
        "const g=gridFor(r);"
        "console.log(JSON.stringify({bbox:r.bbox,cols:g.cols,rows:g.rows}));"
    )
    p = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if p.returncode != 0:
        # ---- 不在 REGIONS 里的（老 preset 区域，如 yrd / zhejiang）----
        # 它们的网格与 CELL_MEASURED 不同（实测 yrd 是 1°x1° 才得到 20 块），
        # 所以**从断点文件反推**真实网格，而不是拿默认块尺寸硬算 ——
        # 硬算会得到与主脚本不同的分块，于是 plant_areas 的分块与旧数据对不上。
        return _grid_from_progress(key)
    d = json.loads(p.stdout.strip().splitlines()[-1])
    bbox = tuple(float(v) for v in d["bbox"])
    return bbox, int(d["cols"]), int(d["rows"])  # type: ignore[return-value]


def _grid_from_progress(key: str) -> tuple[tuple[float, float, float, float], int, int]:
    """从 `<name>_progress.json` 的已完成块反推 (bbox, cols, rows)。

    ‼️ 为什么可信：done 里存的就是每一块的真实 bbox，取并集即区域 bbox，
       数一数唯一经度/纬度边界数就是 cols/rows。这是**实测值**，不是推算值。
    """
    path = os.path.join(ROOT, "data", "osm", f"{key}_progress.json")
    if not os.path.exists(path):
        raise RuntimeError(f"{key} 既不在 REGIONS 里，也没有 {path} 可反推网格")
    with open(path, encoding="utf-8") as fh:
        done = json.load(fh).get("done") or []
    if not done:
        raise RuntimeError(f"{path} 的 done 是空的，无法反推网格")
    ws = sorted({round(float(c[0]), 6) for c in done})
    ss = sorted({round(float(c[1]), 6) for c in done})
    es = sorted({round(float(c[2]), 6) for c in done})
    ns = sorted({round(float(c[3]), 6) for c in done})
    bbox = (ws[0], ss[0], es[-1], ns[-1])
    return bbox, len(ws), len(ss)  # type: ignore[return-value]


def plant_way_query(b: tuple[float, float, float, float]) -> str:
    """只查电厂的 **way**（面层的唯一来源）。

    ‼️ 不带 `node[power=plant]`：node 本来就进不了面层（没有环）。
       主脚本的 plants 查询同时要 node 与 way，所以更重；这里只要 way。
    ‼️ 不带 `way[power=line]`：线路是 504 的主要来源，且本任务不需要它。
    """
    return (
        f"{F.QUERY_HEAD if hasattr(F, 'QUERY_HEAD') else '[out:json][timeout:180];'}"
        f'(way["power"="plant"]{F.bbox_filter(b)};);'
        f"out geom;"
    )


def backfill_region(name: str, endpoint: str | None, dry_run: bool) -> dict[str, Any]:
    out_dir = os.path.join(ROOT, "data", "osm")
    target_path = F.geom_path(out_dir, name, "power", "plant_areas")

    # ---- 已完成就整个跳过（幂等重跑的关键）----
    # 已有覆盖标记 + 产物存在 ⇒ 没必要再发 200+ 次请求。
    # 这样"重跑整条命令续补"是廉价的，而不是把已完成的区域再抓一遍。
    if not dry_run and "plant_areas" in F.load_bucket_coverage(out_dir, name) and os.path.exists(target_path):
        with open(target_path, encoding="utf-8") as fh:
            n = len(json.load(fh).get("features") or [])
        print(f"\n=== 跳过 {name}：已有完整覆盖标记（{n} 个面）")
        return {"name": name, "added": 0, "total": n, "failed": 0, "skipped": True}

    # ---- 回读已有产物（合并，不是覆盖）----
    existing: dict[str, dict] = {}
    if os.path.exists(target_path):
        with open(target_path, encoding="utf-8") as fh:
            fc = json.load(fh)
        for f in fc.get("features") or []:
            oid = (f.get("properties") or {}).get("osm_id")
            if oid:
                existing[oid] = f
    n_before = len(existing)

    bbox, nx, ny = region_grid(name)
    chunks = F.chunk_bbox(bbox, nx, ny)
    print(f"\n=== 回填面层：{name} ===")
    print(f"网格   : {nx}x{ny} = {len(chunks)} 块   已有面 {n_before} 个")

    if endpoint:
        F.OVERPASS_ENDPOINTS = [u.strip() for u in endpoint.replace(",", " ").split() if u.strip()]
    print(f"端点   : {' → '.join(u.split('/')[2] for u in F.OVERPASS_ENDPOINTS)}")

    added = 0
    dup = 0
    failed: list[list[float]] = []
    t0 = time.time()

    def fetch_chunk(ch: list[float] | tuple[float, ...], idx: int, total: int, tag: str = "") -> None:
        """抓一块并把新面并入 existing。失败只记录，不抛。"""
        nonlocal added, dup
        try:
            payload = F.overpass_query(plant_way_query(tuple(ch)))  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001
            print(f"[{idx}/{total}] 失败，跳过：{exc}")
            failed.append(list(ch))
            return
        els = payload.get("elements", [])
        got = 0
        for el in els:
            feat = F.build_feature(el, "plant_area")
            if not feat:
                continue
            oid = feat["properties"]["osm_id"]
            if oid in existing:
                dup += 1
                continue
            existing[oid] = feat
            added += 1
            got += 1
        print(
            f"[{idx}/{total}]{tag} 返回 {len(els):5d} 条，新增面 {got:5d}   （累计 {len(existing)}）"
        )

    # ---- 周期性落盘（checkpoint）----
    # 🔴 为什么必须有：原来只在**区域跑完**才写文件，而一个区域要 1~2.5 小时。
    #    2026-09-27 真实事故：xinan 跑完 216/216 块（5255 个面）后因一行日志崩溃，
    #    产物**根本没写** ⇒ 110 分钟全废。后来又因重启丢了 7 块的在途数据。
    #    ⇒ 每 CHECKPOINT_EVERY 块写一次，最坏只丢最后几块。
    #    ⚠️ 这**不会**误打覆盖标记：标记只在 failed 为空时打（见下），
    #      而"跳过已完成区域"要求**标记 + 文件**同时满足 ⇒ 中途产物不会被当成完成。
    CHECKPOINT_EVERY = 10

    def save_now(tag: str) -> None:
        os.makedirs(out_dir, exist_ok=True)
        feats = list(existing.values())
        F.guard_empty_overwrite(target_path, feats, n_before)
        F.write_json_atomic(
            target_path,
            {
                "type": "FeatureCollection",
                "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
                "features": feats,
            },
        )
        print(f"    [checkpoint{tag}] 已落盘 {len(feats)} 个面")

    for idx, ch in enumerate(chunks, 1):
        before_n = len(existing)
        fetch_chunk(ch, idx, len(chunks))
        time.sleep(F.QUERY_WAIT)
        # 只在**这一块真有新增**时隔几块写一次，避免空转也写盘
        if not dry_run and (len(existing) > before_n) and idx % CHECKPOINT_EVERY == 0:
            save_now(f" {idx}/{len(chunks)}")

    # ---- 失败块**当场重试一轮** ----
    # 🔴 为什么值得单独做：失败块会让整个区域拿不到覆盖标记，而重跑本脚本会**从头再扫全区域**
    #    （去重让它便宜些，但每块仍要一次网络往返）。在同一进程里立刻补一遍最省：
    #    失败多半是 Overpass 瞬时 504，隔几秒再来往往就过了。
    #    ⚠️ 重试仍失败的会留在 `failed` 里 ⇒ 不打覆盖标记 ⇒ 下次运行再补，语义不变。
    if failed:
        n_first = len(failed)
        print(f"\n>>> 有 {n_first} 个块失败，当场重试一轮")
        to_retry = list(failed)
        failed = []
        for i, ch in enumerate(to_retry, 1):
            fetch_chunk(ch, i, n_first, tag="(重试)")
            time.sleep(F.QUERY_WAIT)
        print(f">>> 重试结束：仍失败 {len(failed)}/{n_first} 块")

    elapsed = time.time() - t0
    print(f"\n完成：新增 {added} 个面，已有 {n_before}，合计 {len(existing)}，耗时 {elapsed:.0f}s")
    # ‼️ 失败块的报告**放到落盘之后**再说（见下面）。
    #    2026-09-27 真实事故：这一行原本在这里打印 ⚠️，而 Windows 控制台是 GBK ⇒
    #    UnicodeEncodeError 直接把函数打断，**产物根本没写** ——
    #    xinan 已成功跑完 216/216 块（5255 个面），110 分钟抓取全废。
    #    教训：**任何可能抛异常的打印都不能挡在落盘前面**；提示性文字用 ASCII。

    if dry_run:
        print("[dry-run] 未写任何文件")
        return {"name": name, "added": added, "total": len(existing), "failed": len(failed)}

    # ---- 落盘（原子写 + 禁止空覆盖）----
    os.makedirs(out_dir, exist_ok=True)
    crs = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
    feats = list(existing.values())
    F.guard_empty_overwrite(target_path, feats, n_before)
    F.write_json_atomic(
        target_path, {"type": "FeatureCollection", "crs": crs, "features": feats}
    )
    print(f"→ {target_path}  ({len(feats)} 要素, {os.path.getsize(target_path)/1048576:.2f} MB)")

    # 失败块报告放在**落盘之后** —— 它是提示性文字，绝不能挡在写文件前面（见上面的教训）。
    if failed:
        print(f"! 有 {len(failed)}/{len(chunks)} 块失败 —— 不打覆盖标记，可重跑本脚本续补")

    # ---- 覆盖标记（零失败块才算完整）----
    cov = F.load_bucket_coverage(out_dir, name)
    if not failed:
        cov["plant_areas"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        F.save_bucket_coverage(out_dir, name, cov)
        print("→ 已打上 plant_areas 覆盖标记（本次 0 个失败块）")
    else:
        print("→ 未打覆盖标记（有失败块）")
    return {"name": name, "added": added, "total": len(feats), "failed": len(failed)}


def main() -> int:
    # 🔴 控制台编码护栏：Windows 控制台默认 GBK，任何非 GBK 字符（emoji、生僻字）
    #    在 print 时会抛 UnicodeEncodeError。对本脚本这种**跑几小时**的任务，
    #    被一行日志打断的代价是整轮抓取作废（2026-09-27 已真实发生一次）。
    #    reconfigure 让 stdout/stderr 用 UTF-8，且**永不因编码而抛**。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 老 Python 没有 reconfigure 就算了
            pass

    ap = argparse.ArgumentParser(description="阶段56-C：只补面层的定向回填")
    ap.add_argument("--regions", required=True, help="逗号分隔的区域 key")
    ap.add_argument(
        "--endpoint",
        default=(
            # ‼️ 顺序是**实测**定的（2026-09-26 22:40）：本脚本的查询很轻
            #    （只查 way[power=plant]，一块 22 条 / 66 KB），overpass-api.de 3.3s 就回；
            #    而 maps.mail.ru 对同一查询直接 504。**与主脚本的推荐顺序相反** ——
            #    主脚本要查线路（2000+ 条几何），那是把端点打爆的主因。
            "https://overpass-api.de/api/interpreter "
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
        ),
        help="覆盖端点（空格/逗号分隔可给多个）",
    )
    ap.add_argument("--dry-run", action="store_true", help="只查询不落盘")
    args = ap.parse_args()

    names = [s.strip() for s in args.regions.split(",") if s.strip()]
    results = []
    for n in names:
        try:
            results.append(backfill_region(n, args.endpoint, args.dry_run))
        except Exception as exc:  # noqa: BLE001
            print(f"[X] {n} 回填失败：{exc}")
            results.append({"name": n, "error": str(exc)})

    print("\n=== 汇总 ===")
    for r in results:
        if "error" in r:
            print(f"  {r['name']:14s} 失败：{r['error'][:80]}")
        else:
            print(
                f"  {r['name']:14s} 新增 {r['added']:5d}  合计 {r['total']:6d}  失败块 {r['failed']}"
            )
    return 0 if all("error" not in r for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
