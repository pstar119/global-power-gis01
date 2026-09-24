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

阶段56-A2 新增**补抓通道**（`--category converters`，不重跑上面那 3 类）：
    data/osm/<name>_power_converters.geojson   power=converter（node+way）→ Point
    data/osm/<name>_dc_tags.json               way_id → frequency 映射（直流/交流的唯一硬信号）
    data/osm/<name>_converters_meta.json       本通道的统计（块数、覆盖、失败块）

⚠️ 为什么补抓要单独走一条通道：A1 的中间产物里**没有** frequency（属性表里根本没这个键），
   而 `power=converter` 也不在原来的三类查询里 ⇒ 直流/交流无法从既有数据推出（设计 §2.4）。
   重跑 238 块去补这两个**结果集极小**的类别是浪费；本通道按 bbox 分块、单独断点、
   单独产物，与 power 的断点/产物**完全隔离**（改坏了也污染不到已有的三类数据）。

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

# Overpass 端点：按顺序尝试，失败自动切换。
#
# ⚠️ 2026-09-12 用 scripts/probe_overpass.py 实测（真实查询：苏州 31.1,120.4,31.5,120.9）：
#   ✅ maps.mail.ru         24.1s  返回 362 条  ← 数据正确且稳定，所以放在**第一位**
#   ⚠️ overpass-api.de      12.6s  但密集返回 504，退避重试会把每块拖到 4-5 分钟，只做备选
#   ❌ overpass.private.coffee  93s 读超时，基本不可用
#   ❌ overpass.osm.ch       1.4s 但返回 0 条 —— 它是**瑞士专用**实例，对中国数据无效，
#                              别被它的速度骗了（这正是「快 ≠ 可用」的例子）
#   ❌ overpass.openstreetmap.ru / kumi.systems / osm.jp  本机不可达，不要再加回来
OVERPASS_ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

DEFAULT_OUT_DIR = os.path.join("data", "osm")

# 重试与礼貌间隔。
# ⚠️ 实测教训（2026-09-12）：原来同一块内的 3 个查询是**背靠背发出**的，
#    几乎立刻就被 overpass-api.de 回 429 Too Many Requests；而 429 又触发退避重试，
#    8s+16s 耗掉之后换备用端点，速度反而更慢。所以块内查询之间必须也留间隔。
MAX_RETRY = 4
RETRY_WAIT = 10.0
QUERY_WAIT = 6.0
CHUNK_WAIT = 2.0


# ------------------------------------------------------------------
# 抓取类别（阶段43）
# ------------------------------------------------------------------
# 阶段28~42 只有电力一条路。阶段43 增加铁路与管道两类基础设施。
# 阶段56-A1（2026-09-24）：**铁路与油气管道已整体撤销**（用户决定只做电力）。
#    撤销必须彻底：类别表、查询构造、要素构造一并删除，不留"留着不用"的死代码 ——
#    那种代码会让后来者以为还在抓，而 `--category rail` 一旦还能用就说明没删干净。
#    注意：铁路/管道的抓取产物（`data/osm/` 下的 `*_rail` / `*_pipeline`）**不参与**归档制备，
#    因为它们在 prepare 阶段才被合并；**本脚本不需要重抓**（见 A1 计划的实测依据）。
#
# ⚠️ `kind` 是产出文件的桶名，`ftype` 是写进 GeoJSON 的判别字段（前端按它分图层）。
#    电力必须沿用历史的 lines/substations/plants 桶名 ——
#    改了会与已在 data/osm/ 的 7 个区域产物、以及 *progress.json 断点文件对不上，
#    后果是全部重抓或覆盖失败。
POWER_KIND_TO_FTYPE = {"lines": "line", "substations": "substation", "plants": "plant", "converters": "converter"}
CATEGORY_KINDS: dict[str, list[str]] = {
    "power": ["lines", "substations", "plants"],
    # 阶段56-A2：补抓通道。只有一个"桶"，但一条 union 查询同时取两类东西：
    #   · power=converter（node+way）→ 进 converters 桶（换流站点层）
    #   · 带 frequency 标签的电力 way → 不进桶，收进 <name>_dc_tags.json 的映射
    # 主循环按 `power` 标签把两者分开（见 `add_dc_tag`）。
    "converters": ["converters"],
}
CATEGORY_LABEL = {"power": "电力设施", "converters": "换流站 + 直流标签（补抓）"}


def ftype_of(kind: str) -> str:
    return POWER_KIND_TO_FTYPE.get(kind, kind)


def geom_path(out_dir: str, name: str, category: str, kind: str) -> str:
    """产物路径。

    · power      → `<name>_power_<kind>.geojson`（历史产物不能改名）
    · converters → `<name>_power_converters.geojson`
      ‼️ 虽然它是**独立类别**（补抓通道），文件名仍带 `_power_` 前缀：
         换流站在归档里是电力要素的一员（设计 §4.1 的 ftype=converter），
         叫 `<name>_converters.geojson` 会让人以为它是另一套数据源。
         断点与 meta 才按类别隔离（见 `progress_path` / `meta_path`）。
    """
    if category in ("power", "converters"):
        return os.path.join(out_dir, f"{name}_power_{kind}.geojson")
    return os.path.join(out_dir, f"{name}_{category}.geojson")


def dc_tags_path(out_dir: str, name: str) -> str:
    """`way_id → frequency` 映射的产物路径。

    为什么单独一个文件而不是塞进 GeoJSON 属性：MVT **不支持数组属性**，
    而这些标签本来就不属于"要素"，它是**线路的属性补丁** ——
    prepare 阶段按 way_id 合并回线路要素（设计 §3.2）。
    """
    return os.path.join(out_dir, f"{name}_dc_tags.json")


