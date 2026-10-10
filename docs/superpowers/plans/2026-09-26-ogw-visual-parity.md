# 项目 C（OpenGridWorks 视觉对齐 · 仅电力）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.
> ⚠️ 本 harness 的子代理**只有只读工具**（无 write/shell）⇒ **不能**用 subagent-driven-development，
> 必须**内联执行**。Steps 用 `- [ ]` 跟踪。

---

## ✅ 执行状态（**2026-10-09 复核：正文复选框未回填，一律以此表为准**）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 面数据（kp-kr 灰度 → 11 区域 + 核心区） | ✅ 14/14 区域完成 | 面要素合计 **41,670**；`README_OSM.md` §二十·十二 |
| T2 配色（只改常量） | ✅ 代码已改并过构建 | 五档冷色 + `PLANT_AREA_LAYER`（fill 0.35，插在电网图层**之下**）；`tsc --noEmit` **exit 0**；图层 id / vclass 未动 |
| T3 左面板四组开关 | ✅ 代码已改并过构建 | `CN_SUBSTATION_BANDS`（1000+/750-999/500-749/330-499/220-329/110-219/<110，中国体系）；⚠️ **Step5 人工核对开关未做** |
| T4 弹窗补字段 + ODbL 外链 | 🟡 代码已改，**验收未做** | 字段映射表与「在 OSM 打开」已落地（`src/pages/MapPage.tsx` 里由 `osm_id` 拆 `kind`/`id` 拼 URL）；❌ **Step3「点开实测三处」未做** |
| T5 文档与清单 | ✅ | `README_OSM.md` §二十、`PROJECT_HANDOFF.md` 数字表、`public/packs_manifest.json`（12/12 逐包一致） |
| §5 第 6/7/8 条（视觉 / 面板开关 / 标注） | ❌ **未做** | 需真机跑一次：先 `node scripts/install_packs.mjs --user-dir` 把 56-C 的包投进 `%APPDATA%`（本机现仍是 56-B 旧包），再走 CDP 流程 |
| §5 第 9 条（许可） | ✅ | 弹窗 ODbL 外链 + attribution 已落地 |
| §5 第 5 条（安装包 ≤ 50 MB） | ⏳ **待重打包** | 现有安装包是 2026-09-26 13:18 打的（内含 56-B 清单），**必须重打**（用户确认后才做） |

**仍未做的两件（承接 §8 风险）**：① 面层与线路的遮挡关系只做了代码层插位，**未做真机截图核对**；② 调色与面层**未在真机跑过**。

**Goal:** 在**不新增数据源、不新增依赖**的前提下，让本软件的电力地图在**观感与信息标注**上向
`opengridworks.com` 对齐：① 发电厂/光伏/风电场的**面状范围**；② 对齐它的**暗底冷色系配色**与
左面板**分组图例/分档开关**；③ 补上它弹窗里有、我们缺的那几个字段。

**范围：只做电力。** 光纤/海缆、数据中心、洪水风险、油气管道、燃气管道**一律不做**（用户明确）。
**只做中国**（含已交付的 5 个邻国批次）。

**Architecture:** 完全复用既有管线（`fetch_osm_power.py` → `prepare_osm_geojson.mjs` →
`build_pmtiles.mjs` → `MapPage.tsx`）。本计划**只加一个几何类型**（`plant_area`）、
**只改一处配色常量表**、**只加一层前端图例与开关**。

**Tech Stack:** Node（零新增依赖）+ Python 标准库 + PMTiles/MVT + MapLibre + Tauri v2（Rust 侧**不改**）。

**Spec / 调研依据:** 本项目 C 的调研结论见本文件 §0（**所有数字都标注了来源与可信度**）。

---

## 🚩 新窗口第一屏（照这个顺序开工）

```powershell
# 0) 确认起点状态（应输出 12、5、18）
node -e "const m=require('./public/packs_manifest.json');const c={};for(const p of m.packs)c[p.kind??'region']=(c[p.kind??'region']||0)+1;console.log(JSON.stringify(c),m.packs.length)"

# 1) 建分支（本计划会改动抓取脚本与已交付包的生成路径）
git checkout -b feat/c-plant-area-visual-parity

# 2) 记录基线（**不要跳过**：没有基线就无法证明零回归）
node scripts/verify_pack.mjs data/packs/osm-kp-kr.pmtiles | Tee-Object -FilePath data/_c_baseline_kpkr.txt
Get-Item data/packs/osm-kp-kr.pmtiles | Select-Object Name, Length
```

**然后按 Task 顺序做：T1（面数据，含强制灰度）→ T2（配色）→ T3（面板）→ T4（标注）→ T5（文档）。**

⚠️ **三条硬规矩**（违反会出静默故障）：
1. **T1 必须先只跑 `kp-kr` 并过 Step 5/6 的三道门禁与基线对照**，全绿才补跑其余 11 个区域；
2. **`--out` 必须显式**：`build_pmtiles.mjs` 默认写 `osm_grid.pmtiles`，会**静默覆盖核心区归档**；
3. **两道属性白名单必须同步**（`prepare_osm_geojson.mjs` 的 `KEEP_PROPS` ↔ `build_pmtiles.mjs` 的
   `keepProps`），漏一处 ⇒ 新字段在切片时被静默丢掉。

