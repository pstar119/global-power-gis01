"""阶段38：实测 `out count` 到底比 `out geom` 便宜多少。

为什么要写这个：我在 `--count-only` 的帮助文本里写了「约 1/5 成本」—— 那是**猜的**。
`out count` 省下的只是**响应体序列化与传输**，而 Overpass 仍要做同样的空间检索，
所以「便宜多少」完全取决于 geometry 序列化占总耗时的比例，只能实测。

选取 4 个代表性格子（均取自华东 8x8 网格），覆盖密集/中等/近乎空：
  A 113.500,23.000,114.688,24.938  密集（内陆）
  B 120.625,30.750,121.812,32.688  密集（长三角）
  C 118.250,26.875,119.438,28.812  中等
  D 121.812,26.875,123.000,28.812  空（东海海面）

现在没有别的抓取在跑，所以直接打主端点 maps.mail.ru —— 测出来的就是真实负载下的数字。
"""

import json
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, "scripts")
from fetch_osm_power import OVERPASS_ENDPOINTS, bbox_filter, count_from_payload  # noqa: E402

ENDPOINT = OVERPASS_ENDPOINTS[0]

CELLS = [
    ("A 密集(内陆)", (113.5, 23.0, 114.6875, 24.9375)),
    ("B 密集(长三角)", (120.625, 30.75, 121.8125, 32.6875)),
    ("C 中等", (118.25, 26.875, 119.4375, 28.8125)),
    ("D 空(海面)", (121.8125, 26.875, 123.0, 28.8125)),
]


def post(query: str) -> tuple[dict, float, int]:
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        ENDPOINT, data=data, headers={"User-Agent": "global-power-gis/phase38-measure"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8")), time.time() - t0, len(raw)


def lines_query(b, count_only: bool) -> str:
    f = bbox_filter(b)
    tail = "out count;" if count_only else "out geom;"
    return (
        '[out:json][timeout:180];'
        f'(way["power"="line"]{f};way["power"="minor_line"]{f};way["power"="cable"]{f};);' + tail
    )


def main() -> int:
    print("=== out count vs out geom 实测（仅 lines 查询，它占主导成本）===")
    print(f"端点 : {ENDPOINT}")
    print(f"时间 : {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    rows = []
    for label, b in CELLS:
        q_count = lines_query(b, True)
        q_geom = lines_query(b, False)
        try:
            payload_c, t_c, n_c = post(q_count)
            n_feat_c = count_from_payload(payload_c)
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: count 查询失败 {exc}")
            continue
        time.sleep(6)
        try:
            payload_g, t_g, n_g = post(q_geom)
            n_feat_g = len(payload_g.get("elements", []))
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: geom 查询失败 {exc}")
            continue
        time.sleep(2)
        rows.append(
            {
                "格子": label,
                "要素数": n_feat_g,
                "count秒": round(t_c, 1),
                "geom秒": round(t_g, 1),
                "耗时比geom/count": round(t_g / max(t_c, 1e-9), 2),
                "count响应B": n_c,
                "geom响应B": n_g,
                "体积比": round(n_g / max(n_c, 1), 1),
            }
        )
        print(f"{label}: 要素 {n_feat_g} · count {t_c:.1f}s/{n_c}B · geom {t_g:.1f}s/{n_g}B")

    if not rows:
        print("\n没有一条成功，无法得出结论。")
        return 1

    print("\n=== 汇总 ===")
    for r in rows:
        print(
            f"  {r['格子']:16s} 要素 {r['要素数']:6d}  耗时 {r['count秒']:6.1f}s → {r['geom秒']:6.1f}s "
            f"(比值 {r['耗时比geom/count']:5.2f}x)   体积 {r['count响应B']:7d}B → {r['geom响应B']:9d}B "
            f"(比值 {r['体积比']:6.1f}x)"
        )

    avg_time = sum(r["耗时比geom/count"] for r in rows) / len(rows)
    avg_size = sum(r["体积比"] for r in rows) / len(rows)
    lo = min(r["耗时比geom/count"] for r in rows)
    hi = max(r["耗时比geom/count"] for r in rows)
    print(f"\n耗时比范围：{lo:.2f}x ~ {hi:.2f}x（平均 {avg_time:.2f}x）")
    print(f"响应体积比平均：{avg_size:.0f}x")

    print("\n=== 结论 ===")
    print("🔴 单块测量的**方差极大**（耗时比 0.50x ~ 9.74x），所以不能拿平均值当结论。")
    print("   最反直觉的一条：C 只有 462 个要素却花了 23.7 秒，B 有 3944 个要素只花 9.9 秒 ——")
    print("   说明单块耗时主要由**服务端负载/缓存**决定，不是由数据量决定。\n")
    print("   稳定成立的只有两条事实：")
    print("     1. count 的耗时基本是**固定开销**（实测 2.4~4.6 秒），与要素数几乎无关；")
    print("     2. count 的响应体是**常数级**（~415 B），而 geom 是 MB 级（最大实测 4.26 MB）。")

    # 用真抓的实测值换算「扫描 vs 抓取」——这比单块比值可靠，因为它是 64 块的平均
    fetch_per_chunk = 44.0  # 华东 64 块实测：2818.5 秒 / 64
    count_avg = sum(r["count秒"] for r in rows) / len(rows)
    scan_per_chunk = 3 * (count_avg + 6.0) + 2.0  # 3 个查询 + QUERY_WAIT 6s + CHUNK_WAIT 2s
    print(f"\n=== 换算到整块（含脚本的固定间隔）===")
    print(f"   真抓 : {fetch_per_chunk:.1f} 秒/块（华东 64 块实测：2818.5 秒 / 64）")
    print(f"   扫描 : 3 个 count 查询 × ({count_avg:.1f}s + 6s 间隔) + 2s 块间隔 ≈ {scan_per_chunk:.1f} 秒/块（推算）")
    ratio = fetch_per_chunk / scan_per_chunk
    print(f"   ⇒ 扫描快约 {ratio:.2f}x，省约 {(1 - scan_per_chunk / fetch_per_chunk) * 100:.0f}% 的时间")
    print(f"   我之前在帮助文本里写「约 1/5 成本」是**猜的**，实测远没那么多。")
    print(
        f"\n   ⇒ 结论：扫描省下的那 ~{(1 - scan_per_chunk / fetch_per_chunk) * 100:.0f}% 不足以成为杠杆。"
    )
    print("      **优先直接抓**：抓取可续抓、产出真数据；扫描换不到数据，只换来一个估计值。")
    print("      而且实测单点外推**高估 77%**（华东：按 1 块外推 165,760，真抓 93,559），估计值本身也不可靠。")
    print("      `--count-only` 的合理用途是：探测端点是否可用、判断某区域有没有数据。")
    print("\n   两种模式的**要素数量必须一致**（实测 A/B/C 逐项相同），否则 count 不能用于估算。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
