"""生成阶段21 的「极小规模电力网络」演示数据集，直接产出 migration SQL。

⚠️ 本脚本生成的是**程序合成的示意数据**，不是真实世界的变电站/线路位置。
   目的是验证「电厂 → 变电站 → 输电线路」三层渲染与图层显隐逻辑，
   不承担任何地理精度责任。真实全球电网数据是 TB 级，不在本阶段范围内。

为什么输出 SQL 而不是让前端导入：
   前端只持有 sql:allow-select 权限（sql:allow-execute 未开，实测被拒），
   所以「运行时导入」这条路在本项目的权限模型下不存在。
   数据改为随 migration 灌入 —— 已有库与全新库都会自动执行，两条路径统一。

设计要点（为什么不能纯随机撒点）：
  纯随机会产出两类「看着就假」的结果——
    1) 变电站均匀铺开，像噪声，没有负荷中心的概念；
    2) 线路两两随机配对，连成一张蜘蛛网，完全不像电网。
  所以这里复刻真实电网的两个结构特征：
    · 变电站聚集在若干个「电力枢纽」周围（环状+径向抖动，而非均匀随机）
    · 线路是树状主干 + 少量联络线 + 枢纽间长距离主干（而非随机配对）

固定随机种子 → 每次生成的 SQL 完全一致，可复现、可 diff。

用法：python scripts/make_demo_grid.py
"""

import math
import os
import random
import sys

SEED = 42
random.seed(SEED)

# 目标数量：正好 200 个变电站、100 条输电线路。
# 用显式分配数组而不是「大致均分」，否则自然产出会是 204/96 这类偏差值。
TARGET_SUBSTATIONS = 200
TARGET_LINES = 100

# 6 个电力枢纽锚点（真实城市群坐标，用于让演示网络落在可辨认的位置）
HUBS = [
    ("京津冀", 39.90, 116.40),
    ("长三角", 31.23, 121.47),
    ("珠三角", 23.13, 113.26),
    ("成渝", 30.57, 104.07),
    ("武汉", 30.59, 114.31),
    ("西安", 34.34, 108.94),
]

# 每枢纽站数分配：各 1 个 500kV，其余按下面数组分配。
# 1*6(500) + 78(220) + 116(110) = 200
N_220_PER_HUB = [13, 13, 13, 13, 13, 13]   # = 78
N_110_PER_HUB = [20, 20, 19, 19, 19, 19]   # = 116

# 每枢纽线路数分配：
# 枢纽间 6 + 500→220(6*5=30) + 220→110(6*8=48) + 220 联络(3,3,3,3,2,2=16) = 100
N_TRUNK_PER_HUB = [5, 5, 5, 5, 5, 5]       # 500 -> 220
N_BRANCH_PER_HUB = [8, 8, 8, 8, 8, 8]      # 220 -> 110
N_TIE_PER_HUB = [3, 3, 3, 3, 2, 2]         # 220 <-> 220


def jitter(scale: float) -> float:
    return random.uniform(-scale, scale)