**开工前请确认范围的三个已知判断**（若你的判断不同，先改本文件再动手）：
- 🔴 **电压分档用中国体系**（110/220/330/500/750/1000），**不照抄** OpenGridWorks 的美制档位（345-499 等）——理由见 §0.4；
- 🔴 **不做**在线卫星底图、真 glow、光纤/海缆、数据中心（理由见 §1.2 与 §7）；
- 🔴 **许可类约束不取消**：OSM 署 ODbL + "在 OSM 打开"外链，GEM/WRI 署 CC BY 4.0（§7 B 类）。

> ### ⚠️ 行号基准（读完这段再动手）
> 本文件所有 `文件:行号` 都**已逐一核对**过，基准提交是 **`90a46d9`**。
> 行号只用于**快速定位**；若与代码不符，**以 grep 到的符号名为准**（下面每条都给了符号/字面量）。
> 核对命令：
> ```powershell
> Select-String -Path scripts/fetch_osm_power.py -Pattern "^def build_feature|^def element_center|^def way_to_linestring"
> Select-String -Path scripts/prepare_osm_geojson.mjs -Pattern "^const KEEP_PROPS|^const FILES"
> Select-String -Path scripts/build_pmtiles.mjs -Pattern "keepProps: \[|collapseProps: \["
> Select-String -Path src/pages/MapPage.tsx -Pattern "^const OSM_LINE_TIERS|^function packLayerIds|^function addPackLayers"
> ```

---

## 0. 前置：已核实的事实（**不要重新调研，直接采信；有疑义按"验证命令"复核**）

### 0.1 我们在跑什么（实测，2026-09-25 收尾）

| 项 | 实测 | 来源 |
|---|---|---|
| 区域包 | **12 个**（国内 7 + 邻国 5）：543,523 要素 / **241.16 MB** | `public/packs_manifest.json` 求和 |
| 底图包 | **5 个**（`kind:"basemap"`，`forRegion` 关联）：**80.52 MB** | 同上 |
| 阶段状态 | T0–T10 + T12 完成；T11 七条里 ①②③⑦ + ⑥体积半条已闭合，④⑤ 已运行时实测闭合 | `2026-09-25-china-neighbors-b.md` |
| 构建/红线 | `tsc`/`vite build` 0；安装包 **46.09 MiB ≤ 50 MB**（实测 48,327,873 B）；`check_release_redlines.mjs --with-exe` 通过 | 同上 |

### 0.2 关键发现一：**面数据我们"拿到了却降级成点"**（这是本计划的核心依据）

一次**只读** Overpass 查询（上海西北 `31.1,121.0,31.45,121.6`，2026-09-26 实测）：

```
way["power"="plant"] + node["power"="plant"]  →  11 个要素
几何统计: { node: 0, way_closed: 11, way_open: 0 }
```

样本（`out tags geom;` 原文）：

```
江苏华电昆山热电有限公司              plant:source=gas    landuse=industrial  operator=徐州矿务/中国华电-华电江苏   source=gem.wiki/...
宝山钢铁股份有限公司自备电厂(燃煤机组)   plant:source=coal   landuse=industrial  operator=宝武钢铁
上海外高桥第二发电有限责任公司         plant:source=coal   landuse=industrial  operator=国家能源-北京国电/申能股份/国家电投-上海电力
中国石化上海高桥石油化工有限公司动力部   plant:source=coal   landuse=industrial  operator=中国石化
```

而我们**本机产物**里全是点（实测）：

```
data/osm/huadong_power_plants.geojson   5,650 要素 → {"Point": 5650}，面 0
data/osm/ca_power_plants.geojson        2,131 要素 → 全部 Point
data/osm/kp-kr_power_plants.geojson     5,361 要素 → 全部 Point
```

**根因（已定位到函数）**：`scripts/fetch_osm_power.py` 的 `build_feature()`（`:410`）里，
`plant` / `substation` 走的是最后那个分支（`:442-451`），无条件调用
`element_center()`（`:372-392`，取**包围盒中心**）→ 闭合 way 的环被丢掉，只留一个代表点。
而 `way_to_linestring()`（`:358-369`）**只被 `line` 分支用**，面根本没被构造过。
**查询本身没问题**：`:551-552` 已经是 `node["power"="plant"]; way["power"="plant"];` 两个都查。

⇒ **复刻"范围"不需要新数据源，只需保留几何。**

### 0.3 关键发现二：它的配色（**像素实测，非目视猜**）

对 3 张截图做 16 级量化 + 饱和度×频次排序，实测主色：

| 用途 | 实测值 | 可信度 |
|---|---|---|
| 支线/次要电压（青） | `#28D8F8` / `#28E8F8` | 高（492/442 px 成片） |
| 主干线路（蓝） | `#3888F8` | 高（626 px） |
| 线路渐变（深蓝→紫） | `#3878E8` → `#3868C8` → `#2858A8` → `#4848A8` | 中（抗锯齿过渡带） |
| **光伏场范围（金）** | 描边/主色 `#D8A828`，填充 `#886818` | 高（267 / 3,204 px） |
| **选中机组框（红）** | `#F83838` | 高（560 px） |
| 生物质/垃圾电厂范围（绿） | 绿通道占优，样本偏 `#2F4430` 一带 | 低（需复核） |
| 暗底 | `#0E0E0E` / `#131A25` | 高 |

