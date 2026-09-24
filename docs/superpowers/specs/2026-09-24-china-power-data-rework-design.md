# 中国纯电力数据面重构 —— 设计文档（项目 A）

> 日期：2026-09-24（阶段 56）
> 状态：**待用户复核**
> 定位：本项目 **A**，**先于**项目 B（邻国扩展）。项目 B 复用本项目的管线改造结果，见
> `2026-09-24-china-neighbors-design.md`（该文档已按本次口径变更标注为**待修订**）。

---

## 1. 背景与目标

用户在 2026-09-24 做出两项决定，它们共同定义了本项目：

1. **只做电力**：移除中国地区的**铁路与油气管道**（**显示与数据一并去掉**，不是只隐藏图层）。
2. **全面加强电力数据**：属性扩容、新增要素类型、几何合并、直交流/HVDC 分档 —— 四项全做。

### 1.1 目标清单

| # | 目标 | 说明 |
|---|---|---|
| G1 | **移除铁路/管道** | 抓取类别、prepare 合并、切片、归档、清单、前端图层/配色/图例/弹窗/packLayerIds 全部去掉 |
| G2 | **属性扩容** | 线路加 `ref` / `operator` / `cables` / `wires` / `circuits`；变电站加 `operator`；电厂加 `plant_output` |
| G3 | **新增要素类型** | 换流站（`power=converter`，node+way）、海底电缆（`power=cable` 单独成层） |
| G4 | **几何合并** | 杆塔级碎线 → 完整线路，附 `length_km` 与合并段数 |
| G5 | **直交流/HVDC 分档** | 直流线路单独分档与配色（依赖 `frequency` 或拓扑推断，见 §7 未决项） |
| G6 | **前端图层重构** | 图层项从 3+5 档扩为多组；**必须同时重做图层面板的折叠层级**（否则阶段54 刚修好的 1280×800 溢出立刻复发） |
| G7 | **数据重建与重传** | **7 个区域包** + 随安装包分发的核心区归档 `osm_grid.pmtiles` 重建；清单重算；**7 个区域包重新上传**（GEM 包不受影响）；重打安装包 |
| G8 | **包指纹失效策略** | 包指纹变了，但运行时只探测"文件是否存在" ⇒ 需新增"指纹不符即标记需更新" |
| G9 | **文档同步** | README / README_OSM / PROJECT_HANDOFF 的口径、要素数、图层清单、阶段43 历史 |

### 1.2 非目标（明确不做）

| 不做 | 理由 |
|---|---|
| 邻国数据（项目 B） | 已拆分为独立项目，在 A 完成后进行 |
| 配网深度加深（z12 不变） | 与本项目目标无关；加深会让包体积成倍增长 |
| "电气正确"的拓扑重建 | G4 只保证**不把无关线路连起来**（保守规则，见 §4.2），不声称还原真实电气拓扑 |
| 新增 npm / cargo 依赖 | 项目红线；G8 用现有 `pack_status` 返回的 bytes 即可实现 |
| 修改 Rust 下载机制 | 已核实 `PackFileStatus` 已返回 `bytes`（`packs.rs`），前端比对即可 |

---

## 2. 关键事实（已实测，非推断）

### 2.1 G2 是零抓取成本

读 `data/osm/huadong_power_lines.geojson` 的真实要素：

```json
{"osm_id":"way/248716611","name":"三峡至广东直流接地线","ref":null,"operator":null,
 "vclass":"<220","voltage_kv":35,"power":"line","line_kind":"line",
 "cables":"2","wires":null,"circuits":null}
```

⇒ `ref` / `operator` / `cables` / `wires` / `circuits` / `plant_output` **已在本地中间产物里**，
仅在 `prepare_osm_geojson.mjs` 的白名单（`KEEP_PROPS`）处被丢弃。

### 2.2 G1 不需要重抓

铁路/管道中间产物齐全（`data/osm/*_rail.geojson`、`*_pipeline.geojson`），且它们是在
**prepare 阶段**才与电力要素合并进同一个归档的。⇒ 从 `FILES` 与 `KEEP_PROPS` 摘掉二者，
重跑 prepare + build 即可，**238 个抓取分块不用重做**。

> 附带收益：`fetch_osm_power.py` 的类别是 `power / rail / pipeline`，每个分块跑 3 个类别查询。
> 去掉两类后**每个分块的查询数从 3 降到 1**，此后（含项目 B 的邻国抓取）工期应下降 —— 具体幅度**实测后再写**。

