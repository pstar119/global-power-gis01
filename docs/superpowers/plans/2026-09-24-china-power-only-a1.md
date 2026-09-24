# 项目 A1：中国纯电力化（去铁路/管道 + 属性扩容）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把中国数据面改成**纯电力**（铁路与油气管道的显示与数据同时移除），并把抓取阶段已经拿到、却被 prepare 白名单丢掉的电力属性（回路数/导线/电缆/运营商/线路编号/装机出力）补进归档。

**Architecture:** 三层顺序改造 —— 抓取侧删类别、prepare 侧删合并项并扩容白名单、切片侧同步白名单与图层；前端同步删除铁路/管道图层。**不重抓**：中间产物（`data/osm/*`）已含全部所需数据，重跑 prepare + build 即可。

**Tech Stack:** Python 3.14（抓取）、Node 26 + ESM（prepare/build/验证）、MapLibre GL 6.9（渲染）、PMTiles（归档）。

**Spec:** `docs/superpowers/specs/2026-09-24-china-power-data-rework-design.md`（§3 管线改造、§4 数据模型、§5 前端、§6 验收）

## Global Constraints

- **零新增依赖**：不得新增 npm / cargo 依赖。测试用 Node 内置 `node --test`，Python 用标准库 `assert` 脚本。
- **不重抓**：本计划**不允许**跑 `fetch_osm_power.py` 的抓取动作（无网络需求）；只改代码与跑 prepare/build。
- **不改已应用的迁移**，**不碰 `public/osm/smoketest_power.geojson`**，**不引入 Zustand/Redux/UI 库**。
- **验证脚本优先**：凡"某类数据不应存在"的断言，一律写成可复跑脚本（沿用 `scripts/verify_*.mjs` 的既有风格），不靠肉眼。
- **易失数字**：包体积、要素数、耗时一律实测后写入文档，**不预设、不编造**。
- **提交粒度**：每个 Task 结束提交一次（提交信息用中文，沿用 `type(scope): 摘要` 格式）。
- Windows 环境：node 在 `D:\Node,js\node.exe`（**不在 PATH**），python 在 `C:\Python314\python.exe`，git 在 `D:\Git\cmd\git.exe`（且需 `-c safe.directory=J:/Projects/global-power-gis`）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `scripts/fetch_osm_power.py` | OSM 抓取：类别定义、查询构造、要素构造 | 修改（删 rail/pipeline，加 frequency） |
| `scripts/prepare_osm_geojson.mjs` | 合并各类产物 → 单归档输入 + 属性白名单 | 修改（删两类，扩容电力三项） |
| `scripts/build_pmtiles.mjs` | GeoJSON → PMTiles，属性二次白名单 + 图层 | 修改（keepProps、ftype 集合） |
| `scripts/verify_power_only.mjs` | **新增**：断言归档/GeoJSON 内不存在铁路/管道，且电力属性齐备 | 新建 |
| `src/pages/MapPage.tsx` | 图层定义、样式、图层面板、弹窗、图例 | 修改（删铁路/管道全部痕迹） |
| `README.md` / `README_OSM.md` / `PROJECT_HANDOFF.md` | 口径与要素数 | 修改 |

**接口约定（后续任务依赖的确切名称）**

- `verify_power_only.mjs <path.pmtiles|path.geojson>`：退出码 `0` = 纯电力且属性齐备；`1` = 发现问题；`2` = 用法错误。
  输出固定三行：`forbidden ftypes: …`、`prop coverage: …`、`verdict: PASS|FAIL`。
- 归档内 `ftype` 取值集合：`line | substation | plant`（本计划结束后不再有 `railway` / `pipeline`）。
- 线路要素属性集合（本计划结束后）：`osm_id, name, ref, operator, vclass, voltage_kv, line_kind, cables, wires, circuits`。

---

### Task 1: 验证脚本先行（先看它失败）

**Files:**
- Create: `scripts/verify_power_only.mjs`
- Test: 用它跑现有归档与现有 GeoJSON，**预期失败**

**Interfaces:**
- Produces: `verify_power_only.mjs` 的 CLI 契约（见上），Task 2/3/5 都调用它

- [ ] **Step 1: 写验证脚本**