def meta_path(out_dir: str, name: str, category: str = "power") -> str:
    """meta 路径。‼️ 按类别分开命名（历史教训：不同类别共用 `<name>_power_meta.json`
    时后者会直接覆盖前者的 bbox / 要素数 / 电压直方图 —— 那属于静默丢数据）。
    阶段56-A1 起只剩 power 一类，但保留按类别命名的能力：将来若再加类别，
    这条隔离规则必须已经在那儿。"""
    if category == "power":
        return os.path.join(out_dir, f"{name}_power_meta.json")
    return os.path.join(out_dir, f"{name}_{category}_meta.json")


def write_json_atomic(path: str, payload: Any, indent: int | None = None) -> None:
    """原子写 JSON：先写同目录临时文件，再 `os.replace` 替换。

    🔴 为什么必须这么做（阶段43 真实事故，不是理论风险）：
       `open(path, "w")` 会**先把文件截断**再写。25 MB 的产物要写几百毫秒，
       如果进程在这个窗口里被杀（Ctrl-C、管道下游提前退出、关机），
       结果是一个**被截断的非法 JSON**，而原数据已经没了。
       更糟的是下一次运行会把「解析失败」当成「没有数据」，
       然后把空结果写回去 —— 静默丢数据，而且 progress 仍写着「已完成」，
       重跑也不会重抓。
       `os.replace` 在同卷上是原子的：要么是旧文件，要么是完整的新文件，没有中间态。

    ⚠️ 为什么用同目录的 `.tmp` 而不是系统临时目录：`os.replace` 要求同卷才能保证原子性。
    """
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=indent)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


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
def is_hopeless_error(exc: BaseException) -> bool:
    """这次失败**重试也不会好**吗？（用于跳过退避，直接换端点）

    🔴 2026-09-24 实测教训：本机对 `maps.mail.ru` 的 TLS 握手返回
    `CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain`
    （疑似链路上有中间设备），而**这个错误每次重试都一模一样** ——
    原来的实现仍会老老实实退避 10+20+30 秒再放弃，等于每块白等 60 秒。
    补抓 100+ 块就是 1 个多小时的纯浪费，而且日志里只有一行 WARNING，很容易被当成"网络慢"。

    ⚠️ 判据要窄：只认**确定性**的 TLS/DNS 类错误。429/504/超时都不能算
    （那些正是退避重试要解决的）。
    """
    text = f"{type(exc).__name__}: {exc}"
    for marker in (
        "CERTIFICATE_VERIFY_FAILED",
        "SSLCertVerificationError",
        "certificate verify failed",
        "Name or service not known",
        "getaddrinfo failed",
        "nodename nor servname provided",
    ):
        if marker in text:
            return True
    return False


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
                # timeout 原来给 300s：一旦对端卡住，一个请求就能把整轮拖死。
                # 宁可快速失败再重试，也不要挂在一次连接上。
                with urllib.request.urlopen(req, timeout=120) as resp:
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
                    wait = RETRY_WAIT * attempt
                    # 429 是限流，短退避根本没有意义，要等够；504 是服务端过载，普通退避即可
                    if "429" in str(exc):
                        wait = max(wait, 30.0)
                    time.sleep(wait)
                if is_hopeless_error(exc):
                    # 重试不会好的错误（TLS/DNS）⇒ 立刻放弃这个端点，别白等退避
                    if verbose:
                        print(
                            f"    ↪ {endpoint.split('/')[2]} 的错误重试也不会好（{type(exc).__name__}），"
                            f"跳过退避直接换端点",
                            file=sys.stderr,
                        )
                    break
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
        # 阶段56-A1：新增采集 frequency。它是"直流/交流"唯一的硬信号
        # （`frequency=0` ⇒ 直流）。本计划内**不重抓**，所以这一轮产物里不会有它；
        # 直交流分档属 A2，届时要靠这次留下的能力补齐。
        props["frequency"] = tags.get("frequency") or None
        return {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}}

    if geom_type == "converter":
        # ‼️ 本类别的查询是 **union**（换流站 + 带 frequency 的 way 一起取，省一半查询）。
        #    所以这里必须**只认 power=converter**：其余元素（只有 frequency 的线路）
        #    由主循环交给 `add_dc_tag` 收进映射表。少了这道判断，几千条线路会被
        #    当成"换流站"写进点层 —— 而且不报错，只有数量对不上时才发现。
        if tags.get("power") != "converter":
            return None
        center = element_center(element)
        if center is None:
            return None
        props["power"] = tags.get("power")
        return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": list(center)}}

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


def sample_chunks(
    chunks: list[tuple[float, float, float, float]], nx: int, ny: int, step: int
) -> list[tuple[float, float, float, float]]:
    """按 step 抽样：只保留每 step 列/行交叉处的格子。**块尺寸不变**。

    ⚠️ 为什么要抽样而不是把块放大：Overpass 单次查询上限 180s，
       块越大越容易撞上限；一旦超时就会被记成失败块，
       于是「扫描」反而变成了不可靠的测量。保持同尺寸、只减数量才可控。
    """
    if step <= 1:
        return chunks
    out = []
    idx = 0
    for i in range(nx):
        for j in range(ny):
            if i % step == 0 and j % step == 0:
                out.append(chunks[idx])
            idx += 1
    return out


def bbox_filter(b: tuple[float, float, float, float]) -> str:
    """Overpass 的 bbox 顺序是 (south, west, north, east)。"""
    w, s, e, n = b
    return f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"