⚠️ **精度边界**：截图为抗锯齿后的近似（±1 分级）；**该站未发布公开样式表/开源仓库**
（已查证），`opengridworks.com` 直读被 Vercel 拦（HTTP 429）。
⇒ 若要求 100% 精确，需由**人在浏览器 DevTools 里读 CSS**（本计划按实测值实施，并保留可微调常量）。

### 0.4 关键发现三：它的左面板结构（截图像素级观察）

```
燃料分组：煤 / 油 / 地热 / 生物质 / 其他        ← 每项带"数量 + 容量"
尺寸（兆瓦）图例：100MW / 500MW / 1GW / 2.5GW / 5GW
  旁注："缩放比例15.9 | 气泡大小1.00倍"
光纤基础设施：海底电缆 / 着陆点                  ← 本项目不做
传播（输电）：HVDC / 735+ / 500-734 / 345-499 / 220-344 / 100-219 / 31-99 / <31 / 互连缝
变电站：500+ / 345-499 / 230-344 / 100-229 / 31-99 / <31 kV   ← 每项带计数
底部：Layers 按钮 + 语言切换（中/英）
```

URL 参数（站内证据）：`?lat=&lng=&z=&layers=b,datacenters,chpoints,osm,gem,...&tx=…&cos=…`

> 🔴 **重要判定：它的电压分档是美制的**（345-499 / 230-344 / 31-99 kV），
> 与中国实际体系（110/220/330/500/750/1000 kV）**不吻合** ⇒ 这些档在中国大半是空档。
> **本计划按中国电压等级分档，不照抄它的档位**——照抄会得到一个"看着像、用着错"的面板。

### 0.5 红线（**不可取消**，见 §7）

许可与合规类约束**不能**因为"要对齐观感"而放开：OSM 须署 ODbL、GEM/WRI 须署 CC BY 4.0、
Overpass 须节流、商业数据不采购、许可未明确前不下载不分发。

---

## 1. 目标与非目标

### 1.1 目标（本计划的**全部**范围）

1. **面状发电设施**：把 `power=plant` 的闭合 way 保留为 `Polygon`/`MultiPolygon`，
   新增 `ftype=plant_area`，前端按燃料类型填色（光伏金 / 风电青 / 煤灰 / 气橙 / 水蓝 / 生物质绿）。
2. **配色对齐**：把电力图层配色常量表换成 §0.3 的实测色（**只改常量**，不动渲染逻辑）。
3. **左面板对齐**：新增"燃料分组（带数量/容量）"、"尺寸图例（气泡分级 + 缩放倍率）"、
   "输电按电压分档开关"、"变电站按**中国电压等级**分档开关"。
4. **信息标注对齐**：弹窗补 `plant:source`、`landuse`、`source` 字段 + "在 OSM 打开"外链按钮。

### 1.2 非目标（明确不做，避免范围漂移）

| 不做 | 理由 |
|---|---|
| 光纤 / 海底电缆 / 着陆点 | 来源为商业授权（TeleGeography），项目红线排除；用 OSM 顶替须如实标注覆盖口径 |
| 数据中心 / 洪水风险区 / 油气管道 | 用户明确"其他不做，主要做电力" |
| 在线卫星底图切换 | 与"完全离线"定位冲突（要改就单独立项） |
| **真光晕（glow）** | 不引依赖做不到；可用 2–3 层递减宽度描边**模拟**，本计划不在范围 |
| 地图上的燃料图标（sprite icon） | 需要 sprite 资源与打包流程；本计划先做**图例图标 + 颜色**，地图端只做颜色 |
| GEM 的 `[site analysis]` | 那是 GEM 站内页面，**外链**即可，不抄内容 |
| GEM 实体/母公司/退役年字段 | 需要换 GEM 数据粒度（另一个项目：见 §6 后续），本计划只做 OSM 侧 |
| 新增 npm / cargo 依赖；改 Rust 侧 | 项目红线（若确需放开，见 §7 A 类，须单独授权） |
| 全国加密抓取 | 属"面数据扩大覆盖"的后续项，见 §6 |

---

## 2. 文件结构（改动地图）

| 文件 | 职责 | 动作 |
|---|---|---|
| `scripts/fetch_osm_power.py` | OSM 抓取；**几何规整在这里丢了面** | **T1 改**（新增 area 产物与闭合判定） |
| `scripts/prepare_osm_geojson.mjs` | 属性白名单 + ftype 判别 + 合并 | **T1 改**（新增 `plant_area` 的 `KEEP_PROPS` 与 `FILES`） |
| `scripts/build_pmtiles.mjs` | 切片；属性白名单**必须与 prepare 同步** | **T1 改**（`keepProps` 加同名字段） |
| `scripts/verify_pack.mjs` | 门禁 | **T1 改**（加一条"面要素存在"断言，可复用现有结构） |
| `src/pages/MapPage.tsx` | 图层栈、配色常量、弹窗、面板 | **T2/T3/T4 改** |
| `src/lib/packs.ts` | 品类判定 | 不改 |
| `docs/README_OSM.md` §十九 | 阶段记录 | **T5 改**（新增阶段56-C 一节） |

---

## 3. 计划总表