```js
// scripts/verify_power_only.mjs
/**
 * 阶段56-A1：断言"只有电力"。
 *
 * 为什么必须是脚本而不是肉眼：本次改动要删掉两类已发布的数据（铁路、油气管道），
 * 而"删干净了没有"这件事有两个易漏的地方 —— ① prepare 的合并表、② 切片的白名单与图层表。
 * 只看一处就会留下另一半，且**不会报错**（图层里没有要素，只是什么都不画）。
 *
 * 用法：
 *   node scripts/verify_power_only.mjs <file.pmtiles>
 *   node scripts/verify_power_only.mjs <file.geojson>
 * 退出码：0 = 通过；1 = 发现问题；2 = 用法错误。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { gunzipSync } from "node:zlib";

const FORBIDDEN_FTYPES = ["railway", "pipeline"];
const EXPECTED_LINE_PROPS = ["osm_id", "name", "vclass", "voltage_kv", "line_kind"];

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>");
  process.exitCode = 2;
} else {
  const ext = extname(path).toLowerCase();
  const ftypes = new Map(); // ftype -> count
  const linePropHits = new Map(EXPECTED_LINE_PROPS.map((k) => [k, 0]));
  let lineTotal = 0;

  if (ext === ".geojson") {
    const fc = JSON.parse(readFileSync(path, "utf8"));
    for (const f of fc.features ?? []) {
      const p = f.properties ?? {};
      const t = p.ftype ?? "(none)";
      ftypes.set(t, (ftypes.get(t) ?? 0) + 1);
      if (t === "line") {
        lineTotal++;
        for (const k of EXPECTED_LINE_PROPS) if (p[k] !== undefined) linePropHits.set(k, linePropHits.get(k) + 1);
      }
    }
  } else if (ext === ".pmtiles") {
    // 归档：直接扫目录里的 MVT 图层名 + 抽样第一个瓦片的 ftype 值
    const { PMTiles, FileSource } = await import("pmtiles");
    const buf = readFileSync(path);
    const header = { minZoom: buf.readUInt8(100), maxZoom: buf.readUInt8(101) };
    const pm = new PMTiles(new FileSource(path));
    void header;
    // 抽样 z=6 的第一个有内容瓦片，解出 MVT 图层名
    const tile = await pm.getZxy(6, 52, 24);
    if (tile) {
      const raw = gunzipSync(Buffer.from(tile.data));
      // MVT 图层名以明文出现在图层头：`\x1a<len><name>`
      const text = raw.toString("latin1");
      for (const m of text.matchAll(/\x1a[\x00-\x7f]{0,40}/g)) {
        const name = m[0].slice(1).replace(/[^\x20-\x7e]/g, "");
        if (name) ftypes.set(`layer:${name}`, (ftypes.get(`layer:${name}`) ?? 0) + 1);
      }
    }
  } else {
    console.error(`不支持的扩展名: ${ext}`);
    process.exitCode = 2;
  }

  const bad = [...ftypes.keys()].filter((k) => FORBIDDEN_FTYPES.some((f) => k.includes(f)));
  console.log(`forbidden ftypes: ${bad.length ? bad.join(", ") : "(none)"}`);
  const missing = [...linePropHits.keys()].filter((k) => linePropHits.get(k) === 0);
  console.log(
    `prop coverage: lines=${lineTotal} missing=${missing.length ? missing.join(",") : "(none)"}`,
  );
  const pass = bad.length === 0 && (ext !== ".geojson" || missing.length === 0);
  console.log(`verdict: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}