def queries_for(
    b: tuple[float, float, float, float], count_only: bool = False, category: str = "power"
) -> dict[str, str]:
    f = bbox_filter(b)
    head = "[out:json][timeout:180];"
    # ⚠️ 实测教训（2026-09-13）：`--estimate-only` **不是**廉价探针 —— 它内部仍是 `out geom;`，
    #    要拉全量几何，单块成本与真抓一模一样（实测 44.0 秒/块）。
    #    `out count;` 省的是**响应体大小**（只回一个数字）。
    #    ⚠️ 但它**不省 Overpass 的空间检索**，所以单块耗时未必显著下降，
    #       具体倍数以 scripts/measure_count_cost.py 的实测为准，不要凭想象断言。
    tail = "out count;" if count_only else "out geom;"

    if category == "converters":
        # 阶段56-A2 补抓通道：**一条 union 查询同时取两类**。
        #
        #   · `power=converter`（node + way）—— 换流站，直流识别的关键锚点；
        #   · `way[power][frequency]`        —— 有频率标签的电力 way（`frequency=0` ⇒ 直流）。
        #
        # 🔴 为什么并成一条：两者的结果集都很小（探测：长三角 5°×4° 内换流站 4 个、
        #    frequency 覆盖 11.19%），而 Overpass 的成本**主要是空间检索**而不是返回体 ——
        #    拆成两条查询等于把同一片区域检索两遍（实测每块每多一条查询就多一次
        #    完整往返 + 一次块内限流间隔）。合并后每块只有 1 次往返。
        #
        # ⚠️ 代价：union 里只要有一部分超时，整块都失败（两部分一起丢）。
        #    所以分块必须比"抓全量电力"更粗……但也不能太粗：设计 §7 实测
        #    **大 bbox 必然被 504/读超时打回**（华东全域失败，退到单块 ~5°×4° 才成功）。
        #    分块尺寸由调用方按 ~5°×4° 给出（见 docs 的阶段记录）。
        return {
            "converters": (
                f"{head}"
                f"(node[\"power\"=\"converter\"]{f};"
                f"way[\"power\"=\"converter\"]{f};"
                f"way[\"power\"][\"frequency\"]{f};);"
                f"{tail}"
            ),
        }

    return {
        "lines": (
            f"{head}"
            f"(way[\"power\"=\"line\"]{f};"
            f"way[\"power\"=\"minor_line\"]{f};"
            f"way[\"power\"=\"cable\"]{f};);"
            f"{tail}"
        ),
        "substations": (
            f"{head}"
            f"(node[\"power\"=\"substation\"]{f};"
            f"way[\"power\"=\"substation\"]{f};);"
            f"{tail}"
        ),
        "plants": (
            f"{head}"
            f"(node[\"power\"=\"plant\"]{f};"
            f"way[\"power\"=\"plant\"]{f};);"
            f"{tail}"
        ),
    }


def count_from_payload(payload: dict[str, Any]) -> int | None:
    """从 `out count;` 的返回体里取数量；**取不到返回 None**。

    结构与正常 out 不同：是一个 `type=count` 的元素，数量在 `tags.total`（还有分开的 ways/nodes）。
    返回 None 而不是 0 是关键 —— 调用方必须能区分「真的 0 条」与「接口异常」，
    否则会把异常静默当成「这块没数据」，那正是历史上丢数据的那个坑。
    """
    for el in payload.get("elements", []):
        if el.get("type") == "count":
            tags = el.get("tags") or {}
            try:
                return int(tags.get("total", 0))
            except (TypeError, ValueError):
                return None
    return None


# ------------------------------------------------------------------
# 廉价覆盖度扫描（--count-only）
# 产物与真抓**完全隔离**：不写 _power_*.geojson，也不碰 _progress.json。
# 否则扫描会把格子标成「已抓完」，真抓时就被静默跳过了。
# ------------------------------------------------------------------
def scan_path(out_dir: str, name: str, category: str = "power") -> str:
    suffix = "" if category == "power" else f"_{category}"
    return os.path.join(out_dir, f"scan_{name}{suffix}.json")


def load_scan(path: str) -> dict[str, dict[str, int]]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        cells = data.get("cells") or {}
        return {k: v for k, v in cells.items()}
    except Exception:  # noqa: BLE001 - 扫描结果坏了就重扫，代价很小
        return {}


def save_scan(
    path: str,
    bbox: tuple[float, float, float, float],
    grid: str,
    cells: dict[str, dict[str, int | None]],
    kinds: list[str] | None = None,
) -> None:
    kinds = kinds or CATEGORY_KINDS["power"]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    totals = {k: 0 for k in kinds}
    anomalies = 0
    for v in cells.values():
        bad = False
        for k in totals:
            n = v.get(k)
            if n is None:
                bad = True
            else:
                totals[k] += int(n)
        if bad:
            anomalies += 1

    def cell_sum(v: dict[str, int | None]) -> int:
        return sum(int(v.get(k) or 0) for k in totals)

    empty = sum(1 for v in cells.values() if cell_sum(v) == 0 and not any(v.get(k) is None for k in totals))
    write_json_atomic(
        path,
        {
            "bbox": list(bbox),
            "grid": grid,
            "scanned": len(cells),
            "empty": empty,
            "anomalies": anomalies,
            "totals": totals,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "note": (
                "由 --count-only 生成（out count 只回数量）。与真抓断点隔离，不要用做续抓依据。"
                " null = 解析不到数量（异常），**不等于 0**；只有显式 0 才是真空块。"
            ),
            "cells": cells,
        },
        indent=2,
    )