| # | 任务 | 产物 | 验收（命令 → 期望） | 预计 |
|---|---|---|---|---|
| T1 | 面状发电设施（数据面 + 切片 + 门禁） | `data/osm/<r>_power_plant_areas.geojson`、`ftype=plant_area`、新包 | 3 个门禁全 PASS；**灰度单区**先验证 | 2–3 h + 抓取 |
| T2 | 配色对齐（常量表） | `OSM_LINE_TIERS` 等常量 | `tsc`/`vite build` 0；人工比对截图 | 1 h |
| T3 | 左面板：燃料分组 + 尺寸图例 + 分组开关 | `MapPage.tsx` 面板 | 开关即时生效；统计数字与包一致 | 3–4 h |
| T4 | 信息标注：弹窗补字段 + OSM 外链 | `MapPage.tsx` 弹窗 | 点开的字段与 OSM 标签一致 | 1–2 h |
| T5 | 文档同步 | `README_OSM.md` 阶段56-C | 口径/体积/字段与实测一致 | 0.5 h |

---

## 4. 实施前的**唯一硬前置**：灰度单区验证（不许跳过）

⚠️ **T1 会改动已交付 12 个包的几何生成路径。** 先在一个**最小区域**上验证，
确认"只增不减"，再决定是否重跑其余区域。

**Step 0：记录基线（必须留档，否则无法证明零回归）**

```powershell
# 记录当前 kp-kr 包的要素数/体积/最大单瓦片（这是"改动前"的对照组）
node scripts/verify_pack.mjs data/packs/osm-kp-kr.pmtiles | Tee-Object -FilePath data/_c_baseline_kpkr.txt
Get-Item data/packs/osm-kp-kr.pmtiles | Select-Object Name, Length
```

Expected: 4.51 MB / 要素 15,863 / z<8 带 is_dc = 100%（与 `2026-09-25-china-neighbors-b.md` 的 T8 表一致）

---

## Task 1: 面状发电设施（`ftype=plant_area`）

**Files:**
- Modify: `scripts/fetch_osm_power.py`（`POWER_KIND_TO_FTYPE` `:129`、`CATEGORY_KINDS` `:130`、
  `way_to_linestring` `:358`、`element_center` `:372`、`build_feature` `:410`、plant 查询 `:551-552`）
- Modify: `scripts/prepare_osm_geojson.mjs`（`KEEP_PROPS` `:92`、`FILES` `:112`、
  `coordsValid` `:144`、`roundCoords` `:153`）
- Modify: `scripts/build_pmtiles.mjs`（**注意有三处**：OSM 电力 `keepProps` `:85-114`、
  低级别 `collapseProps` `:146`、GEM `keepProps` `:195-205`）
- 产物：`data/osm/<name>_power_plant_areas.geojson`

**Interfaces:**
- Consumes: 既有 `--category power` 抓取通道（**不改查询**——`way["power"="plant"]` 已在查）
- Produces: 归档内新增 MVT 图层 `plant_area`，属性 `{ osm_id, name, vclass, plant_source, landuse, source_url, area_ha }`

- [ ] **Step 1: 抓取侧——保留闭合 way 的环**

在 `scripts/fetch_osm_power.py` 增加（与 `way_to_linestring` 并列，**不要改动它**）：

```python
def way_to_polygon(element: dict[str, Any]) -> list[list[list[float]]] | None:
    """闭合 way → 单环多边形（GeoJSON 的 Polygon 坐标：[[[lon,lat], ...]]）。

    · 判据：首尾顶点相同（OSM 的 area 就是这个约定）
    · 洞（inner ring）需要 multipolygon relation 才能表达；本脚本只取 way，
      所以**只有外环** —— 这在电厂地块上几乎不出错（截图里也都是单纯多边形）。
    """
    coords = way_to_linestring(element)
    if not coords or len(coords) < 4:
        return None
    if coords[0] != coords[-1]:
        return None          # 不是闭合环 ⇒ 交给原来的点逻辑
    return [coords]
```

在 `build_feature()` 的 **plant 分支之前**加一个分支（`geom_type == "plant_area"`）：

```python
    if geom_type == "plant_area":
        ring = way_to_polygon(element)
        if ring is None:
            return None                       # 开放 way / 太短的，不进面层（点层仍然有它）
        if tags.get("power") != "plant":
            return None
        props["power"] = tags.get("power")
        props["plant_source"] = tags.get("plant:source")
        props["landuse"] = tags.get("landuse")
        # ‼️ `source` 在 OSM 里可能是 gem.wiki 链接（实测上海多个电厂就是），
        #    保留它既是对齐它的弹窗，也是 ODbL/CC-BY 署名的依据
        props["source_url"] = tags.get("source")
        return {"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": ring}}
```

并把 `power` 类别扩成两类产物（**注意：不要改动现有三个桶的名字与路径**）：

```python
CATEGORY_KINDS = {
    "power": ["lines", "substations", "plants", "plant_areas"],   # ← 只加这一项
    "converters": ["converters"],
}
POWER_KIND_TO_FTYPE = {
    "lines": "line", "substations": "substation",
    "plants": "plant", "plant_areas": "plant_area", "converters": "converter",
}
```

并让 `plants` 与 `plant_areas` **共用同一条 union 查询**（两者都是 `way["power"="plant"]`，
分两次查会浪费一半请求；在 `:551-552` 那一处把两个 kind 合并成一次查询、各写各的桶）。