def ring_points(cx, cy, count, r_min, r_max):
    """按「极坐标等角分布 + 抖动」撒点。

    等角分布保证点在环上不粘连；抖动让它们看起来不像机械的圆环。
    """
    out = []
    for i in range(count):
        ang = 2 * math.pi * i / count + jitter(0.25)
        r = random.uniform(r_min, r_max)
        # 经度方向按纬度做余弦修正，避免高纬度处东西向被拉长
        out.append((
            cx + r * math.cos(ang) / max(math.cos(math.radians(cy)), 0.3),
            cy + r * math.sin(ang),
        ))
    return out


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def build():
    substations = []
    lines = []

    # ---------- 变电站 ----------
    # ⚠️ HUBS 的元组顺序是 (name, lat, lon)。这里曾经把两者解包反了，
    #    生成出 lat=116.4 这种非法纬度，MapLibre 无法投影 → 图层存在、
    #    数据也在 source 里，就是一个点都渲染不出来。下面用显式变量名 + 出口断言防呆。
    for hi, (hub_name, hub_lat, hub_lon) in enumerate(HUBS):
        substations.append({
            "name": f"{hub_name} 500kV 中枢变电站",
            "country": "CHN", "voltage_kv": 500.0,
            "lat": round(hub_lat, 6), "lon": round(hub_lon, 6), "hub": hub_name,
        })

        # ring_points 的参数顺序是 (cx=经度, cy=纬度)
        for idx, (lon, lat) in enumerate(
            ring_points(hub_lon, hub_lat, N_220_PER_HUB[hi], 0.28, 0.62), start=1
        ):
            substations.append({
                "name": f"{hub_name} 220kV 变电站 {idx:02d}",
                "country": "CHN", "voltage_kv": 220.0,
                "lat": round(lat, 6), "lon": round(lon, 6), "hub": hub_name,
            })

        for idx, (lon, lat) in enumerate(
            ring_points(hub_lon, hub_lat, N_110_PER_HUB[hi], 0.66, 1.15), start=1
        ):
            substations.append({
                "name": f"{hub_name} 110kV 变电站 {idx:02d}",
                "country": "CHN", "voltage_kv": 110.0,
                "lat": round(lat, 6), "lon": round(lon, 6), "hub": hub_name,
            })

    by_hub = {}
    for s in substations:
        by_hub.setdefault(s["hub"], {"500": [], "220": [], "110": []})
        by_hub[s["hub"]][str(int(s["voltage_kv"]))].append(s)

    # ---------- 枢纽间主干（500 kV）----------
    # 「最近邻链」串起所有枢纽：从第一个出发，每次连到最近的未访问枢纽。
    # 这保证 6 个枢纽全部连通（是一棵树，不会出现孤立簇），又不会连成杂乱的完全图。
    centers = [(h[0], h[2], h[1]) for h in HUBS]  # (name, lon, lat)
    chain = [centers[0]]
    remaining = centers[1:]
    used_edges = set()

    def edge_key(a, b):
        """无向边归一化：两个方向视为同一条。"""
        return (a[0], b[0]) if a[0] < b[0] else (b[0], a[0])

    while remaining:
        last = chain[-1]
        nxt = min(remaining, key=lambda c: dist((last[1], last[2]), (c[1], c[2])))
        lines.append({
            "name": f"{last[0]} — {nxt[0]} 500kV 联络线",
            "voltage_kv": 500.0,
            "start_lat": round(last[2], 6), "start_lon": round(last[1], 6),
            "end_lat": round(nxt[2], 6), "end_lon": round(nxt[1], 6),
        })
        used_edges.add(edge_key(last, nxt))
        chain.append(nxt)
        remaining.remove(nxt)

    # 再补备用主干，让枢纽间不只一条通道。
    # ⚠️ 必须先查重：候选边可能已经出现在最近邻链里（实测「成渝—武汉」就会撞车），
    #    否则会产出完全重合的两条线，在地图上表现为某条线路的宽度莫名加深。
    for a, b in [(HUBS[0], HUBS[1]), (HUBS[3], HUBS[4])]:
        na, nb = (a[0], a[2], a[1]), (b[0], b[2], b[1])
        key = edge_key(na, nb)
        if key in used_edges:
            continue
        used_edges.add(key)
        lines.append({
            "name": f"{a[0]} — {b[0]} 500kV 备用主干",
            "voltage_kv": 500.0,
            "start_lat": round(a[1], 6), "start_lon": round(a[2], 6),
            "end_lat": round(b[1], 6), "end_lon": round(b[2], 6),
        })

    # ---------- 枢纽内线路 ----------
    for hi, (hub_name, _hx, _hy) in enumerate(HUBS):
        g = by_hub[hub_name]
        c500 = g["500"][0]
        p500 = (c500["lon"], c500["lat"])

        # 500 → 220：放射状骨架
        near220 = sorted(
            g["220"], key=lambda s: dist(p500, (s["lon"], s["lat"]))
        )[: N_TRUNK_PER_HUB[hi]]
        for i, s in enumerate(near220, start=1):
            lines.append({
                "name": f"{hub_name} 500→220 主干 {i}",
                "voltage_kv": 220.0,
                "start_lat": round(c500["lat"], 6), "start_lon": round(c500["lon"], 6),
                "end_lat": round(s["lat"], 6), "end_lon": round(s["lon"], 6),
            })

        # 220 → 110：每个 110 站挂到最近的 220 站
        for i in range(N_BRANCH_PER_HUB[hi]):
            s110 = g["110"][i]
            host = min(g["220"], key=lambda s: dist(
                (s110["lon"], s110["lat"]), (s["lon"], s["lat"])))
            lines.append({
                "name": f"{hub_name} 220→110 支线 {i + 1}",
                "voltage_kv": 110.0,
                "start_lat": round(host["lat"], 6), "start_lon": round(host["lon"], 6),
                "end_lat": round(s110["lat"], 6), "end_lon": round(s110["lon"], 6),
            })

        # 220 之间的横向联络线，让网络看起来有冗余路径而不是纯树
        for i in range(N_TIE_PER_HUB[hi]):
            a = g["220"][i * 2]
            b = g["220"][(i * 2 + 3) % len(g["220"])]
            lines.append({
                "name": f"{hub_name} 220kV 联络线 {i + 1}",
                "voltage_kv": 220.0,
                "start_lat": round(a["lat"], 6), "start_lon": round(a["lon"], 6),
                "end_lat": round(b["lat"], 6), "end_lon": round(b["lon"], 6),
            })

    return substations, lines


