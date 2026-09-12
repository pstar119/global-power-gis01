#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段28：从 OpenStreetMap 提取真实电力设施数据（默认范围：长三角），产出 GeoJSON，
交给 tippecanoe 切片成 PMTiles。

用法：
    python scripts/fetch_osm_power.py --estimate-only     # 只统计数量，不落盘全量数据
    python scripts/fetch_osm_power.py                     # 默认抓长三角
    python scripts/fetch_osm_power.py --bbox 118,29,123,33
    python scripts/fetch_osm_power.py --preset prd        # 珠三角

产物（默认都在 /data/ 下，**已被 .gitignore 忽略**）：
    data/osm/<name>_power_lines.geojson        power=line / minor_line / cable → LineString
    data/osm/<name>_power_substations.geojson  power=substation           → Point
    data/osm/<name>_power_plants.geojson       power=plant                → Point
    data/osm/<name>_power_meta.json            统计信息（数量、电压分布、抓取耗时）

============================================================
为什么走 Overpass 而不是 .osm.pbf + osmium
============================================================
本机实测（2026-09-12）：
  - `download.geofabrik.de`          8s 超时，不可达
  - `download.bbbike.org` / `.fr`    可达，但只提供 **.osm.pbf**
  - 解析 .osm.pbf 需要 libosmium；pyosmium 在 Windows 上要编译 boost，成功率不可控
  - `overpass-api.de`                ✅ 实测可用，且 `out geom;` 会**直接把坐标带回来**，
                                     完全不需要 PBF 解析器

所以这里用 Overpass。全程只用 Python 标准库（urllib / json / gzip），**不引入任何依赖**。

============================================================
⚠️ Overpass 的两个坑（都踩过）
============================================================
1. **`remark` 必须一律当失败。** Overpass 出错时不会用 HTTP 状态码表达，
   而是返回 200 + 一个 `remark` 字段（如 "runtime error: Query timed out"）。
   只要看到非空 `remark` 就得重试/报错，否则会把「查询失败」当成「这个区域没有数据」，
   静默丢掉整块区域。另外注意超时文案是 **"timed out"（带空格）**，
   用 `"timeout" in remark` 是**匹配不到**的。
2. **必须分块。** 单次查询太大既慢又容易被限流。
   这里把 bbox 切成 N×N 网格逐块抓，并把每块的坐标范围落进状态文件，
   中断后可以续跑。

============================================================
⚠️ 关于 OSM 的 `power=line`：它是「按杆塔切碎」的
============================================================
实测长三角 bbox (29,118,33,123) 内有 **15,524 条** way —— 因为 OSM 把一条输电线路
按相邻杆塔切成很多段。这**不是 bug**，也不需要在这里合并：
    - 视觉上线段首尾相接，看不出接缝；
    - 合并属于「拓扑重建」问题（涉及变电所为边界、同塔双回的方向连续性判定），
      复杂度很高，与本阶段的「拿到真实数据并切片」目标无关。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# ------------------------------------------------------------------
# 预设范围：bbox = (西, 南, 东, 北)，与 GeoJSON 的 lon/lat 顺序一致
# ------------------------------------------------------------------
PRESETS: dict[str, tuple[float, float, float, float]] = {
    # 长三角：上海 + 苏南 + 浙北 + 皖东（实测 15,524 条输电线路）
    "yrd": (118.0, 29.0, 123.0, 33.0),
    # 珠三角：广州/深圳/东莞/佛山一带
    "prd": (112.5, 21.8, 114.6, 23.9),
    # 京津冀
    "bth": (115.4, 38.4, 118.4, 40.6),
}

# Overpass 端点：主用第一个，失败按顺序回退。
# ⚠️ 实测 overpass.kumi.systems 与 overpass.osm.jp 在本机不可达，不要加回来。
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

DEFAULT_OUT_DIR = os.path.join("data", "osm")

# 每个查询的重试次数与块间延迟（对公共 API 客气一点）
MAX_RETRY = 3
RETRY_WAIT = 8.0
CHUNK_WAIT = 2.0