> ⚠️ **不要**把点层的 `plants` 去掉：OSM 里很多电厂**只有 node 没有 way**（尤其小厂），
> 去掉点会造成要素数下降的假回归。

**Expected:** 新产物 `<name>_power_plant_areas.geojson` 存在，且要素数 = 该区域闭合 way 数。

- [ ] **Step 2: prepare 侧——加白名单与几何支持**

`scripts/prepare_osm_geojson.mjs`：

1. `KEEP_PROPS` 加一行：
   ```js
   plant_area: ["osm_id", "name", "vclass", "voltage_kv", "plant_source", "landuse", "source_url", "area_ha"],
   ```
2. `FILES` 加一行：
   ```js
   { ftype: "plant_area", src: (n) => `${n}_power_plant_areas.geojson`, power: true },
   ```
3. `coordsValid()`（`:144-149`）已支持 `Polygon` ✅ —— **但要确认** `MultiPolygon` 也在
   （若无则加一行；本计划只产出 Polygon，加 `MultiPolygon` 是为将来 relation 留口）。
4. `roundCoords()`（`:153-159`）已支持 `Polygon` ✅
5. **面积计算**（可选但推荐，用于对齐它的 `Area 17.0 ha`）：
   在 prepare 里用**鞋带公式**算 `area_ha`（纯 JS，无依赖；按 Web Mercator 的纬度校正）：
   ```js
   function ringAreaHa(ring) {
     let a = 0;
     for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
       a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
     }
     const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
     const mPerDegLat = 111132.0;
     const mPerDegLon = 111320.0 * Math.cos((meanLat * Math.PI) / 180);
     return Math.abs(a / 2) * mPerDegLat * mPerDegLon / 10000; // ⇒ 公顷
   }
   ```
   ⚠️ 这是**近似**（球面/平面换算），必须与它一样在界面上标注口径，不许写成精确值。

- [ ] **Step 3: 切片侧——白名单同步（最容易漏的一处）**

`scripts/build_pmtiles.mjs` 里有**三处**相关白名单，别只改一处：

| 位置 | 是什么 | 本任务要不要改 |
|---|---|---|
| `:85-114` `keepProps`（OSM 电力包） | 高缩放级保留的字段 | ✅ **要改**：加 `landuse` / `source_url` / `area_ha` |
| `:146` `collapseProps: ["ftype","vclass","is_dc"]` | 低缩放级（z<8）收敛字段 | ❌ **不要改**：面数据不该在低级别撑大瓦片（见该行上方 `:513-539` 的高基数字段告警机制） |
| `:195-205` `keepProps`（GEM 包） | GEM 的字段 | ❌ 不动（改它会连带影响 GEM 包） |

⚠️ **不要**把 `name` / `source_url` 塞进 `collapseProps`：`:528-539` 有个高基数字段检查，
这些是逐要素自由文本，进低级别会让每张瓦片字符串表被撑大（该处已用实测说明代价）。

改完立刻对照两处白名单的键集合：

```powershell
Select-String -Path scripts/prepare_osm_geojson.mjs -Pattern "plant_area"
Select-String -Path scripts/build_pmtiles.mjs     -Pattern "landuse|source_url|area_ha|collapseProps"
```

Expected: 两处都出现新字段；`collapseProps` 那行**仍然是** `["ftype", "vclass", "is_dc"]`。

- [ ] **Step 4: 灰度单区跑通（先 kp-kr，不要一上来全国重跑）**

```powershell
node scripts/run_pipeline.mjs --regions kp-kr --category power,converters `
  --endpoint https://overpass-api.de/api/interpreter
