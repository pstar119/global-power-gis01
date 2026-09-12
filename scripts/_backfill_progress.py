"""根据抓取日志补写断点文件（一次性迁移用）。

背景：正在跑的抓取进程用的是**旧代码**（没有断点记录），所以 data/osm/yrd_progress.json
还不存在。如果不补，关机后重跑会从第 1 块重头再来 —— 而日志里已经明确记录了哪些块
三个查询都成功了，据此补写即可。

判定规则：某个 `[N/20] 块 w,s,e,n` 之后、下一个块头之前，lines / substations / plants
三个查询都打印了「返回…条」→ 该块完整完成；只要缺任何一个（含失败/跳过）就不算完成，
下次会自动重抓。
"""

import json
import os
import re
import sys

LOG = os.path.join("data", "yrd_fetch3.log")
OUT = os.path.join("data", "osm", "yrd_progress.json")
KINDS = ("lines", "substations", "plants")

CHUNK_RE = re.compile(r"^\[(\d+)/(\d+)\] 块 ([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)")


def main() -> int:
    if not os.path.exists(LOG):
        print(f"找不到日志 {LOG}", file=sys.stderr)
        return 1

    chunks: list[tuple] = []
    current: tuple | None = None
    seen_kinds: set[str] = set()

    def flush() -> None:
        if current and all(k in seen_kinds for k in KINDS):
            chunks.append(current)

    with open(LOG, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = CHUNK_RE.match(line)
            if m:
                flush()
                current = (float(m.group(3)), float(m.group(4)), float(m.group(5)), float(m.group(6)))
                seen_kinds = set()
                continue
            for k in KINDS:
                if re.match(rf"^\s+{k}\s+返回", line):
                    seen_kinds.add(k)
        flush()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = {
        "done": [list(c) for c in sorted(chunks)],
        "count": len(chunks),
        "updated_at": "backfilled-from-log",
        "note": "由 scripts/_backfill_progress.py 从日志补写（旧进程没有断点记录）",
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    print(f"已写入 {OUT}")
    print(f"判定为已完整完成的块：{len(chunks)} 个")
    for c in sorted(chunks):
        print(f"  {c[0]:.3f},{c[1]:.3f},{c[2]:.3f},{c[3]:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