def q(value: str) -> str:
    """SQL 字符串字面量。名字里若出现单引号必须转义，否则会截断语句。"""
    return "'" + value.replace("'", "''") + "'"


def to_sql(substations, lines) -> str:
    head = """-- ============================================================
-- 阶段21：电力网络演示数据（程序合成，非真实世界位置）
--
-- ⚠️ 本文件由 scripts/make_demo_grid.py 自动生成，请勿手改。
--    重新生成：python scripts/make_demo_grid.py
--
-- 为什么数据在这里而不是前端导入：
--   前端只持有 sql:allow-select 权限，没有 sql:allow-execute，
--   运行时写库会被 Tauri 直接拒绝（实测报 "sql.execute not allowed"）。
--   数据随 migration 灌入，则「已有库」和「全新库」都会自动生效，两条路径统一。
--
-- 数据规模：{n_sub} 个变电站 / {n_line} 条输电线路，分布在 {n_hub} 个电力枢纽。
-- 电压等级：500kV（枢纽中心与跨区主干）/ 220kV / 110kV。
-- ============================================================

""".format(n_sub=len(substations), n_line=len(lines), n_hub=len(HUBS))

    sub_rows = ",\n".join(
        "  ({}, {}, {}, {}, {})".format(
            q(s["name"]), q(s["country"]), s["voltage_kv"], s["lat"], s["lon"])
        for s in substations
    )
    line_rows = ",\n".join(
        "  ({}, {}, {}, {}, {}, {})".format(
            q(x["name"]), x["voltage_kv"], x["start_lat"], x["start_lon"],
            x["end_lat"], x["end_lon"])
        for x in lines
    )

    return (
        head
        + "INSERT INTO substations (name, country, voltage_kv, lat, lon) VALUES\n"
        + sub_rows
        + ";\n\n"
        + "INSERT INTO transmission_lines "
          "(name, voltage_kv, start_lat, start_lon, end_lat, end_lon) VALUES\n"
        + line_rows
        + ";\n"
    )


def main() -> int:
    substations, lines = build()

    # 生成器内部先自检，数量对不上就别写文件
    assert len(substations) == TARGET_SUBSTATIONS, (
        f"变电站 {len(substations)} != 目标 {TARGET_SUBSTATIONS}，"
        "请检查 N_220_PER_HUB / N_110_PER_HUB")
    assert len(lines) == TARGET_LINES, (
        f"线路 {len(lines)} != 目标 {TARGET_LINES}，"
        "请检查 N_TRUNK/N_BRANCH/N_TIE")

    # ⚠️ 经纬度范围断言：这是本脚本最容易犯、也最难从产物上看出来的错误。
    #    曾经把 HUBS 的 (lat, lon) 解包反了，产出 lat=116.4 的非法纬度，
    #    结果是「图层在、数据在、就是渲染不出来」，排查成本极高。
    for s in substations:
        assert -90 <= s["lat"] <= 90, f"非法纬度 {s['lat']}（{s['name']}）—— lat/lon 是否写反？"
        assert -180 <= s["lon"] <= 180, f"非法经度 {s['lon']}（{s['name']}）"
    for x in lines:
        for k in ("start_lat", "end_lat"):
            assert -90 <= x[k] <= 90, f"非法纬度 {x[k]}（{x['name']}）—— lat/lon 是否写反？"
        for k in ("start_lon", "end_lon"):
            assert -180 <= x[k] <= 180, f"非法经度 {x[k]}（{x['name']}）"

    out = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "src-tauri", "migrations", "003_seed_demo_grid.sql"))
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(to_sql(substations, lines))

    print(f"[OK] {out}")
    print(f"     变电站 {len(substations)} 个 / 输电线路 {len(lines)} 条")
    print(f"     体积 {os.path.getsize(out) / 1024:.1f} KB")
    for v in (500.0, 220.0, 110.0):
        print(f"     {int(v):3d} kV: 站 "
              f"{sum(1 for s in substations if s['voltage_kv'] == v):3d} 个 / 线 "
              f"{sum(1 for x in lines if x['voltage_kv'] == v):3d} 条")
    dup = len(lines) - len({(x["start_lat"], x["start_lon"], x["end_lat"],
                             x["end_lon"]) for x in lines})
    selfloop = sum(1 for x in lines
                   if (x["start_lat"], x["start_lon"]) == (x["end_lat"], x["end_lon"]))
    print(f"     重复线段 {dup} 条 / 自环 {selfloop} 条（都应为 0）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