def run_count_scan(
    out_dir: str,
    name: str,
    bbox: tuple[float, float, float, float],
    grid: str,
    chunks: list[tuple[float, float, float, float]],
    restart: bool,
    category: str = "power",
) -> int:
    kinds = CATEGORY_KINDS[category]
    path = scan_path(out_dir, name, category)
    cells = {} if restart else load_scan(path)
    if cells:
        print(f"断点续扫：已有 {len(cells)} 块结果，跳过重扫\n")
    print(f"=== 覆盖度扫描（out count，只回数量）: {name} / {CATEGORY_LABEL.get(category, category)} ===")
    print(f"分块   : {len(chunks)} 块 → {path}\n")

    t0 = time.time()
    done_now = 0
    for idx, chunk in enumerate(chunks, 1):
        cw, cs, ce, cn = chunk
        kkey = f"{cw:.6f},{cs:.6f},{ce:.6f},{cn:.6f}"
        if kkey in cells:
            continue
        rec: dict[str, int | None] = {}
        for kind, query in queries_for(chunk, count_only=True, category=category).items():
            try:
                payload = overpass_query(query, verbose=False)
                rec[kind] = count_from_payload(payload)
            except Exception as exc:  # noqa: BLE001
                # ⚠️ 单块失败绝不能中断整场扫描：一次网络抖动就丢掉后面几千块的代价太大。
                #    记 None（= 未知），绝不能记 0（= 空区域）。
                rec[kind] = None
                print(f"    ⚠️ {kind} 查询失败，记作未知：{exc}")
            time.sleep(QUERY_WAIT)
        cells[kkey] = rec
        done_now += 1
        missing = [k for k, v in rec.items() if v is None]
        total = sum(int(v or 0) for v in rec.values())
        flag = "⚠️ " + "、".join(missing) + " 解析异常" if missing else ("—" if total == 0 else "·")
        detail = "  ".join(f"{k} {rec[k] if rec[k] is not None else '?':>7}" for k in kinds)
        print(f"[{idx}/{len(chunks)}] {cw:.3f},{cs:.3f},{ce:.3f},{cn:.3f}  {detail}  {flag}")
        save_scan(path, bbox, grid, cells, kinds)
        time.sleep(CHUNK_WAIT)

    elapsed = time.time() - t0
    totals = {k: 0 for k in kinds}
    anomalies = 0
    for v in cells.values():
        bad = False
        for k in totals:
            n = v.get(k)
            if n is None:
                bad = True
            else:
                totals[k] += int(n)
        if bad:
            anomalies += 1
    empty = sum(
        1
        for v in cells.values()
        if sum(int(v.get(k) or 0) for k in totals) == 0 and not any(v.get(k) is None for k in totals)
    )
    print()
    print("=== 扫描完成 ===")
    print(f"本次新增扫描 : {done_now} 块，累计 {len(cells)}/{len(chunks)}")
    print(f"耗时         : {elapsed:.1f} 秒（{elapsed / max(1, done_now):.1f} 秒/块）")
    print(f"空块         : {empty} 个（占 {empty / max(1, len(cells)) * 100:.1f}%）")
    if anomalies:
        print(f"⚠️ 解析异常块 : {anomalies} 个 —— 这些块**必须**按「数据未知」处理，不能当空块跳过")
    print("要素总数     : " + "  ".join(f"{k} {totals[k]}" for k in kinds))
    nonzero = [sum(int(v.get(k) or 0) for k in totals) for v in cells.values()]
    nonzero = [n for n in nonzero if n > 0]
    if nonzero:
        print(f"非空块均密度 : {sum(nonzero) / len(nonzero):.0f} 个要素/块（{len(nonzero)} 个非空块）")
    print(f"\n→ {path}")
    return 0


# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------
def progress_path(out_dir: str, name: str, category: str = "power") -> str:
    """断点文件。⚠️ 电力必须继续用 `<name>_progress.json`：
    已有的 7 个区域靠它判断「哪块已抓完」，改名等于让它们全部重抓。"""
    suffix = "" if category == "power" else f"_{category}"
    return os.path.join(out_dir, f"{name}{suffix}_progress.json")


def load_done_chunks(path: str) -> set[tuple[float, ...]]:
    """读取断点记录：已抓完的分块 bbox 集合。"""
    if not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return {tuple(round(float(v), 6) for v in b) for b in data.get("done", [])}
    except Exception:  # noqa: BLE001 - 断点文件坏了就当没有，重新抓
        return set()


def count_features_in(path: str) -> int:
    """产物文件里现有的要素数。
    文件不存在 -> 0（首次抓取，正常）。
    存在但读不动（被截断/非法 JSON）-> -1（**已损坏**，绝不能当成 0）。
    """
    if not os.path.exists(path):
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            feats = json.load(fh).get("features")
        return len(feats) if isinstance(feats, list) else -1
    except Exception:  # noqa: BLE001
        return -1


def guard_empty_overwrite(path: str, feats: list, preexisting: int) -> None:
    """🔴 拒绝把「非空产物」覆盖成「空产物」。

    为什么需要这道防线（阶段43 真实事故的**最后一步**）：
      链条是「写入被中断 -> 文件被截断 -> 下次运行把读不到当成没有 ->
      用空结果覆盖真数据」。前两步很难完全避免（进程随时可能被杀），
      但**最后一步是致命的，而且完全可以堵死**。
      `preexisting < 0` 表示文件已损坏 —— 那种情况更不能覆盖，
      因为一覆盖连事后抢救的机会都没了。
    """
    if feats:
        return
    if preexisting == 0:
        return  # 原本就没有产物，写个空的没问题
    detail = "已损坏/无法解析" if preexisting < 0 else f"原有 {preexisting} 个要素"
    raise RuntimeError(
        f"拒绝把非空产物覆盖成空：{path}（本次内存里 0 个要素，{detail}）。\n"
        f"    这通常意味着回读或抓取出了问题。请勿直接重试，先人工确认该文件；\n"
        f"    确实要重新抓取请加 --restart（它会重建断点与产物）。"
    )


