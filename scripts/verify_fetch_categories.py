"""阶段56-A1：断言抓取脚本只剩电力类别（铁路/管道已彻底移除，不是"留着不用"）。

为什么要断言而不是只看一眼：死代码会误导后来者以为还在抓，
而 `--category rail` 这种参数一旦还能用，就说明删除不彻底。

用法：python scripts/verify_fetch_categories.py
退出码：0 = 通过；1 = 发现问题。
"""
import re
import sys
from pathlib import Path

# ⚠️ 本机 Python 默认走 GBK 控制台编码，直接 print emoji 会抛
#    UnicodeEncodeError 并让脚本在最关键的一行崩溃（实测踩到）。显式改成 UTF-8。
sys.stdout.reconfigure(encoding="utf-8")

SRC = Path(__file__).with_name("fetch_osm_power.py").read_text(encoding="utf-8")

problems: list[str] = []

# ① 类别表与标签表里不能出现 rail / pipeline
for name in ("CATEGORY_KINDS", "CATEGORY_LABEL"):
    m = re.search(rf"^{name}\s*[:=].*?(?=\n\S|\Z)", SRC, re.M | re.S)
    if not m:
        problems.append(f"找不到 {name} 定义")
        continue
    block = m.group(0)
    for bad in ("rail", "pipeline"):
        if bad in block:
            problems.append(f"{name} 里仍有 {bad}")

# ② 铁路/管道的要素构造、属性、查询必须删除
for token in ("infra_line_feature", "railway_kind", "man_made", '_rail.geojson', '_pipeline.geojson'):
    if token in SRC:
        problems.append(f"仍残留: {token}")

# ③ 类别用的字符串字面量必须清空（带引号，避免误伤 run_pipeline 这类"数据管线"词）
for lit in ('"rail"', "'rail'", '"pipeline"', "'pipeline'", '"railway"', "'railway'"):
    if lit in SRC:
        problems.append(f"仍残留类别字面量: {lit}")

if problems:
    for p in problems:
        print(f"🔴 {p}")
    sys.exit(1)
print("✅ 抓取脚本只剩电力类别")