```

Expected: `[fetch:power]` 出现 **4 个桶**（lines/substations/plants/plant_areas）→ `▶ prepare` → `▶ build`

> ⚠️ **不要**加 `--out` 以外的新参数；`--out` 必须显式（`build_pmtiles.mjs` 默认写
> `osm_grid.pmtiles` 会**静默覆盖核心区归档**）。

- [ ] **Step 5: 门禁（三道，缺一不可）**

```powershell
node scripts/verify_power_only.mjs data/osm/kp-kr_power_plant_areas.geojson
node scripts/verify_power_only.mjs data/packs/osm-kp-kr.pmtiles
node scripts/verify_pack.mjs        data/packs/osm-kp-kr.pmtiles
```

Expected:
- `verify_power_only`（geojson）：`missing=(none)`、`verdict: PASS`
- `verify_pack`：**8 项断言全绿**，且
  - `z<8` 带 `is_dc` = **100%**（面层不能影响线路判定）
  - 新增断言：z>=8 的瓦片里**存在 `plant_area` 图层且要素数 > 0**

- [ ] **Step 6: 零回归对照（硬性）**

```powershell
node -e "const{execSync}=require('child_process');" # 或直接人工比对
Get-Content data/_c_baseline_kpkr.txt
node scripts/verify_pack.mjs data/packs/osm-kp-kr.pmtiles
```

Expected:
- 要素数 **≥** 基线 15,863（点了的不会少，面是净增）
- `frequency` 覆盖率、`is_dc` 判定、最大单瓦片（< 500 KB）**不变**
- 体积增幅记录在案（面数据会增加体积，需评估是否影响 50 MB 红线——**数据包不进安装包，所以不影响**）

**任一条不符 ⇒ 停止，先定位，不要继续跑其余 11 个区域。**

- [ ] **Step 7: 补跑其余区域**

kp-kr 全绿后，按既有批次表逐批跑（可断点续跑）：

```powershell
node scripts/run_pipeline.mjs --regions huadong,huazhong,huanan,huabei --category power,converters --endpoint https://overpass-api.de/api/interpreter
node scripts/run_pipeline.mjs --regions dongbei,xinan,xibei --category power,converters --endpoint https://overpass-api.de/api/interpreter
node scripts/run_pipeline.mjs --regions mn,sea-mainland,ca,ru-far --category power,converters --endpoint https://overpass-api.de/api/interpreter
```

Expected: 每批 `status: ok`、`failed_chunks: []`；每批跑完立刻跑 Step 5 的三道门禁。

- [ ] **Step 8: 清单与发布（顺序不能反）**

```powershell
node scripts/gen_packs_manifest.mjs
node scripts/upload_packs.mjs --dry-run     # 期望：已一致的跳过 + 变更的 12 个"新增/替换"
node scripts/verify_packs.mjs --remote      # 上传后：退出码 0
```

⚠️ `upload_packs.mjs` 默认**交互式**确认；脚本化必须加 **`--yes`**，否则会以
`Detected unsettled top-level await` 退出（exit 1，看起来像失败）。
⚠️ **上传是对外发布，需用户明确确认后才执行。**

---

## Task 2: 配色对齐（只改常量）

**Files:** Modify: `src/pages/MapPage.tsx`（`OSM_LINE_TIERS` `:390`、`OSM_LINE_TIERS_BOTTOM_UP` `:417`、
`BASEMAP_PAINT` `:1806`、新增 `PLANT_FILL`；面层挂载：`addOsmGridLayers` `:2646`、`addPackLayers` `:2885`、
`packLayerIds` `:647`、`removePackLayers` `:3285`）

- [ ] **Step 1:** 把 `OSM_LINE_TIERS` 的颜色换成实测色带（**保留 id 与 vclass 不变**——它们被 filter 与开关引用）：

```ts
// 实测来自 opengridworks.com 截图像素统计（§0.3），冷色带：电压越高越"深蓝"
const OSM_LINE_TIERS = [
  { id: "osm-line-735",     vclass: "735+",     color: "#2f6fd8", width: 3   },
  { id: "osm-line-500",     vclass: "500-734",  color: "#3888f8", width: 2   },
  { id: "osm-line-220",     vclass: "220-499",  color: "#28b8f8", width: 1.5 },
  { id: "osm-line-lt220",   vclass: "<220",     color: "#28d8f8", width: 0.8 },
  { id: "osm-line-unknown", vclass: "unknown",  color: "#5a7a94", width: 1   },
];
```

- [ ] **Step 2:** 新增燃料填充色常量（供 T1 的面层用）：

```ts
const PLANT_FILL = {
  solar: "#d8a828", wind: "#28d8f8", coal: "#8a8f98", gas: "#f0883e",
  hydro: "#3f8fd8", biomass: "#4a8f52", waste: "#4a8f52", nuclear: "#b06fd8",
  oil: "#a06a3a", geothermal: "#d85858", battery: "#7ad0a0",
} as const;
const PLANT_FILL_FALLBACK = "#6b7280";
```

- [ ] **Step 3（面层图层）:** 在 `BASEMAP_LAYERS` 之后新增 `PLANT_AREA_LAYER`：
  `type: "fill"`，`source: BASEMAP_SOURCE`（**不是**——面层属于区域包，见下），
  `filter: ["==", ["get","ftype"], "plant_area"]`，
  `paint: { "fill-color": <match plant_source>, "fill-opacity": 0.35, "fill-outline-color": <同色> }`

  ⚠️ **面层的挂载通道要跟着区域包走**：区域包的图层加在 `addPackLayers()`
  （`MapPage.tsx:2885`），核心区加在 `addOsmGridLayers()`（`:2646`）。
  **两处都要加**，否则"包里有面、核心区没有"（或反之）——这类不一致是静默的。

- [ ] **Step 4:** `packLayerIds()`（`:647`）加 `plantArea: packLayerId(OSM_PLANT_AREA_LAYER_ID, key)`，
  并确认 `removePackLayers()`（`:3285`）是**遍历 `packLayerIds()` 全部字段**卸载的
  （实测该处已是这个写法 ✅ ⇒ 新增字段自动被卸载，**但必须确认**，不要凭本计划断言）。

- [ ] **Step 5:** `tsc --noEmit` 0 与 `vite build` 0 → 记录 bundle 体积变化

---

## Task 3: 左面板对齐（燃料分组 / 尺寸图例 / 分组开关）

**Files:** Modify: `src/pages/MapPage.tsx`（图层面板 JSX，约 `:5739` 的"环境与底图：预留占位"附近）

⚠️ **中国电压等级分档**（**不要照抄它的美制档位**）：

```ts
// 中国实际体系：1000 / 750 / 500 / 330 / 220 / 110 / 35 / 10 kV
const CN_SUBSTATION_BANDS = [
  { key: "1000+", label: "1000 kV 及以上", test: (kv) => kv >= 1000 },
  { key: "750-999", label: "750-999 kV",   test: (kv) => kv >= 750 && kv < 1000 },
  { key: "500-749", label: "500-749 kV",   test: (kv) => kv >= 500 && kv < 750 },
  { key: "330-499", label: "330-499 kV",   test: (kv) => kv >= 330 && kv < 500 },
  { key: "220-329", label: "220-329 kV",   test: (kv) => kv >= 220 && kv < 330 },
  { key: "110-219", label: "110-219 kV",   test: (kv) => kv >= 110 && kv < 220 },
  { key: "lt110",   label: "110 kV 以下",  test: (kv) => kv < 110 },
];
```

- [ ] **Step 1:** 燃料分组：按 `plant_source` 分组显示**数量 + 容量**（容量字段为
  `plant_output`，覆盖率**必须实测后标注**，不许假设 100%）。数据来源有二选一：
  - 从当前视野的已加载瓦片聚合（`querySourceFeatures`，与 `refreshClusterLabels` `:4170` 同一手法）；
  - 或从 seed 库 `power_plants` 聚合（**口径不同**：WRI 全球库 vs OSM 瓦片，**不能混报**）。
  **本计划取前者**（与地图所见一致），并在 UI 上注明"仅统计当前视野"。
- [ ] **Step 2:** 尺寸图例：5 档同心圆（100MW/500MW/1GW/2.5GW/5GW）+ 旁注
  `缩放比例<当前 zoom> | 气泡大小1.00倍`。
- [ ] **Step 3:** 输电分档开关：复用现有 `OSM_LINE_TIERS`（**已经有一档一开关**，`toggleTier`），
  按实测色带重排顺序（低→高）。
- [ ] **Step 4:** 变电站按 `CN_SUBSTATION_BANDS` 分档开关：
  需要新增可见性键（当前面板只有"变电站"总开关）。**注意 `visibleLayers` 的键名会被持久化**，
  新增键要有默认值，避免老用户升级后读到未知键。
- [ ] **Step 5:** `tsc`/`vite build` 0；人工核对：每个开关能即时生效、关掉后不残留
  （⚠️ MapLibre 的 `setLayoutProperty` 对不存在的图层是**静默失败**，必须逐个 `getLayer` 判空）

---

## Task 4: 信息标注（弹窗字段 + OSM 外链）

**Files:** Modify: `src/pages/MapPage.tsx`（弹窗构造，参考现有的 `showOsmPointOrLine` 与 GEM 弹窗）

- [ ] **Step 1:** OSM 要素弹窗补字段并映射为中文标签：

| 它的字段 | 我们的来源 | 备注 |
|---|---|---|
| 电压 | `voltage_kv` | ✅ 已有 |
| 类型 | `substation_kind` / `line_kind` | ✅ 已有 |
| 相位（=Status） | `vstate` | ✅ 已有（**不要**把它当"相位"，语义是运行状态） |
| 力量（=Power） | `power` | ✅ 已有 |
| 地点 | `country` = "CN" | 常量 |
| 频率 | `frequency` | 🟡 线路有，且**覆盖率实测仅约 11%**（全局）⇒ 缺失时显示"—"，不要编造 |
| OSM ID | `osm_id` | ✅ 已有 |
| 操作者 | `operator` | ✅ 已有（实测就是"国家电投/申能股份"这类中国集团口径） |
| 来源（面层） | `source_url` | 🆕 T1 新增（很多直接是 `gem.wiki/...`） |
| 面积（面层） | `area_ha` | 🆕 T1 新增，**必须标注"近似值"** |

- [ ] **Step 2:** 加"在 OSM 打开"外链按钮（对齐它的「开放街道地图」），URL 由 `osm_id` 拼：
  `https://www.openstreetmap.org/{type}/{id}` —— 这同时**履行了 ODbL 的署名与溯源义务**。
