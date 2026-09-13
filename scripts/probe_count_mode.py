"""阶段38：真实往返验证 `out count;` 的返回结构与解析正确性。

为什么必须真测：`out count;` 的返回结构与普通 `out geom;` **不同**（是单个 type=count 元素），
如果按想象写解析，很可能永远得到 0 —— 而 0 在我们的语义里代表「这块是空的」，
于是整片区域会被静默跳过。这正是历史上丢数据的那个坑。

为什么走另一个实例：本机正在用 maps.mail.ru 抓华东，测试改用 overpass-api.de，
两台服务器互不影响，不会给正在跑的批次制造 429。
"""

import json
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, "scripts")
from fetch_osm_power import count_from_payload  # noqa: E402

ENDPOINT = "https://overpass-api.de/api/interpreter"
# 取一小块（北京城区），保证查询快、不拖累任何人
BBOX = (39.90, 116.30, 40.00, 116.40)  # south, west, north, east


def post(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        ENDPOINT, data=data, headers={"User-Agent": "global-power-gis/phase38-verify"}
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    s, w, n, e = BBOX
    f = f"({s},{w},{n},{e})"
    body = f'(way["power"="line"]{f};way["power"="minor_line"]{f};way["power"="cable"]{f};);'
    head = "[out:json][timeout:180];"

    print("=== 阶段38：out count 真实往返验证 ===")
    print(f"实例 : {ENDPOINT}（刻意避开正在抓华东的 maps.mail.ru）")
    print(f"bbox : {w},{s},{e},{n}\n")

    print("--- 1) out count; 原始返回 ---")
    raw_count = post(head + body + "out count;")
    print("顶层键     :", list(raw_count.keys()))
    print("elements   :", json.dumps(raw_count.get("elements"), ensure_ascii=False)[:300])
    parsed = count_from_payload(raw_count)
    print("我的解析值 :", parsed)
    print("注释       :", raw_count.get("osm3s", {}).get("timestamp_osm_base", "(无)"))

    print("\n--- 2) out geom; 实际条数（交叉核对） ---")
    raw_geom = post(head + body + "out geom;")
    actual = len(raw_geom.get("elements", []))
    print("实际元素数 :", actual)

    print("\n--- 3) 结论 ---")
    if parsed is None:
        print("❌ 解析失败（返回 None）—— out count 的结构与预期不符，必须修解析器")
        return 1
    if parsed == actual:
        print(f"✅ 一致：count 模式 {parsed} == geom 模式 {actual}")
        print("   ⇒ 可以用 out count 做廉价密度扫描")
        return 0
    print(f"⚠️ 不一致：count 模式 {parsed} vs geom 模式 {actual}")
    print("   两者统计口径可能不同（如 count 含 way 的子节点/关系），需查清再用于估算")
    return 2


if __name__ == "__main__":
    sys.exit(main())
