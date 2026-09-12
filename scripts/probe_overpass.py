"""探测各 Overpass 镜像的真实可用性（跑一个真实的电力线路查询，计时）。

阶段29 背景：overpass-api.de 对 1°×1° 的查询密集返回 504 Gateway Timeout，
每次失败要退避 10/20/30 秒，导致每块耗时 4-5 分钟，20 块要一个多小时。
先花两分钟确认有没有更稳的镜像，再决定要不要缩小范围。

用法：python scripts/probe_overpass.py
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 一个小而真实的查询：苏州一带的输电线路
# ⚠️ Overpass 的 bbox 顺序是 (south, west, north, east)，不是 GeoJSON 的 (w,s,e,n)。
#    第一次探测把这个写反了，结果**所有**镜像都回 HTTP 400，白跑一轮。
BBOX = "31.1,120.4,31.5,120.9"
QUERY = f"""
[out:json][timeout:60];
(
  way["power"="line"]({BBOX});
);
out geom;
"""

CANDIDATES = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def probe(endpoint: str) -> tuple[str, float, int, str]:
    """返回 (状态, 耗时秒, 要素数, 备注)。"""
    body = urllib.parse.urlencode({"data": QUERY}).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "User-Agent": "global-power-gis/0.1 (OSM power data extractor)",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        dt = time.time() - t0
        remark = payload.get("remark")
        if remark:
            return ("remark", dt, 0, str(remark)[:70])
        return ("ok", dt, len(payload.get("elements", [])), "")
    except urllib.error.HTTPError as exc:
        return (f"HTTP {exc.code}", time.time() - t0, 0, "")
    except Exception as exc:  # noqa: BLE001
        return (type(exc).__name__, time.time() - t0, 0, str(exc)[:70])


def main() -> int:
    print(f"探测 {len(CANDIDATES)} 个 Overpass 镜像（真实查询：苏州 {BBOX} 的 power=line）")
    print()
    for ep in CANDIDATES:
        host = ep.split("/")[2]
        status, dt, n, note = probe(ep)
        flag = "✅" if status == "ok" else "❌"
        print(f"  {flag} {host:45s} {status:10s} {dt:6.1f}s  要素={n:5d}  {note}")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