```

> 🔧 **控制器裁定（2026-09-24）：上面 Step 1 的 `pmtiles` 分支不可用，按下面这版实现。**
> 原因：`pmtiles` 的 `FileSource` 需要浏览器 `File` 对象，在 Node 下会抛
> `this.file.slice(...).arrayBuffer is not a function`（本项目实测过）。而仓库自带的
> `scripts/lib/pmtiles-writer.mjs` 里已有 `verifyArchive()`，它内部用的 `MemorySource` 正好可用。
>
> **同时明确检查职责的边界（不许过度声称）**：
> - **GeoJSON 是权威内容检查**（无 `railway`/`pipeline` 的 `ftype`、电力属性齐备）；
> - **`.pmtiles` 只做结构检查**（可读回、`ok > 0`、含预期图层名 `grid`）。
>   归档内所有 `ftype` 都在**同一个** MVT 图层 `grid` 里，靠图层名抓不到铁路/管道，
>   而包内容由 Task 3 的 GeoJSON 门禁 + Task 4 的 `verify_pack.mjs`（真解码瓦片）共同保证。

```js
// scripts/verify_power_only.mjs
/**
 * 阶段56-A1：断言"只有电力"。
 *
 * 为什么必须是脚本而不是肉眼：本次要删掉两类已发布数据（铁路、油气管道），
 * 而"删干净了没有"有两个易漏点 —— ① prepare 的合并表、② 切片的图层/属性白名单。
 * 只看一处会留下一半，且**不会报错**（图层里没有要素，只是什么都不画）。
 *
 * 检查职责（**不要过度声称**）：
 *   · `<file>.geojson` —— 权威内容检查：无 railway/pipeline 的 ftype + 电力属性齐备
 *   · `<file>.pmtiles` —— 结构检查：可读回、非空、含预期 MVT 图层名 `grid`
 *     （归档内所有 ftype 同在 `grid` 一层，图层名抓不到铁路/管道；内容由 GeoJSON 门禁保证）
 *
 * 用法：node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>
 * 退出码：0 = 通过；1 = 发现问题；2 = 用法错误。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { verifyArchive, tileX, tileY, zxyToTileId } from "./lib/pmtiles-writer.mjs";

const FORBIDDEN_FTYPES = ["railway", "pipeline"];
const EXPECTED_LINE_PROPS = ["osm_id", "name", "vclass", "voltage_kv", "line_kind", "circuits", "cables", "wires", "operator"];

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>");
  process.exitCode = 2;
} else {
  const ext = extname(path).toLowerCase();
  const ftypes = new Map();
  const propHits = new Map(EXPECTED_LINE_PROPS.map((k) => [k, 0]));
  let lineTotal = 0;
  let pass = false;
  let extra = "";

  if (ext === ".geojson") {
    const fc = JSON.parse(readFileSync(path, "utf8"));
    for (const f of fc.features ?? []) {
      const p = f.properties ?? {};
      const t = p.ftype ?? "(none)";
      ftypes.set(t, (ftypes.get(t) ?? 0) + 1);
      if (t === "line") {
        lineTotal++;
        for (const k of EXPECTED_LINE_PROPS) if (p[k] !== undefined) propHits.set(k, propHits.get(k) + 1);
      }
    }
    const bad = [...ftypes.keys()].filter((k) => FORBIDDEN_FTYPES.includes(k));
    const missing = [...propHits.keys()].filter((k) => propHits.get(k) === 0);
    console.log(`forbidden ftypes: ${bad.length ? bad.join(", ") : "(none)"}`);
    console.log(`prop coverage: lines=${lineTotal} missing=${missing.length ? missing.join(",") : "(none)"}`);
    pass = bad.length === 0 && missing.length === 0;
  } else if (ext === ".pmtiles") {
    // 从归档 bbox 推 z6/z8 的若干 tileId 抽样；verifyArchive 内部用 MemorySource，Node 下可用
    const headerBuf = readFileSync(path).subarray(0, 127);
    const minLon = headerBuf.readInt32LE(102) / 1e7, minLat = headerBuf.readInt32LE(106) / 1e7;
    const maxLon = headerBuf.readInt32LE(110) / 1e7, maxLat = headerBuf.readInt32LE(114) / 1e7;
    const sampleIds = [];
    for (const z of [6, 8]) {
      for (let x = tileX(minLon, z); x <= tileX(maxLon, z) && sampleIds.length < 40; x += 2) {
        for (let y = tileY(maxLat, z); y <= tileY(minLat, z) && sampleIds.length < 40; y += 2) {
          sampleIds.push(zxyToTileId(z, x, y));
        }
      }
    }
    const r = await verifyArchive(path, { sampleIds, layerNames: ["grid"] });
    const withGrid = r.checked.filter((c) => c.layers.includes("grid")).length;
    console.log(`forbidden ftypes: (n/a for archive — 内容由对应的 geojson 检查)`);
    console.log(`archive: readback ok=${r.ok} missing=${r.missing} gridTiles=${withGrid} z${r.header.minZoom}-${r.header.maxZoom}`);
    pass = r.ok > 0 && withGrid > 0;
    extra = "（归档结论以结构可读 + 含 grid 层为准）";
  } else {
    console.error(`不支持的扩展名: ${ext}`);
    process.exitCode = 2;
  }

  if (!process.exitCode) {
    console.log(`verdict: ${pass ? "PASS" : "FAIL"}${extra}`);
    if (!pass) process.exitCode = 1;
  }
}
```

> ⚠️ 若 `tileX/tileY/zxyToTileId` 的签名与上面不一致，**以 `scripts/lib/pmtiles-writer.mjs` 的实际导出为准**
> （该文件已导出这三者），并同步修正本计划（这是一处**允许按实际代码校正**的点，不要改仓库代码去迁就计划）。

- [ ] **Step 2: 跑它，确认它现在失败**

Run（PowerShell，注意 node 不在 PATH）：
```powershell
& "D:\Node,js\node.exe" scripts/verify_power_only.mjs data/packs/osm-huadong.pmtiles
```
Expected：`forbidden ftypes:` 里出现 `layer:railway` 或 `layer:pipeline`（**当前归档含这两类**），或 `verdict: FAIL`。

- [ ] **Step 3: 再跑一次 GeoJSON（当前中间产物同样含两类）**

```powershell
& "D:\Node,js\node.exe" scripts/verify_power_only.mjs public/osm/huadong_power.geojson
```
Expected：`forbidden ftypes: railway, pipeline`，`verdict: FAIL`。

- [ ] **Step 4: 提交（脚本 + 它当前失败的事实）**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add scripts/verify_power_only.mjs
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "test(data): 新增 verify_power_only.mjs —— 先让它对现有归档失败" -m "本次要删掉两类已发布数据（铁路/油气管道），而删干净有两个易漏点：prepare 的合并表与切片的图层表。只看一处会留下一半，且不报错。脚本先跑、先失败、再改。"
```

---

### Task 2: 抓取侧删除铁路/管道类别

**Files:**
- Modify: `scripts/fetch_osm_power.py`（`CATEGORY_KINDS` ≈114-122、`infra_line_feature()` ≈342-363、`build_feature()` ≈366-368、查询构造 ≈455-470、`CATEGORY_LABEL` ≈123）
- Test: `scripts/verify_power_only.mjs` **不适用**（本任务只改代码，不产数据）；改用导入断言

**Interfaces:**
- Consumes: 无
- Produces: `CATEGORIES` 仅含 `power`（后续 Task 5 的区域重跑按此抓取；本计划内不实际抓取）

- [ ] **Step 1: 写"类别表必须只有电力"的断言脚本**

```python
# scripts/verify_fetch_categories.py
"""阶段56-A1：断言抓取脚本只剩电力类别（铁路/管道已彻底移除，不是"留着不用"）。

为什么要断言而不是只看一眼：死代码会误导后来者以为还在抓，
而 `--category rail` 这种参数一旦还能用，就说明删除不彻底。
用法：python scripts/verify_fetch_categories.py
退出码：0 = 通过；1 = 发现问题。
"""
import re
import sys
from pathlib import Path

SRC = Path(__file__).with_name("fetch_osm_power.py").read_text(encoding="utf-8")

problems = []

# ① 类别表里不能出现 rail / pipeline
for name in ("CATEGORY_KINDS", "CATEGORY_LABEL"):
    m = re.search(rf"^{name}\s*[:=].*?(?=\n\S|\Z)", SRC, re.M | re.S)
    if not m:
        problems.append(f"找不到 {name} 定义")
        continue
    block = m.group(0)
    for bad in ("rail", "pipeline"):
        if bad in block:
            problems.append(f"{name} 里仍有 {bad}")

# ② 铁路/管道的查询构造与要素构造必须删除
for fn in ("infra_line_feature", "railway_kind", "man_made"):
    if fn in SRC:
        problems.append(f"仍残留: {fn}")

if problems:
    for p in problems:
        print(f"🔴 {p}")
    sys.exit(1)
print("✅ 抓取脚本只剩电力类别")
```

- [ ] **Step 2: 跑它，确认失败**

```powershell
& "C:\Python314\python.exe" scripts/verify_fetch_categories.py
```
Expected：列出若干 `🔴 仍残留: …`，退出码 1。

- [ ] **Step 3: 改 `fetch_osm_power.py`**

按以下五处逐一改（行号是改动前的锚点）：

1. `CATEGORY_KINDS`（≈114-122）：删掉 `"rail": ["rail"]` 与 `"pipeline": ["pipeline"]` 两行，只留 `"power": ["lines", "substations", "plants"]`。
2. `CATEGORY_LABEL`（≈123）：删掉 `"rail": "铁路干线"` 与 `"pipeline": "油气管道"`。
3. 删掉整个 `infra_line_feature()` 函数（≈342-363）与 `build_feature()` 开头的分派（≈367-368 的 `if geom_type in ("railway", "pipeline"): return infra_line_feature(...)`）。
4. 查询构造（≈455-470）：删掉 `railway` 与 `pipeline` 两个 builder 分支。
5. **顺带加属性采集**（本次必做，因为反正要重跑 prepare）：在 `build_feature()` 的 line 分支里，`props["circuits"] = …` 之后补一行：

```python
        props["frequency"] = tags.get("frequency") or None
```

- [ ] **Step 4: 跑断言，确认通过**

```powershell
& "C:\Python314\python.exe" scripts/verify_fetch_categories.py
```
Expected：`✅ 抓取脚本只剩电力类别`，退出码 0。

- [ ] **Step 5: 确认脚本仍可正常加载（防止删出语法/引用错误）**

```powershell
& "C:\Python314\python.exe" -c "import ast,sys; ast.parse(open(r'scripts/fetch_osm_power.py',encoding='utf-8').read()); print('syntax OK')"
& "C:\Python314\python.exe" scripts/fetch_osm_power.py --help
```
Expected：打印 `syntax OK`；`--help` 正常列出参数（不联网）。

- [ ] **Step 6: 提交**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add scripts/fetch_osm_power.py scripts/verify_fetch_categories.py
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "feat(fetch): 抓取侧删除铁路/管道类别，并采集 frequency" -m "删掉而不是留着不用 —— 死代码会误导后来者。同时补采 frequency（直交流分档的唯一硬信号），本计划内不实际抓取，属未来抓取时的能力。"
```

---

### Task 3: prepare 侧删除两类 + 扩容属性白名单

**Files:**
- Modify: `scripts/prepare_osm_geojson.mjs`（`KEEP_PROPS` ≈83-89、`FILES` ≈98-102）
- Test: 跑单区域 prepare 后用 `verify_power_only.mjs` 断言

**Interfaces:**
- Consumes: Task 1 的 `verify_power_only.mjs`
- Produces: `public/osm/<region>_power.geojson` 只含 `line|substation|plant` 三类，且线路带 `ref/operator/cables/wires/circuits`

- [ ] **Step 1: 改 `KEEP_PROPS` 与 `FILES`**

```js
// KEEP_PROPS：删除 railway / pipeline 两项，电力三项扩容
const KEEP_PROPS = {
  line: ["osm_id", "name", "ref", "operator", "vclass", "voltage_kv", "line_kind", "cables", "wires", "circuits", "frequency"],
  substation: ["osm_id", "name", "operator", "vclass", "voltage_kv", "substation_kind"],
  plant: ["osm_id", "name", "vclass", "voltage_kv", "plant_source", "plant_output"],
};

// FILES：删掉 railway / pipeline 两行，只留三行电力
const FILES = [
  { ftype: "line", src: (n) => `${n}_power_lines.geojson`, power: true },
  { ftype: "substation", src: (n) => `${n}_power_substations.geojson`, power: true },
  { ftype: "plant", src: (n) => `${n}_power_plants.geojson`, power: true },
];
```

- [ ] **Step 2: 跑单区域 prepare（华东，验证用最小样本）**

```powershell
& "D:\Node,js\node.exe" scripts/prepare_osm_geojson.mjs --name huadong
```
Expected：正常结束；控制台出现 `补 vclass=unknown` 之类的既有统计行。

> ✅ 用法已核实：`--name <n>` 读 `data/osm/<n>_power_*.geojson` → 写 `public/osm/<n>_power.geojson`。

- [ ] **Step 3: 断言产物只有电力且属性齐备**

```powershell
& "D:\Node,js\node.exe" scripts/verify_power_only.mjs public/osm/huadong_power.geojson
```
Expected：`forbidden ftypes: (none)`；`prop coverage: lines=<N> missing=(none)`；`verdict: PASS`。

- [ ] **Step 4: 与改造前对比要素数（记录，不设阈值）**

```powershell
& "D:\Node,js\node.exe" -e "const fc=require('./public/osm/huadong_power.geojson');const m={};for(const f of fc.features){const t=f.properties.ftype;m[t]=(m[t]||0)+1}console.log(m);console.log('total',fc.features.length)"
```
Expected：只出现 `line` / `substation` / `plant` 三个键；total **明显小于**改造前（改造前含铁路/管道）。把这个数字记进最终提交信息与 Task 6 的文档更新。

- [ ] **Step 5: 提交**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add scripts/prepare_osm_geojson.mjs
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "feat(prepare): 删除铁路/管道合并项，并扩容电力属性白名单" -m "属性扩容是零抓取成本 —— circuits/cables/wires/operator/ref/plant_output 早已在 data/osm 的中间产物里，只是被本文件的白名单丢弃。"
```

---

### Task 4: 切片侧白名单与图层同步

**Files:**
- Modify: `scripts/build_pmtiles.mjs`（`keepProps` 及其低级别降采样白名单、`ftype` 相关图层表）
- Test: 重建华东包后用 `verify_power_only.mjs` + `verify_pack.mjs`

**Interfaces:**
- Consumes: Task 3 的 `public/osm/huadong_power.geojson`
- Produces: `data/packs/osm-huadong.pmtiles`（纯电力、含新属性）

- [ ] **Step 1: 改 `keepProps` 与低级别白名单**

要求（与 prepare 的白名单一致，避免"两道白名单漂移"）：

```js
// build_pmtiles.mjs 内的属性白名单（名称以文件实际为准）
line:       ["osm_id", "name", "ref", "operator", "vclass", "voltage_kv", "line_kind", "cables", "wires", "circuits", "frequency"],
substation: ["osm_id", "name", "operator", "vclass", "voltage_kv", "substation_kind"],
plant:      ["osm_id", "name", "vclass", "voltage_kv", "plant_source", "plant_output"],
```

- 删除 `railway` / `pipeline` 的条目与任何相应图层/配色常量。
- **确认低级别（z < `cap-below-zoom`）的降采样属性集**：保持现有集合即可（本计划不引入 `is_dc`；那是 A2 的事）。

- [ ] **Step 2: 重建华东包**

```powershell
& "D:\Node,js\node.exe" scripts/build_pmtiles.mjs --name huadong --out data/packs/osm-huadong.pmtiles
```

> 🔴 **`--out` 必须显式给**：该脚本的默认输出写死为 `src-tauri/resources/maps/osm_grid.pmtiles`，
> 不给 `--out` 会**静默覆盖随安装包分发的核心区归档**（脚本自己也为此加了告警 —— 实测踩过：浙江盖掉长三角）。
> 用法已核实：`--in` 由 `--name` 推导（`public/osm/<name>_power.geojson`）。

- [ ] **Step 3: 断言归档纯电力**

```powershell
& "D:\Node,js\node.exe" scripts/verify_power_only.mjs data/packs/osm-huadong.pmtiles
```
Expected：`forbidden ftypes: (none)`、`verdict: PASS`。

- [ ] **Step 4: 跑既有包体检，确认切片参数未被破坏**

```powershell
& "D:\Node,js\node.exe" scripts/verify_pack.mjs data/packs/osm-huadong.pmtiles
```
Expected：退出码 0（电压分级与封顶断言仍成立）。

- [ ] **Step 5: 记录新体积（易失，写进提交信息，不写死进文档）**

```powershell
Get-Item data/packs/osm-huadong.pmtiles | Select-Object Name,Length
```

- [ ] **Step 6: 提交**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add scripts/build_pmtiles.mjs
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "feat(build): 切片白名单同步为纯电力，删除铁路/管道图层" -m "两道白名单（prepare 与 build）必须同步 —— 漂移会表现为'属性莫名消失'，且只在高缩放或低缩放其中一侧可见。"
```

---

### Task 5: 前端删除铁路/管道（显示层）

**Files:**
- Modify: `src/pages/MapPage.tsx`（`OSM_PIPELINE_LAYER_ID`/`OSM_PIPELINE_COLOR` ≈433-438、`INFRA_LAYERS`/`INFRA_SWATCH` ≈440-445、`LAYER_GROUPS` ≈465-474、建层 ≈2256-2285 与 ≈2446-2474、`packLayerIds` ≈545-546、可见性 effect ≈4587-4588 与 ≈4612-4613、图层面板 UI）
- Test: `tsc` + `vite build` + CDP 截图（沿用 `data/cdp_shot.mjs` 的既有做法）

**Interfaces:**
- Consumes: Task 4 的纯电力归档
- Produces: 界面上不再有铁路/管道入口；`LAYERS` 仍为 `["电厂","变电站","输电线路"]`

- [ ] **Step 1: 删除常量与图层组**

- 删 `OSM_PIPELINE_LAYER_ID` / `OSM_PIPELINE_COLOR`（铁路两个常量同理）；
- 删 `INFRA_LAYERS` 与 `INFRA_SWATCH`；
- `LAYER_GROUPS`：删掉 `{ id: "infra", label: "基础设施", … }` 整项；
- `packLayerIds()`：删 `railways` / `pipelines` 两行。

- [ ] **Step 2: 删除建层与可见性代码**

- 删两处铁路/管道 `addLayer`（核心区一次 + 区域包一次）；
- 删两处 `apply([...OSM_RAILWAY_LAYER_ID], on("铁路"))` 与管道同理（核心区与区域包各一处）；
- 全文件搜索 `铁路`、`油气管道`、`railway`、`pipeline`，确认业务路径清零（`PACKS_*`/数据管线等无关词不算）。

- [ ] **Step 3: 类型检查与构建**

```powershell
& "D:\Node,js\node.exe" .\node_modules\typescript\bin\tsc --noEmit
& "D:\Node,js\node.exe" .\node_modules\vite\bin\vite.js build
```
Expected：两条命令退出码均为 0。

- [ ] **Step 4: 浏览器实测（面板与图层）**

用既有 CDP 手法打开 dev/预览页，检查：
- 图层面板只剩「电力设施 / 环境与底图」两组，且「电力设施」里无铁路/管道项；
- 地图上不再出现灰色铁路线与粉色管道线（放大到长三角 z10 对比 Task 5 前的截图）；
- 1280×800 默认态面板**不溢出**（`clientHeight === scrollHeight`）。

- [ ] **Step 5: 提交**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add src/pages/MapPage.tsx
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "feat(map): 移除铁路与油气管道的显示（图层/组/配色/可见性）" -m "数据侧已在 prepare/build 删除，显示侧同步移除，避免留下'点了没反应'的空开关。"
```

---

### Task 6: 全量重建 + 文档同步

**Files:**
- Rebuild: 7 个区域包 + 核心区归档 `src-tauri/resources/maps/osm_grid.pmtiles`
- Modify: `README.md`、`README_OSM.md`、`PROJECT_HANDOFF.md`

**Interfaces:**
- Consumes: Task 3/4 的管线改动
- Produces: 可进入"发布计划 A3"的本地产物（**本计划不上传、不重打安装包**）

- [ ] **Step 1: 对 7 个区域重跑 prepare + build**

```powershell
foreach ($r in @('huadong','huazhong','huanan','huabei','dongbei','xinan','xibei')) {
  & "D:\Node,js\node.exe" scripts/prepare_osm_geojson.mjs --name $r
  & "D:\Node,js\node.exe" scripts/build_pmtiles.mjs --name $r --out "data/packs/osm-$r.pmtiles"
}
```
把每个包的**新体积与新要素数**记下来（易失数字，写进提交信息与 Task 6 Step 4 的文档更新，**不预设**）。

- [ ] **Step 2: 重建核心区归档（随安装包分发的那份）**

核心区是**合并片**，顺序与参数已核实（`README_OSM.md` 记录了这条链路）：

```powershell
# 1) 合并 yrd + zhejiang 的抓取产物（按 osm_id 去重）→ data/osm/core_power_*.geojson
& "D:\Node,js\node.exe" scripts/merge_osm_regions.mjs --name core --inputs yrd,zhejiang

# 2) 合并片 → public/osm/core_power.geojson
& "D:\Node,js\node.exe" scripts/prepare_osm_geojson.mjs --name core

# 3) 切片 → 随安装包分发的归档（🔴 必须显式 --out，且不得改切片参数）
& "D:\Node,js\node.exe" scripts/build_pmtiles.mjs --name core --out src-tauri/resources/maps/osm_grid.pmtiles
```

> ⚠️ 核心区归档按设计**不封顶**（不加 `--max-features-per-tile`），这是阶段29–37 结论成立的前提，
> 也与本项目刚修过的红线无关 —— **不得顺手改动**。

- [ ] **Step 3: 逐个断言**

```powershell
& "D:\Node,js\node.exe" scripts/verify_power_only.mjs data/packs/osm-huadong.pmtiles
```
对 7 个区域包与核心区归档**各跑一次**，全部 `verdict: PASS`。

- [ ] **Step 4: 更新文档（口径与历史一起改）**

- `README.md`：删掉「全要素 815,728 / 含铁路管道」的口径与阶段43 的相应描述，改为纯电力口径（写**实测**的新数字）；「图层面板」段落去掉基础设施组。
- `README_OSM.md`：抓取类别表、要素数、铁路/管道相关章节标注为**已撤销**（保留历史，注明日期与原因）。
- `PROJECT_HANDOFF.md`：§3.1 数据层口径表、§3.2、§5 关键文件、§6 红线（若有涉及）同步；并在阶段进度里新增「阶段56-A1」。

- [ ] **Step 5: 回归检查**

```powershell
& "D:\Node,js\node.exe" scripts/check_release_redlines.mjs --with-exe
& "D:\Node,js\node.exe" scripts/verify_packs.mjs
```
Expected：红线自检通过；本地校验里**中国 7 包会显示指纹不符**（清单尚未重算，属预期 —— 清单重算与上传在发布计划 A3，本计划明确不做）。

- [ ] **Step 6: 提交**

```powershell
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis add README.md README_OSM.md PROJECT_HANDOFF.md
& 'D:\Git\cmd\git.exe' -c safe.directory=J:/Projects/global-power-gis commit -m "docs: 阶段56-A1 文档同步 —— 数据面改为纯电力口径" -m "阶段43 引入的铁路/管道已整体撤销，历史记录保留并注明原因。要素数与体积按本轮实测写入。"
```

---

## 未包含（留给后续计划）

| 项 | 归属 | 原因 |
|---|---|---|
| 几何合并（杆塔级碎线 → 完整线路） | **A2** | 独立可验收单元，且会改变要素数与弹窗语义 |
| 换流站 / 海底电缆 / 直交流分档 | **A2** | 需要先跑 U1/U2 探测（`power=converter` 数量、`frequency` 覆盖率） |
| 图层面板三层折叠重构 | **A2** | 只有新增图层后才需要，与 A1 无关 |
| 清单重算 / 重传 Release / 重打安装包 / 包指纹失效策略 | **A3** | 属发布动作；且依赖 A1+A2 的最终产物 |
| 邻国数据面 | **项目 B** | 复用 A1+A2 改造后的管线 |

---

## 完成定义（Definition of Done）

1. 7 个区域包 + 核心区归档**全部**通过 `verify_power_only.mjs`（`verdict: PASS`）；
2. `verify_fetch_categories.py` 通过（抓取侧无死代码残留）；
3. 前端无铁路/管道入口，`tsc` 与 `vite build` 退出码 0，1280×800 面板不溢出；
4. 文档口径与实测数字一致，阶段43 历史明确标注撤销；
5. 全程**未新增依赖**、**未上传**、**未重打安装包**（这些属 A3）。