### 2.3 G4 不需要重抓

每个 way 是一条**完整折线**（实测样本 120+ 坐标点）。OSM 在同一杆塔处切分的两条 way，
**共享端点坐标完全相同** ⇒ 合并可以基于"精确相等的端点"做，**不需要容差**。

### 2.4 G3 / G5 必须补数据

- `power=converter` **不在现有查询里**；
- **`frequency` 不在中间产物里**（属性表里没有该键）⇒ 直流/交流**无法从现有数据推出**。

补法（设计采用）：**少量大范围精准查询**补齐，而不是重跑 238 块 ——
`[power=converter]` 与 `[power=line][frequency]` 的结果集都很小。
⚠️ 该补法有一步**必须先探测**（§7 未决项 U1/U2）。

### 2.5 G8 无需改 Rust

`packs.rs` 的 `pack_status` 已返回 `{ file, exists, bytes, partBytes }`，前端把它与
清单里的 `bytes` 比对即可判定"旧版包"。

---

## 3. 数据管线改造（逐脚本）

### 3.1 `scripts/fetch_osm_power.py`

- `CATEGORIES` 删除 `"rail"` 与 `"pipeline"`；同步删除 `infra_line_feature()`、
  `CATEGORY_LABEL` 里的对应项（**删掉而不是留着不用** —— 死代码会误导后来者以为还在抓）。
- 线路属性新增采集：`frequency`（`props["frequency"] = tags.get("frequency")`）。
- 新增类别 `"converters"`：`node[power=converter]` + `way[power=converter]`
  ⇒ 产出 `<name>_power_converters.geojson`。
- **补抓通道**（不重跑既有分块）：新增 `--tags-only` 模式，对给定 bbox 只查
  `[power=converter]` 与 `[power=line][frequency]` 两类，产出
  `<name>_power_converters.geojson` 与 `<name>_dc_tags.json`（`way_id → frequency` 映射）。

### 3.2 `scripts/prepare_osm_geojson.mjs`

- `FILES` 删除 `railway` / `pipeline` 两项；`KEEP_PROPS` 删除二者并扩容电力三项：

```text
line:       osm_id, name, ref, operator, vclass, voltage_kv, line_kind, cables, wires, circuits, frequency
substation: osm_id, name, operator, vclass, voltage_kv, substation_kind
plant:      osm_id, name, vclass, voltage_kv, plant_source, plant_output
converter:  osm_id, name, operator, vclass, voltage_kv
```

- 把 `<name>_dc_tags.json` 的 `frequency` 合并回线路要素（找不到映射的线路 `frequency` 保持 null）。
- 调用几何合并模块（§4.2），输出带 `length_km` / `merged_count` / `osm_ids` 的线路要素。
- 统计输出新增：合并前/后要素数、直流线路数、换流站数（供验收比对）。

### 3.3 `scripts/lib/merge-lines.mjs`（新增，纯函数模块）

独立模块而非内联，便于单独测试。输入线路要素数组，输出合并后的数组。规则见 §4.2。

### 3.4 `scripts/build_pmtiles.mjs`

- `keepProps` 与 prepare 的白名单保持一致，并新增线路的 `is_dc` / `length_km`。
- **低级别降采样白名单必须包含 `is_dc`**（见 §5.1 的硬约束）。
- 图层：新增 `converter`（点）与 `cable`（线）；`ftype` 取值集合从
  `line/substation/plant/railway/pipeline` 变为 `line/substation/plant/converter`。

### 3.5 `scripts/gen_packs_manifest.mjs`

无需结构性改动（仍按 `REGIONS` 生成），但要**重跑**以刷新 `features` / `bytes` / `sha256`。

---

## 4. 数据模型变更

### 4.1 要素类型与属性

| ftype | 几何 | 属性 |
|---|---|---|
| `line` | LineString（**合并后仍为 LineString**，最长的一条链路一个要素） | `osm_id`（首段）、`osm_ids`、`merged_count`、`length_km`、`name`、`ref`、`operator`、`vclass`、`voltage_kv`、`line_kind`、`cables`、`wires`、`circuits`、`frequency`、`is_dc` |
| `substation` | Point | `osm_id`、`name`、`operator`、`vclass`、`voltage_kv`、`substation_kind` |
| `plant` | Point | `osm_id`、`name`、`vclass`、`voltage_kv`、`plant_source`、`plant_output` |
| `converter` | Point | `osm_id`、`name`、`operator`、`vclass`、`voltage_kv` |

`is_dc` 的判定顺序（**先到先得，逐条可查**）：