def save_done_chunks(path: str, done: set[tuple[float, ...]]) -> None:
    write_json_atomic(
        path,
        {
            "done": [list(b) for b in sorted(done)],
            "count": len(done),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        indent=2,
    )


# ------------------------------------------------------------------
# 阶段56-A2：直流标签（`way_id → frequency`）
# ------------------------------------------------------------------
def add_dc_tag(dc_tags: dict[str, str], element: dict[str, Any]) -> bool:
    """从补抓查询的结果里挑出 `frequency` 标签，收进映射表。返回是否**新增**。

    ⚠️ 只认 way：`frequency` 是线路的属性；node 上的 frequency（如果有）没有对应的线路要素，
       收进来只会让覆盖率统计虚高。
    ⚠️ 原样保留字符串（`"0"` / `"50"` / `"16.67"`）：判定 `frequency == "0"` 是**精确比较**，
       这里做任何归一化（比如 `float()`）都会把 `"0"` 与 `"0.0"` 之类的写法悄悄分开，
       而判定逻辑在 prepare 里（设计 §4.1 第 1 步）。
    """
    if element.get("type") != "way":
        return False
    tags = element.get("tags") or {}
    if "frequency" not in tags or tags.get("frequency") is None:
        return False
    wid = f"way/{element.get('id')}"
    if wid in dc_tags:
        return False
    dc_tags[wid] = str(tags["frequency"]).strip()
    return True


def load_dc_tags(path: str) -> dict[str, str]:
    """读取已有的 `way_id → frequency` 映射（续抓时累加，而不是覆盖）。

    🔴 文件存在但读不动 = 损坏 ⇒ **响亮失败**（与 `load_checkpoints` 同一原则）：
       把损坏当成"没有旧数据"，下一次落盘就会把已有标签清空 —— 那正是阶段43 那类事故。
    """
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"直流标签回读失败：{path} 存在但无法解析（{exc}）。\n"
            f"    先人工确认该文件；确实要重抓请加 --restart（它会重建断点与产物）。"
        ) from exc
    tags = data.get("tags")
    if not isinstance(tags, dict):
        raise RuntimeError(f"直流标签回读失败：{path} 里没有 tags 映射（不是本脚本的产物）")
    return {str(k): str(v) for k, v in tags.items()}


def write_dc_tags(
    path: str,
    tags: dict[str, str],
    *,
    name: str,
    bbox: tuple[float, float, float, float],
    grid: str,
    done: int,
    total: int,
    failed_chunks: list[list[float]],
    elapsed: float,
) -> dict[str, Any]:
    """落盘 `way_id → frequency` 映射，并返回写进去的统计（供 meta 复用）。

    ‼️ `complete` / `failed_chunks` / `chunks_done` **必须写**：prepare 用这份映射判定 `is_dc`，
       而「某块没抓」与「这块里没有频率标签」在数据上长得一模一样（都只表现为"键不存在"）。
       缺了这两个字段，覆盖空洞就变成**静默的判定降级**（直流线路被当成交流，还不报错）。
    """
    hist: dict[str, int] = {}
    for v in tags.values():
        hist[v] = hist.get(v, 0) + 1
    payload = {
        "name": name,
        "bbox": list(bbox),
        "grid": grid,
        "chunks_done": done,
        "chunks_total": total,
        "complete": not failed_chunks,
        "failed_chunks": failed_chunks,
        "elapsed_sec": round(elapsed, 1),
        "count": len(tags),
        "frequency_histogram": dict(sorted(hist.items(), key=lambda kv: (-kv[1], kv[0]))),
        "note": (
            "way_id -> OSM `frequency` 标签（原样字符串）。"
            "**缺键 ≠ 交流**：缺键只表示「OSM 上没有这个标签」，覆盖率实测约 11%（设计 §7 U2），"
            "所以直流判定必须保留「默认按交流」的第三步，并且只能在 `complete=true` 时才当作覆盖完整。"
        ),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "tags": tags,
    }
    write_json_atomic(path, payload, indent=None)
    return {k: v for k, v in payload.items() if k != "tags"}


def load_checkpoints(
    out_dir: str, name: str, buckets: dict, seen: dict, category: str = "power"
) -> int:
    """把已有检查点读回内存，保证续抓时新旧数据累加而不是被覆盖。"""
    total = 0
    for kind in buckets:
        path = geom_path(out_dir, name, category, kind)
        if not os.path.exists(path):
            continue  # 首次抓取，没有旧产物，正常
        try:
            with open(path, encoding="utf-8") as fh:
                fc = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            # 🔴 阶段43 修复：原来这里是 `continue`（静默吞掉）。
            #    那个写法把「文件存在但读不动」当成了「没有旧数据」，
            #    于是主流程拿一个空 buckets 跑完（断点说已完成，全部跳过），
            #    再把空结果写回去 —— 直接把已有产物清空。实测损失过 25 MB / 7.4 万条。
            #    文件存在但解析失败 = 数据已损坏，必须**响亮失败**，绝不能继续跑。
            raise RuntimeError(
                f"断点回读失败：{path} 存在但无法解析（{exc}）。\n"
                f"    这通常意味着上次写入被中断（该文件是写坏的半成品）。\n"
                f"    请先人工确认该文件；确实要重抓请加 --restart，"
                f"    但**不要**让空结果把它覆盖掉。"
            ) from exc
        feats = fc.get("features")
        if not isinstance(feats, list):
            raise RuntimeError(f"断点回读失败：{path} 里没有 features 数组（不是合法的 FeatureCollection）")
        for feat in feats:
            oid = (feat.get("properties") or {}).get("osm_id")
            if not oid or oid in seen[kind]:
                continue
            seen[kind].add(oid)
            buckets[kind].append(feat)
            total += 1
    return total