- [ ] **Step 3:** 点开实测三处（上海外高桥、宝钢自备电厂、一个光伏场），核对字段与 OSM 网站一致。

---

## Task 5: 文档同步

- [ ] **Step 1:** `README_OSM.md` 新增 **§二十 阶段56-C：面状发电设施与视觉对齐**，
  记录：实测色板（§0.3）、`plant_area` 的字段与近似面积口径、**与 OpenGridWorks 的异同**
  （同源 OSM + GEM；它是美制电压分档、我们是中国体系；在线卫星底图与 glow 我们不做）。
- [ ] **Step 2:** `PROJECT_HANDOFF.md` 数字表加"面要素数 / 体积增量"。
- [ ] **Step 3:** 若 `docs/DATA_SOURCES_ROADMAP.md` 仍在维护，把 §0 的三条实测发现补进去，
  并把"站点无法直读"升级为"已有站内截图证据（面板分档/弹窗字段/面状要素）"。

---

## 5. 验收总表（照做即可判定完成）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 面数据存在 | 每个区域包的归档里 `plant_area` 图层要素数 > 0，且 **与 OSM 闭合 way 数一致**（抽样一个县比对） |
| 2 | 零回归 | 12 个包的**要素数不降**、`is_dc` 判定仍 100%、最大单瓦片仍 < 500 KB |
| 3 | 三道门禁 | `verify_power_only`(geojson) / `verify_power_only`(pmtiles) / `verify_pack` 全 PASS |
| 4 | 构建 | `tsc --noEmit` 0；`vite build` 0；`check_release_redlines.mjs --with-exe` 通过 |
| 5 | 体积红线 | 安装包仍 ≤ 50 MB（**手工量 NSIS 产物**——红线脚本不含体积判据） |
| 6 | 视觉 | 燃料/电压配色与实测色板一致；面层填色与描边可见、不遮挡线路 |
| 7 | 面板 | 燃料分组、尺寸图例、输电分档、变电站分档（中国档位）四组开关即时生效、无残留 |
| 8 | 标注 | 弹窗字段与 OSM 一致；`frequency` 缺失显示"—"；面积标"近似" |
| 9 | 许可 | 地图与弹窗均可看到 OSM/GEM 署名；"在 OSM 打开"外链可用 |