1. `frequency == "0"` ⇒ 直流（最硬信号）；
2. 否则若线路的端点与某个 `converter` 的坐标精确相等 ⇒ 直流；
3. 否则 `is_dc = false`（**默认按交流，不猜**）。

### 4.2 几何合并规则（G4）

在端点图（endpoint graph）上做，**全部规则都是必要条件，缺一不合并**：

1. 两条 way 在**一端坐标精确相等**（不需要容差）；
2. 该端点的**度数恰好为 2**（只有这两条 way 相接）—— 度数 ≥3 一律视为接点/双回共塔，**停止合并**；
3. 属性兼容：`voltage_kv` 相等，且 `ref` 与 `name` 与 `operator` **不冲突**
   （三者都为空视为兼容；一方为空一方有值视为兼容并取有值者；两者都有值且不同 ⇒ 不合并）；
4. `line_kind` 相同（`line` 不与 `cable` / `minor_line` 混合）。

合并输出：一条链路一个要素，`merged_count` 记录段数，`length_km` 按 Haversine 累加。

> ⚠️ 已知局限（写进文档，不假装没有）：这条规则**不还原真实电气拓扑** ——
> 双回线路若在 OSM 中画成两条几何不相接的线，不会被合并（正确）；
> 但若两条电气无关的线恰好在同一点各只有一个邻居，会被合并（**误连**）。
> 后者无法在不引入外部电网拓扑数据的前提下根治，因此合并不作为
> `voltage`/`ref` 的证据来源，只用于**渲染与长度统计**。

---

## 5. 前端改造

### 5.1 图层面板（**含必须一并处理的溢出问题**）

新增项后图层项会明显变多。阶段54 已把 1280×800 下的溢出从 65px 修到 0（靠给电压分级加第二层折叠）。
本次必须**同时重做折叠层级**，否则立刻复发。计划的三层结构：

```text
电力设施
├─ 电厂
├─ 变电站
├─ 换流站                     ← 新增
├─ 输电线路（按电压分级）      ← 已有折叠，下含 6 个并列档位
│   ├─ 735kV 以上 / 500-734 / 220-499 / 220kV 以下 / 电压未知   ← 5 个交流档
│   └─ 直流（HVDC）            ← 新增第 6 档（与 5 个交流档**并列**，不是交流档的子项）
└─ 海底电缆                   ← 新增（power=cable）
```

**硬约束**：`z < 8` 的瓦片只保留少量属性（见 README 的低级别降采样说明）⇒
**`is_dc` 必须在低级别白名单里**，否则低缩放时直流分档会静默失效（全部按交流配色）。

### 5.2 弹窗与图例

- 线路弹窗新增：`长度`、`合并段数`、`回路数 circuits`、`导线 wires`、`电缆 cables`、
  `运营商 operator`、`线路编号 ref`、`频率 frequency`（并标注 AC/DC）。
- 变电站弹窗新增 `operator`；电厂弹窗新增 `plant_output`。
- 图例新增换流站符号与直流线型。

### 5.3 统计筛选

电压档位从 5 档变为 5 档 + 直流 1 档；统计筛选（15 个燃料项 + 电压档）需同步，
并保留下拉/折叠，避免与 §5.1 的溢出问题叠加。

### 5.4 包指纹失效策略（G8）

- 前端在探包时（`usePackDownloads` 已有的 `pack_status` 通道）把返回的 `bytes` 与清单 `bytes` 比对；
- 不一致 ⇒ 该包标记为**「需更新」**（不是"未安装"），提供重新下载；下载完成后按既有流程原子替换；
- 若不比对，老用户会继续用含铁路/管道的旧归档（图层已删，表现为纯浪费空间），
  且 `scripts/verify_packs.mjs` 会报指纹不符 —— 两处都不该出现。

---

## 6. 交付顺序与验收

### 6.1 交付顺序

| 步 | 内容 | 产物 |
|---|---|---|
| 1 | **探测**（U1/U2，见 §7） | 一份探测结论（可获取 / 不可获取），决定 G5 的实现路径 |
| 2 | 管线改造：去铁路/管道 + 属性扩容 | 新的 prepare 产物；**此时即可验证要素数下降与属性齐备** |
| 3 | 几何合并（`merge-lines.mjs`） | 合并前后要素数对照 + 抽样长度合理性 |
| 4 | 新要素与分档（converter / cable / is_dc） | 换流站与直流线路在包内可见 |
| 5 | 前端（图层/弹窗/图例/统计/指纹失效） | 界面与阶段54 基线一致且新增项可用 |
| 6 | 重建与重发：**7 个区域包** + 核心区归档 + 清单 + 重传 + 重打安装包 | 可分发产物 |
| 7 | 文档同步 | README / README_OSM / PROJECT_HANDOFF |