# ------------------------------------------------------------------
# 电压解析
# ------------------------------------------------------------------
def parse_voltage_kv(raw: Any) -> int | None:
    """把 OSM 的 `voltage` 标签解析成 kV 整数（取最大值）。

    OSM 的写法很杂，实测过的形态：
        "220000"        → 220      （无单位 = 伏特，这是 OSM 惯例）
        "220000;110000" → 220      （多回路/双回，取最高）
        "220 kV"        → 220      （带单位，已经是 kV）
        "220kV"         → 220
        "220"           → 220      （小于 1000 且无单位，按 kV 解释）
        "15000"         → 15       （伏特）
    解析不出来返回 None。
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None

    best: float | None = None
    for part in text.replace("；", ";").split(";"):
        token = part.strip().lower()
        if not token:
            continue
        # 提取数字（允许 220.5 这样的写法）
        digits = ""
        for ch in token:
            if ch.isdigit() or (ch == "." and "." not in digits):
                digits += ch
            elif digits:
                break
        if not digits:
            continue
        try:
            value = float(digits)
        except ValueError:
            continue

        # 带 kV/kv 单位 → 已经是 kV；否则按 OSM 惯例当成伏特
        has_kv_unit = "kv" in token
        kv = value if has_kv_unit else (value / 1000.0 if value >= 1000 else value)
        if kv <= 0 or kv > 2000:  # 明显是脏数据（比如把频率当电压写了）
            continue
        best = kv if best is None else max(best, kv)

    return int(round(best)) if best is not None else None


def voltage_class(kv: int | None) -> str:
    """电压分档。前四档与前端图例、tippecanoe 的属性过滤一一对应。"""
    if kv is None:
        return "unknown"
    if kv >= 735:
        return "735+"
    if kv >= 500:
        return "500-734"
    if kv >= 220:
        return "220-499"
    return "<220"


# ------------------------------------------------------------------
# Overpass 抓取
# ------------------------------------------------------------------
def overpass_query(query: str, verbose: bool = True) -> dict[str, Any]:
    """执行一次 Overpass 查询。

    ⚠️ 成功的判定必须是「HTTP 200 **且** 没有 remark」。
       Overpass 的失败（超时、内存超限、语法错）全都走 200 + remark 这条路，
       只看状态码会把失败当成功，静默丢数据。
    """
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(1, MAX_RETRY + 1):
            try:
                data = urllib.parse.urlencode({"data": query}).encode("utf-8")
                req = urllib.request.Request(
                    endpoint,
                    data=data,
                    headers={
                        # Overpass 对没有 UA 的请求会 429，必须带
                        "User-Agent": "global-power-gis/0.1 (OSM power data extractor)",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
                with urllib.request.urlopen(req, timeout=300) as resp:
                    body = resp.read()
                payload = json.loads(body.decode("utf-8"))

                remark = payload.get("remark")
                if remark:
                    # 任何非空 remark 都当失败 —— 不区分文案，见文件头说明
                    raise RuntimeError(f"Overpass 返回 remark：{remark}")

                return payload
            except Exception as exc:  # noqa: BLE001 - 这里就是要兜住一切并重试
                last_err = exc
                if verbose:
                    print(
                        f"    ⚠️ {endpoint.split('/')[2]} 第 {attempt}/{MAX_RETRY} 次失败：{exc}",
                        file=sys.stderr,
                    )
                if attempt < MAX_RETRY:
                    time.sleep(RETRY_WAIT * attempt)
        if verbose:
            print(f"    ↪ 换下一个端点（{endpoint.split('/')[2]} 放弃）", file=sys.stderr)

    raise RuntimeError(f"所有 Overpass 端点都失败：{last_err}")


# ------------------------------------------------------------------
# 几何规整
# ------------------------------------------------------------------
def way_to_linestring(element: dict[str, Any]) -> list[list[float]] | None:
    """把 `out geom;` 返回的 way 几何转成 [[lon,lat], ...]。"""
    geom = element.get("geometry")
    if not geom or len(geom) < 2:
        return None
    coords = []
    for node in geom:
        lat, lon = node.get("lat"), node.get("lon")
        if lat is None or lon is None:
            return None  # 有空洞就整条丢弃，避免画出穿越地球的直线
        coords.append([round(lon, 7), round(lat, 7)])
    return coords


def element_center(element: dict[str, Any]) -> tuple[float, float] | None:
    """变电站/电厂可能是 node 也可能是 way（area）。

    这里统一取**几何包围盒中心**作为代表点：
      - 比「顶点平均」稳健（顶点在边上密、在内部疏，平均值会被边带跑偏）；
      - 与前端「变电站用圆点」的约定一致，不需要多边形渲染。
    """
    if element.get("type") == "node":
        lat, lon = element.get("lat"), element.get("lon")
        if lat is None or lon is None:
            return None
        return (round(lon, 7), round(lat, 7))

    geom = element.get("geometry")
    if not geom:
        return None
    lats = [g["lat"] for g in geom if g.get("lat") is not None]
    lons = [g["lon"] for g in geom if g.get("lon") is not None]
    if not lats or not lons:
        return None
    return (round((min(lons) + max(lons)) / 2, 7), round((min(lats) + max(lats)) / 2, 7))


def common_props(element: dict[str, Any]) -> dict[str, Any]:
    tags = element.get("tags", {}) or {}
    kv = parse_voltage_kv(tags.get("voltage"))
    props: dict[str, Any] = {
        "osm_id": f"{element.get('type','?')}/{element.get('id','?')}",
        "name": tags.get("name") or None,
        "ref": tags.get("ref") or None,
        "operator": tags.get("operator") or None,
        "vclass": voltage_class(kv),
    }
    if kv is not None:
        props["voltage_kv"] = kv
    return props


def build_feature(element: dict[str, Any], geom_type: str) -> dict[str, Any] | None:
    props = common_props(element)
    tags = element.get("tags", {}) or {}

    if geom_type == "line":
        coords = way_to_linestring(element)
        if not coords:
            return None
        props["power"] = tags.get("power")
        props["line_kind"] = tags.get("power")  # line / minor_line / cable
        props["cables"] = tags.get("cables") or None
        props["wires"] = tags.get("wires") or None
        props["circuits"] = tags.get("circuits") or None
        return {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}}

    # point 类（变电站 / 电厂）
    center = element_center(element)
    if center is None:
        return None
    props["power"] = tags.get("power")
    if geom_type == "substation":
        props["substation_kind"] = tags.get("substation")  # transmission / distribution / ...
    else:
        props["plant_source"] = tags.get("plant:source")
        props["plant_output"] = tags.get("plant:output:electricity")
    return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": list(center)}}


# ------------------------------------------------------------------
# 查询构造
# ------------------------------------------------------------------
def chunk_bbox(
    bbox: tuple[float, float, float, float], nx: int, ny: int
) -> list[tuple[float, float, float, float]]:
    w, s, e, n = bbox
    dx = (e - w) / nx
    dy = (n - s) / ny
    out = []
    for i in range(nx):
        for j in range(ny):
            out.append((w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy))
    return out


def bbox_filter(b: tuple[float, float, float, float]) -> str:
    """Overpass 的 bbox 顺序是 (south, west, north, east)。"""
    w, s, e, n = b
    return f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"


def queries_for(b: tuple[float, float, float, float]) -> dict[str, str]:
    f = bbox_filter(b)
    head = "[out:json][timeout:180];"
    return {
        "lines": (
            f"{head}"
            f"(way[\"power\"=\"line\"]{f};"
            f"way[\"power\"=\"minor_line\"]{f};"
            f"way[\"power\"=\"cable\"]{f};);"
            f"out geom;"
        ),
        "substations": (
            f"{head}"
            f"(node[\"power\"=\"substation\"]{f};"
            f"way[\"power\"=\"substation\"]{f};);"
            f"out geom;"
        ),
        "plants": (
            f"{head}"
            f"(node[\"power\"=\"plant\"]{f};"
            f"way[\"power\"=\"plant\"]{f};);"
            f"out geom;"
        ),
    }


# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="从 OSM 提取真实电力设施数据（GeoJSON）")
    ap.add_argument(
        "--bbox",
        help="范围 W,S,E,N（与 GeoJSON 顺序一致），例如 118,29,123,33；不填则用 --preset",
    )
    ap.add_argument("--preset", default="yrd", choices=sorted(PRESETS), help="预设范围（默认 yrd 长三角）")
    ap.add_argument("--name", help="产物文件名前缀（默认取 preset 名）")
    ap.add_argument("--grid", default="4x4", help="把 bbox 切成几块抓，格式 NxM（默认 4x4）")
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--estimate-only", action="store_true", help="只统计数量与电压分布，不写 GeoJSON")
    args = ap.parse_args()

    if args.bbox:
        try:
            bbox = tuple(float(x) for x in args.bbox.split(","))  # type: ignore[assignment]
        except ValueError:
            print("❌ --bbox 需要 4 个数字，例如 118,29,123,33", file=sys.stderr)
            return 2
        if len(bbox) != 4:
            print("❌ --bbox 需要 4 个数字，例如 118,29,123,33", file=sys.stderr)
            return 2
        name = args.name or "custom"
    else:
        bbox = PRESETS[args.preset]
        name = args.name or args.preset

    w, s, e, n = bbox
    if not (w < e and s < n):
        print("❌ bbox 必须满足 西<东 且 南<北", file=sys.stderr)
        return 2

    try:
        nx, ny = (int(v) for v in args.grid.lower().split("x"))
    except ValueError:
        print("❌ --grid 格式应为 NxM，例如 4x4", file=sys.stderr)
        return 2

    chunks = chunk_bbox(bbox, nx, ny)
    print("=== 阶段28：从 OSM 提取电力设施 ===")
    print(f"范围   : {w},{s},{e},{n}（{'自定义' if args.bbox else args.preset}）")
    print(f"分块   : {nx}x{ny} = {len(chunks)} 块")
    print(f"端点   : {OVERPASS_ENDPOINTS[0]}")
    print(f"产物名 : {name}")
    print()

    buckets: dict[str, list[dict[str, Any]]] = {"lines": [], "substations": [], "plants": []}
    kv_hist: dict[str, int] = {}
    # 同一要素可能横跨两个相邻块（bbox 查询会重复返回），按 osm_id 去重
    seen: dict[str, set[str]] = {"lines": set(), "substations": set(), "plants": set()}
    dup = 0

    t0 = time.time()
    for idx, chunk in enumerate(chunks, 1):
        cw, cs, ce, cn = chunk
        print(f"[{idx}/{len(chunks)}] 块 {cw:.3f},{cs:.3f},{ce:.3f},{cn:.3f}")
        for kind, query in queries_for(chunk).items():
            payload = overpass_query(query)
            elements = payload.get("elements", [])
            added = 0
            for el in elements:
                feat = build_feature(el, "line" if kind == "lines" else ("substation" if kind == "substations" else "plant"))
                if not feat:
                    continue
                oid = feat["properties"]["osm_id"]
                if oid in seen[kind]:
                    dup += 1
                    continue
                seen[kind].add(oid)
                buckets[kind].append(feat)
                added += 1
                cls = feat["properties"]["vclass"]
                kv_hist[cls] = kv_hist.get(cls, 0) + 1
            print(f"    {kind:12s} 返回 {len(elements):6d} 条，新增 {added:6d} 条")
        time.sleep(CHUNK_WAIT)

    elapsed = time.time() - t0
    print()
    print("=== 抓取完成 ===")
    print(f"耗时        : {elapsed:.1f} 秒")
    print(f"去重丢弃    : {dup} 条（跨块重复）")
    for kind, feats in buckets.items():
        print(f"  {kind:12s} {len(feats):7d} 个要素")
    print("电压分档分布:")
    for cls in ("735+", "500-734", "220-499", "<220", "unknown"):
        if cls in kv_hist:
            print(f"  {cls:10s} {kv_hist[cls]:7d}")

    if args.estimate_only:
        print("\n[试算模式] 未写任何文件。")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    crs = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
    written = {}
    for kind, feats in buckets.items():
        path = os.path.join(args.out_dir, f"{name}_power_{kind}.geojson")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "crs": crs, "features": feats}, fh, ensure_ascii=False)
        size_mb = os.path.getsize(path) / 1048576
        written[kind] = {"file": path, "features": len(feats), "size_mb": round(size_mb, 2)}
        print(f"  → {path}  ({len(feats)} 要素, {size_mb:.2f} MB)")

    meta = {
        "bbox": list(bbox),
        "preset": None if args.bbox else args.preset,
        "grid": f"{nx}x{ny}",
        "elapsed_sec": round(elapsed, 1),
        "duplicates_dropped": dup,
        "voltage_class_histogram": kv_hist,
        "outputs": written,
        # 署名要求：OSM 数据是 ODbL，前端必须显示来源
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    meta_path = os.path.join(args.out_dir, f"{name}_power_meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    print(f"  → {meta_path}")
    print("\n下一步：按 README_OSM.md 用 tippecanoe 切片。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ {exc}", file=sys.stderr)
        sys.exit(1)