def print_status(
    out_dir: str, name: str, chunks: list, done: set, category: str = "power"
) -> int:
    """--status：只读本地文件，不发任何网络请求。"""
    print(f"=== 抓取进度：{name} / {CATEGORY_LABEL.get(category, category)} ===")
    print(f"分块    : {len(done)}/{len(chunks)} 已完成")
    for kind in CATEGORY_KINDS[category]:
        path = geom_path(out_dir, name, category, kind)
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    n = len(json.load(fh).get("features", []))
                print(f"  {kind:12s} {n:7d} 个要素  ({os.path.getsize(path) / 1024:.0f} KB)")
            except Exception as exc:  # noqa: BLE001
                print(f"  {kind:12s} 读取失败：{exc}")
        else:
            print(f"  {kind:12s} （还没有文件）")
    if category == "converters":
        dpath = dc_tags_path(out_dir, name)
        if os.path.exists(dpath):
            try:
                with open(dpath, encoding="utf-8") as fh:
                    data = json.load(fh)
                n = len(data.get("tags") or {})
                print(
                    f"  {'dc_tags':12s} {n:7d} 个 way 带 frequency  "
                    f"({os.path.getsize(dpath) / 1024:.0f} KB，complete={data.get('complete')})"
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  {'dc_tags':12s} 读取失败：{exc}")
        else:
            print(f"  {'dc_tags':12s} （还没有文件）")
    missing = [b for b in chunks if tuple(round(v, 6) for v in b) not in done]
    if missing:
        print(f"\n还剩 {len(missing)} 块未抓。重新运行同一条命令即可**续抓**（不会重头再来）：")
        for b in missing[:20]:
            print(f"  未抓 bbox = {b[0]:.4f},{b[1]:.4f},{b[2]:.4f},{b[3]:.4f}")
    else:
        print("\n全部块已完成 ✅")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="从 OSM 提取真实电力设施数据（GeoJSON）")
    ap.add_argument(
        "--bbox",
        help="范围 W,S,E,N（与 GeoJSON 顺序一致），例如 118,29,123,33；不填则用 --preset",
    )
    ap.add_argument("--preset", default="yrd", choices=sorted(PRESETS), help="预设范围（默认 yrd 长三角）")
    ap.add_argument("--name", help="产物文件名前缀（默认取 preset 名）")
    ap.add_argument(
        "--category",
        default="power",
        choices=sorted(CATEGORY_KINDS),
        help=(
            "抓取类别：power 电力设施（线路 / 变电站 / 电厂）；"
            "converters 补抓通道（换流站 + 直流标签 frequency，不碰已有三类产物）"
        ),
    )
    ap.add_argument("--grid", default="4x4", help="把 bbox 切成几块抓，格式 NxM（默认 4x4）")
    ap.add_argument(
        "--sample-step",
        type=int,
        default=1,
        help="抽样：只抓每 N 列/行交叉处的格子（块尺寸不变；默认 1 = 全抓）",
    )
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--estimate-only", action="store_true", help="只统计数量与电压分布，不写 GeoJSON")
    ap.add_argument(
        "--count-only",
        action="store_true",
        help="覆盖度扫描：用 out count 只取每块数量。绝不写 _power_*.geojson 与断点文件",
    )
    ap.add_argument("--restart", action="store_true", help="忽略断点记录，从头重抓")
    ap.add_argument("--status", action="store_true", help="只读本地文件报告进度，不发任何网络请求")
    ap.add_argument(
        "--endpoint",
        help=(
            "覆盖 Overpass 端点（逗号或空格分隔，按顺序尝试）。"
            "不传则用文件头实测过的那张表。"
            "⚠️ 2026-09-24 实测：第一个端点 maps.mail.ru 在本机 TLS 校验失败（CERTIFICATE_VERIFY_FAILED），"
            "补抓时建议显式指定可用端点，避免每块都先撞一次失败。"
        ),
    )
    args = ap.parse_args()

    if args.endpoint:
        # 用 global 改模块级列表：`overpass_query` 直接读它（端点没有做成参数，
        # 因为脚本里所有调用点都只关心"能查到就行"）。
        global OVERPASS_ENDPOINTS
        OVERPASS_ENDPOINTS = [u.strip() for u in args.endpoint.replace(",", " ").split() if u.strip()]
        if not OVERPASS_ENDPOINTS:
            print("❌ --endpoint 不能是空值", file=sys.stderr)
            return 2

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
    total_before = len(chunks)
    chunks = sample_chunks(chunks, nx, ny, args.sample_step)
    sampled = len(chunks) != total_before
    # 扫描必须排在 --status 之前：它既不读也不写断点文件，与真抓是两条独立的路。
    if args.count_only:
        return run_count_scan(args.out_dir, name, bbox, f"{nx}x{ny}", chunks, args.restart, args.category)
    if args.status:
        return print_status(
            args.out_dir,
            name,
            chunks,
            load_done_chunks(progress_path(args.out_dir, name, args.category)),
            args.category,
        )
    print(f"=== 从 OSM 提取基础设施：{CATEGORY_LABEL.get(args.category, args.category)} ===")
    print(f"类别   : {args.category}")
    print(f"范围   : {w},{s},{e},{n}（{'自定义' if args.bbox else args.preset}）")
    if sampled:
        print(f"分块   : {nx}x{ny} = {total_before} 块，抽样 step={args.sample_step} → 实抓 {len(chunks)} 块")
        print("⚠️ 抽样模式会留下未覆盖的格子：产物不得当作完整覆盖使用。")
    else:
        print(f"分块   : {nx}x{ny} = {len(chunks)} 块")
    print(f"端点   : {' → '.join(u.split('/')[2] for u in OVERPASS_ENDPOINTS)}")
    print(f"产物名 : {name}")
    print()

    kinds = CATEGORY_KINDS[args.category]
    buckets: dict[str, list[dict[str, Any]]] = {k: [] for k in kinds}
    # 🔴 阶段43：先记下各产物**当前**的要素数（只读一次）。
    #    用于后续每一步落盘前拒绝「非空 -> 空」的覆盖。
    preexisting: dict[str, int] = {
        k: count_features_in(geom_path(args.out_dir, name, args.category, k)) for k in kinds
    }
    for k, n in preexisting.items():
        if n < 0:
            print(f"⚠️ 已有产物无法解析（可能是上次写入被中断）：{geom_path(args.out_dir, name, args.category, k)}")
            print("   → 本次会拒绝用空结果覆盖它；确定要重抓请加 --restart。")
    kv_hist: dict[str, int] = {}
    # 同一要素可能横跨两个相邻块（bbox 查询会重复返回），按 osm_id 去重
    seen: dict[str, set[str]] = {k: set() for k in kinds}
    dup = 0

    # ---- 阶段56-A2：换流站类别的第二个产物（frequency 映射）----
    # ⚠️ `--restart` 时**必须一起清空**：只清断点不清标签的话，上一次抓到的标签会
    #    与这一次的混在一起，而 `count`/`complete` 看起来仍然"正常"。
    tags_path = dc_tags_path(args.out_dir, name)
    dc_tags: dict[str, str] = {} if args.restart else load_dc_tags(tags_path)
    preexisting_tags = 0 if args.restart else len(dc_tags)
    if dc_tags:
        print(f"直流标签：回读已有 {len(dc_tags)} 个 way 的 frequency\n")

    def checkpoint() -> None:
        """
        每块结束后就落盘一次。

        ⚠️ 为什么必须这么做：公共 Overpass 在抓长三角这种大范围时，
        很可能在第 15/16 块上超时。原来只在全部块跑完后才写文件，
        一次超时就让前面几十分钟的抓取全部作废。检查点让"失败也要留下已抓到的部分"，
        再由 failed_chunks 明确标出缺口 —— **缺口必须响亮，绝不能变成静默的覆盖空洞**。
        """
        os.makedirs(args.out_dir, exist_ok=True)
        crs = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
        for kind, feats in buckets.items():
            path = geom_path(args.out_dir, name, args.category, kind)
            # ‼️ 每块都过一道「禁止空覆盖」——因为 checkpoint 发生在最终守卫**之前**，
            #    阶段43 实测：就是它先把损坏文件覆盖成了空。
            guard_empty_overwrite(path, feats, preexisting.get(kind, 0))
            write_json_atomic(path, {"type": "FeatureCollection", "crs": crs, "features": feats})
        # 直流标签与 geojson 一起落盘：它同样"丢了就白抓"，
        # 而且**丢得比 geojson 更安静**（少了键只表现为"这条线没有频率信息"）。
        if args.category == "converters":
            write_dc_tags(
                tags_path,
                dc_tags,
                name=name,
                bbox=bbox,
                grid=f"{nx}x{ny}",
                done=len(done_chunks),
                total=len(chunks),
                failed_chunks=failed_chunks,
                elapsed=time.time() - t0,
            )

    t0 = time.time()
    failed_chunks: list[list[float]] = []

    # ---- 断点续抓：已抓完的块跳过，已有检查点回读累加 ----
    # 这样随时可以关机，明天重跑同一条命令即可接着抓，而不是从头再来。
    ppath = progress_path(args.out_dir, name, args.category)
    done_chunks: set[tuple[float, ...]] = set() if args.restart else load_done_chunks(ppath)
    if done_chunks:
        os.makedirs(args.out_dir, exist_ok=True)
        restored = load_checkpoints(args.out_dir, name, buckets, seen, args.category)
        for kind in buckets:
            for f in buckets[kind]:
                cls = f["properties"].get("vclass")
                if cls:
                    kv_hist[cls] = kv_hist.get(cls, 0) + 1
        print(f"断点续抓：已完成 {len(done_chunks)}/{len(chunks)} 块，回读已有 {restored} 个要素\n")

    for idx, chunk in enumerate(chunks, 1):
        cw, cs, ce, cn = chunk
        key = tuple(round(v, 6) for v in chunk)
        if key in done_chunks:
            print(f"[{idx}/{len(chunks)}] 已完成，跳过")
            continue
        print(f"[{idx}/{len(chunks)}] 块 {cw:.3f},{cs:.3f},{ce:.3f},{cn:.3f}")
        chunk_failed = False
        try:
            for kind, query in queries_for(chunk, category=args.category).items():
                payload = overpass_query(query)
                elements = payload.get("elements", [])
                added = 0
                tag_added = 0
                for el in elements:
                    # ‼️ 补抓通道的查询是 **union**：先按 way_id 收 frequency 标签，
                    #    再交给 build_feature —— 后者只认 power=converter 的那些
                    #    （其余全返回 None，见其注释）。
                    if args.category == "converters" and add_dc_tag(dc_tags, el):
                        tag_added += 1
                    feat = build_feature(el, ftype_of(kind))
                    if not feat:
                        continue
                    oid = feat["properties"]["osm_id"]
                    if oid in seen[kind]:
                        dup += 1
                        continue
                    seen[kind].add(oid)
                    buckets[kind].append(feat)
                    added += 1
                    cls = feat["properties"].get("vclass")
                    if cls:
                        kv_hist[cls] = kv_hist.get(cls, 0) + 1
                extra = f"，frequency 标签 +{tag_added:5d}" if args.category == "converters" else ""
                print(f"    {kind:12s} 返回 {len(elements):6d} 条，新增 {added:6d} 条{extra}")
                # 块内也要歇 —— 连发是 429 的直接原因
                time.sleep(QUERY_WAIT)
        except Exception as exc:  # noqa: BLE001
            print(f"    ⚠️ 该块失败，跳过并继续：{exc}")
            failed_chunks.append(list(chunk))
            chunk_failed = True
        # 只有整块成功才记断点：失败的块下次会自动重抓
        if not chunk_failed:
            done_chunks.add(key)
            os.makedirs(args.out_dir, exist_ok=True)
            save_done_chunks(ppath, done_chunks)
        checkpoint()
        time.sleep(CHUNK_WAIT)

    elapsed = time.time() - t0
    print()
    print("=== 抓取完成 ===")
    print(f"耗时        : {elapsed:.1f} 秒")
    print(f"去重丢弃    : {dup} 条（跨块重复）")
    if failed_chunks:
        print()
        print("⚠️" * 30)
        print(f"⚠️ 有 {len(failed_chunks)}/{len(chunks)} 个分块抓取失败，数据存在**覆盖空洞**！")
        for c in failed_chunks:
            print(f"     失败块 bbox = {c[0]:.4f},{c[1]:.4f},{c[2]:.4f},{c[3]:.4f}")
        print("   修补方式：用上面的 bbox 单独重跑 --bbox，再把结果与已有文件合并：")
        print("     python scripts/fetch_osm_power.py --bbox W,S,E,N --name <name> --grid 1x1")
        print("   在缺口补齐前，不要把这批数据当成完整的覆盖范围。")
        print("⚠️" * 30)
    for kind, feats in buckets.items():
        print(f"  {kind:12s} {len(feats):7d} 个要素")
    if kv_hist:
        print("电压分档分布:")
        for cls in ("735+", "500-734", "220-499", "<220", "unknown"):
            if cls in kv_hist:
                print(f"  {cls:10s} {kv_hist[cls]:7d}")
    else:
        print("（本类别无电压分档）")

    if args.estimate_only:
        print("\n[试算模式] 未写任何文件。")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    crs = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
    # 🔴 阶段43 事故的正面防护：断点说「全部抓完」但内存里一条都没有，
    #    这必定是回读出了问题（或旧产物被人为清空），绝不能把空结果写回去。
    #    宁可失败退出，也不能静默地把真数据覆盖成空文件。
    # ⚠️ 阶段56-A2：`converters` 类别**允许 0 个换流站**（有些区域确实一个都没有），
    #    所以对它放宽成"要素与直流标签**都**为空才报错" —— 否则一个正常结果会被判成事故。
    if done_chunks and not any(buckets[k] for k in kinds) and not dc_tags:
        raise RuntimeError(
            f"断点记录显示已完成 {len(done_chunks)} 块，但回读到 0 个要素。\n"
            f"    拒绝写入 —— 否则会把已有产物覆盖成空文件（阶段43 真实发生过，损失 7.4 万条）。\n"
            f"    请检查 {geom_path(args.out_dir, name, args.category, kinds[0])}；"
            f"    确认要重抓请加 --restart。"
        )
    written = {}
    for kind, feats in buckets.items():
        path = geom_path(args.out_dir, name, args.category, kind)
        guard_empty_overwrite(path, feats, preexisting.get(kind, 0))
        write_json_atomic(path, {"type": "FeatureCollection", "crs": crs, "features": feats})
        size_mb = os.path.getsize(path) / 1048576
        written[kind] = {"file": path, "features": len(feats), "size_mb": round(size_mb, 2)}
        print(f"  → {path}  ({len(feats)} 要素, {size_mb:.2f} MB)")

    # ---- 阶段56-A2：换流站类别还要落 frequency 映射（第二个产物）----
    dc_info: dict[str, Any] | None = None
    if args.category == "converters":
        # 与 geojson 同一道「禁止空覆盖」：标签被清空同样是不可逆的数据损失。
        if not dc_tags and preexisting_tags > 0:
            raise RuntimeError(
                f"拒绝把非空直流标签覆盖成空：{tags_path}（原有 {preexisting_tags} 个 way）。\n"
                f"    通常意味着回读或抓取出了问题；确定要重抓请加 --restart。"
            )
        dc_info = write_dc_tags(
            tags_path,
            dc_tags,
            name=name,
            bbox=bbox,
            grid=f"{nx}x{ny}",
            done=len(done_chunks),
            total=len(chunks),
            failed_chunks=failed_chunks,
            elapsed=elapsed,
        )
        print(
            f"  → {tags_path}  ({dc_info['count']} 个 way 带 frequency, "
            f"{os.path.getsize(tags_path) / 1024:.0f} KB)"
        )
        hist = dc_info["frequency_histogram"]
        dc_zero = hist.get("0", 0)
        print(
            f"frequency 直方图（前 5）: "
            + (", ".join(f"{k}×{v}" for k, v in list(hist.items())[:5]) or "（没有标签）")
        )
        print(
            f"  ⇒ 其中 frequency=0（设计 §4.1 的第 1 步硬信号）: {dc_zero} 条；"
            f"覆盖率要等 prepare 阶段与线路总数比（本脚本只见标签）"
        )

    meta = {
        "bbox": list(bbox),
        "preset": None if args.bbox else args.preset,
        "grid": f"{nx}x{ny}",
        "elapsed_sec": round(elapsed, 1),
        "duplicates_dropped": dup,
        "complete": not failed_chunks,
        "failed_chunks": failed_chunks,
        "voltage_class_histogram": kv_hist,
        "outputs": written,
        # 署名要求：OSM 数据是 ODbL，前端必须显示来源
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if dc_info is not None:
        meta["dc_tags"] = dc_info
    meta_path_str = meta_path(args.out_dir, name, args.category)
    write_json_atomic(meta_path_str, meta, indent=2)
    print(f"  → {meta_path_str}")
    print("\n下一步：node scripts/prepare_osm_geojson.mjs --name <name>，再 node scripts/build_pmtiles.mjs")
    # 有空缺就返回非 0，避免调用方（或 CI）把残缺数据当成成功
    return 1 if failed_chunks else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ {exc}", file=sys.stderr)
        sys.exit(1)