### 6.2 验收口径

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 铁路/管道彻底消失 | 前端无入口；且用**具体标识符**而非宽泛词搜索确认无残留：`OSM_RAILWAY_LAYER_ID`、`OSM_PIPELINE_LAYER_ID`、`INFRA_LAYERS`、`railway_kind`、`man_made=pipeline`、`substance`。<br>⚠️ **不要用 `railway\|pipeline` 这种宽泛词** —— 本仓库里 `run_pipeline.mjs`、`pipeline_regions.mjs`、`pipeline_report.json` 说的都是**数据管线**，与此无关，会误报 |
| 2 | 属性齐备 | 抽样 20 条线路，`circuits`/`cables`/`wires`/`operator`/`ref` 至少一项非空的占比**实测记录**（不预设阈值） |
| 3 | 合并正确性 | 合并前后总长度差 < 0.1%；抽样 5 条长线路人工核对走向；**度数 ≥3 的点未被跨越**（用断言脚本验证） |
| 4 | 直流分档 | 换流站全部进入 `converter` 图层；`is_dc=true` 的线路数与探测结论一致；低缩放（z<8）直流配色仍生效 |
| 5 | 构建与红线 | `npm run typecheck`、`npm run build`、`check_release_redlines.mjs --with-exe` 全通过 |
| 6 | 面板不溢出 | 1280×800 默认态 `clientHeight == scrollHeight`（照阶段54 的实测口径复测） |
| 7 | 远端齐备 | `verify_packs.mjs --remote` 全绿：**7 个区域包已重传**、GEM 包未变更（指纹应仍一致） |
| 8 | 安装包 | ≤ 50 MB 红线；核心区归档体积与要素数重新记录 |

### 6.3 风险

| # | 风险 | 缓解 |
|---|---|---|
| 1 | `frequency` 在 OSM 中国几乎没有 | 探测先行；退化路径 = 只按 §4.1 第 2 条（换流站拓扑）判定，并在 UI 文案里说明"直流识别依据" |
| 2 | 大 bbox 补抓查询不稳定（设计期实测过一次 504） | 退化路径 = 按 8×8 分块补抓这两类（每块 1 个查询，仍远便宜于全量重抓） |
| 3 | 合并误连（§4.2 局限） | 严格的三条件 + 度数=2；合并结果**不作电气证据**；验收含抽样人工核对 |
| 4 | 图层面板再次溢出 | §5.1 与本次改动**同批做**，不作为遗留 |
| 5 | 老用户旧包 | G8 指纹失效策略；`verify_packs.mjs --remote` 纳入验收 |
| 6 | 8 个包重传（约 150 MB） | 使用既有 `PACKS_UPLOAD_RUNBOOK.md`；上传后必须跑远端校验 |

---

## 7. 未决项 —— ✅ **两项均已探测并关闭（2026-09-24）**

探测脚本：`data/_probe_dc.py`（临时探针，gitignored）；范围用**长三角小块** `118–123°E / 29–33°N`。

| # | 未决项 | 探测结果（实测） | 裁定 |
|---|---|---|---|
| U1 | `power=converter` 的数量与分布 | **4 个**（node + way 合计） | ✅ 可获取 ⇒ **单独成层**（数量少但语义独立，且是直流识别的关键锚点） |
| U2 | `[power=...][frequency]` 覆盖率 | **1,746 / 15,602 = 11.19%** | ✅ 可获取，但**覆盖有限** ⇒ §4.1 的三步判定必须保留第 3 步「默认按交流，不猜」；UI 上要写明"直流识别依据"，**不得暗示全部直流线都已被识别** |

> ⚠️ **探测期间的真实障碍（记录以便复现）**：华东大 bbox 查询被
> `overpass-api.de` 返回 `504`、`overpass.kumi.systems` 读超时；
> 退到单块尺寸（约 5°×4°）后成功。这与项目既有记载一致 ——
> **大 bbox 必然撞超时，补抓必须按分块走**（风险表第 2 条的退化路径因此是默认路径，不是备选）。

两项之外，**所有取舍均已确定**（本文档 §1–§6）。
体积、要素数、时长等易失数字一律**实测后写入文档**，不在设计阶段编造。