---

## 6. 后续（**本计划不做**，列出以免被判为遗漏）

| 项 | 依据 |
|---|---|
| GEM 机组级字段（Entity/Owner/Parent/Online year/Retirement years/Nearby plants） | 需换 GEM 数据粒度；同组织、CC BY 4.0，无新合规问题 |
| 风场"由 N 台机组推导的包络" | 需自己实现算法，且**必须标注"由机组位置估算"**（它就是这么标的） |
| 全国加密抓取（覆盖到每个省） | 按实测锚点（≈87 秒/块）推算约 5–10 小时挂机 |
| 省间互连层 | 候选：figshare《中国输电网空间数据集 2015/2020/2025》(CC BY 4.0)、Zenodo 省间输电+小时负荷（**许可待核实，未核实不得下载**） |
| 真 glow / 在线卫星底图 | 需要改技术栈或改产品定位，须单独授权 |
| 地图上的燃料 sprite 图标 | 需要 sprite 打包流程（新增资源，非 npm 依赖） |

---

## 7. "原有开发限制"的处理（**必须先读**）

你问过"能否取消各种原有开发限制"。按性质分三档：

### 🟢 A 类：技术/产品取舍 —— **可以取消，但本计划不需要取消**

| 约束 | 现在 | 本计划是否需要放开 |
|---|---|---|
| 零新增 npm/cargo 依赖 | 项目红线 | ❌ 不需要（T1–T4 全部用现有工具与标准库） |
| Rust 侧不改 | 已验证不需要 | ❌ 不需要 |
| 安装包 ≤ 50 MB | 当前 46.09 MiB（48,327,873 B）；56-C 需重打包 | ❌ 不需要（电力数据**不进安装包**，按需下载） |
| 完全离线 | 定位取舍 | ⚠️ 想复刻"在线卫星底图"就必须放开它——**本计划不做** |
| 只做电力 | 你已确认 | ❌ 不改（正是本计划的前提） |

### 🔴 B 类：许可与合规 —— **不能取消**（取消 ≠ 放宽，是违约）

| 约束 | 出处 | 为什么挡不住本计划 |
|---|---|---|
| OSM 须署 ODbL、衍生同许可 | ODbL 法定 | T4 的"在 OSM 打开"外链**正好履行**它 |
| GEM / WRI 须署 CC BY 4.0 | 许可法定 | 我们已分开署名，不混 ODbL |
| Overpass 公平使用（分块+节流） | 公共实例规则 | 沿用现成的分块与 `QUERY_WAIT` |
| 许可未明确前不下载不分发 | `DATA_SOURCES_ROADMAP.md:75` | 本计划**不引入任何新数据源** ⇒ 不触碰 |
| 不采购商业数据 | 用户既定 | 光纤/海缆列在非目标 |

⇒ **结论：本计划的全部范围都在"不需要取消任何约束"之内。**

---

## 8. 已知风险与处置

| 风险 | 表现（**静默**的多） | 处置 |
|---|---|---|
| 面层遗漏某个挂载通道 | 包里有面、核心区没有（或反之） | `addOsmGridLayers` 与 `addPackLayers` **两处都加**；用核心区与一个包各验一次 |
| 两道属性白名单不同步 | 新字段切片时被静默丢掉 | Step 3 的两处 grep 对照 |
| 面层压住线路 | 视觉上线路变暗 | 面层用低透明度（0.35）+ 插在电网图层之下（`moveLayer` 精确插位，与底图叠加层同一手法） |
| 面积算成"精确值" | 误导 | 鞋带公式是近似，UI 必须标"近似" |
| 用 WRI/OSM 两个口径混报统计 | 数字对不上却看不出来 | 燃料统计只用**当前视野瓦片**一个口径，并注明 |
| 电压档照抄美制 | 面板看着像、实际大半空档 | 用 `CN_SUBSTATION_BANDS`（中国体系） |
| 重跑全部区域前未灰度 | 一旦有回归，12 个包全污染 | Step 4–6 强制先跑 `kp-kr` 并与基线对照 |

---

## 9. 自检（对本次调研逐条）

| 调研结论 | 落在哪个任务 |
|---|---|
| 面数据"拿到了却降级成点"（§0.2） | T1 |
| 配色实测值（§0.3） | T2 |
| 左面板结构与美制档位问题（§0.4） | T3 |
| 弹窗字段差异 | T4 |
| 许可红线不可取消（§0.5 / §7） | T5 + §7 |
| GEM 机组级 / 全国加密 / 省间互连 | §6（明确不在本计划） |
