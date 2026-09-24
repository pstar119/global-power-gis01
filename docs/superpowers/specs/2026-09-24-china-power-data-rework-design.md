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
- **补抓通道**（不重跑既有分块）：对给定 bbox 只查 `[power=converter]` 与
  `[power=line][frequency]` 两类，产出 `<name>_power_converters.geojson` 与
  `<name>_dc_tags.json`（`way_id → frequency` 映射）。

> **实施修正（2026-09-24，A2 第 2 步）**：设计里写的 `--tags-only` 模式**没有**按名字实现，
> 而是落成了**新类别** `python scripts/fetch_osm_power.py --category converters --bbox … --grid NxM --name <区域>`。
> 两者的效果完全一样（都只查这两类、都产出上面两个文件），但类别这条路**白捡了**
> 已有分块机制的全部能力：断点续抓（`<name>_converters_progress.json`）、跨块 `osm_id` 去重、
> 产物与 power 三类**完全隔离**、失败块响亮落进 `failed_chunks`、以及 `--status` 只读报进度。
> 这些正是"补抓可以分批交付、一块失败不阻塞其余"所依赖的东西。
>
> 同期实测（写进代码注释，供复现）：
> - **每块 1 次查询**：换流站与 frequency 合成**一条 union 查询**
>   （`(node[power=converter];way[power=converter];way[power][frequency];); out geom;`）——
>   Overpass 的成本主要在空间检索，拆两条等于把同一片区域检索两遍。
> - **块尺寸**：按 `--grid` 取到每块 ≈5°×4°（实测该尺寸在长三角成功；华东全域那种大 bbox 仍会 504）。
> - **端点**：`maps.mail.ru` 在本机 TLS 校验失败（`CERTIFICATE_VERIFY_FAILED`，重试不会好）、
>   `overpass.private.coffee` 单块 500 秒、`overpass.kumi.systems` 读超时 ⇒ 本次用
>   `--endpoint https://overpass-api.de/api/interpreter`（单端点，失败 4 次就**记失败块并继续**，
>   不会漂到慢端点）。api.de 会偶发 429/504，**并发 2 条流必然撞 429**（实测），所以串行跑。
>   `fetch_osm_power.py` 为此新增了 `--endpoint` 参数与"确定性错误（TLS/DNS）跳过退避"的判据。
> - **探测结论复核**：长三角小块（118–123°E / 29–33°N）实测 **4 个换流站**、
>   **2,089 个 way 带 frequency（其中 `frequency=0` 105 条）** —— 与 §7 的探测（4 个 / 11.19% 覆盖）一致。

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

---

## 8. 实施记录 —— 阶段56-A2（2026-09-24，本节与上文同级，冲突时以本节为准）

> 逐项实测数据、逐处代码改动、失败与修补过程写在 `README_OSM.md` 的「阶段56-A2」一节
> （那里是 OSM 管线的权威实操记录）。本节只记**与本设计文档直接相关的裁定**。

### 8.1 与设计不一致的地方（3 处，均已就地修正或记录）

| # | 设计原话 | 实际实现 | 理由 |
|---|---|---|---|
| 1 | §3.1 新增 `--tags-only` 模式 | 落成**新类别** `--category converters` | 效果相同，但白捡已有分块机制（断点续抓、跨块去重、产物隔离、失败块响亮、`--status`）——「按区域分批交付、一块失败不阻塞其余」正需要这些 |
| 2 | §3.1 对给定 bbox 只查两类 | 合成**一条 union 查询**（每块 1 次往返） | Overpass 成本主要是空间检索，拆两条等于把同一片区域检索两遍 |
| 3 | §7 探测"长三角小块 frequency 覆盖 11.19%" | 全量实测 **17–40%（分区域，合并后线路口径）** | 探测只取了一个 5°×4° 小块且按**段**统计；全国按**合并后线路**统计口径不同。⇒ 结论方向不变（覆盖有限、必须保留第 3 步），但**数字不要互相引用** |

### 8.2 验收对照（§6.2）

| # | 检查 | 实测 | 结论 |
|---|---|---|---|
| 1 | 铁路/管道彻底消失 | `verify_power_only.mjs` 8 个归档全 PASS（`forbidden ftypes: (none)`） | ✅ |
| 2 | 属性齐备（抽样 20 条线路，≥1 项非空占比） | 华东 19/20、华中 16/20、华南 20/20、华北 9/20、东北 2/20、西南 19/20、西北 20/20、核心区 4/20（**抽样是每包前 20 条，逐字段差异极大**：cables 命中最多，`wires`/`ref` 在前 20 条里常为 0） | ✅ 已记录，不设阈值 |
| 3 | 合并正确性 | 长度守恒差 **0.000%**（8 个归档全是 0.000%）；`brokenChains` 全部由「长度守恒仍成立」兜住 | ✅ |
| 4 | 直流分档 | 换流站 62 个（7 包）+ 核心区 4 个全部进 `converter` 图层；`is_dc=true` 线路 **1,082 条**（7 包）；**z<8 瓦片带 `is_dc` 的比例 100%**（8 个归档逐个断言） | ✅ |
| 5 | 构建与红线 | `tsc --noEmit` 0；`vite build` 0；`check_release_redlines.mjs` 通过（`--with-exe` 属 A3） | ✅ |
| 6 | 面板不溢出（1280×800 默认态） | ⚠️ **未用浏览器复测**（本会话无 CDP 通道）。做了结构压缩：把「展开分级」箭头并进「输电线路」行（省 ~22px）抵消新增两个图层开关（+60px）；默认态两个面板都是折叠的（阶段54 实测 373px） | ⚠️ 待复测 |
| 7 | 远端齐备 | 清单未重算、7 包未重传 ⇒ 属 **A3** | ⏭️ A3 |
| 8 | 安装包 | 未重打 ⇒ 属 **A3** | ⏭️ A3 |

### 8.3 §5.3「统计筛选」的落地解释

§5.3 写「统计筛选（15 个燃料项 + 电压档）需同步」。实现方式：**电压档本身就是地图过滤开关**
（面板第三层的 6 个复选框，直流是第 6 个），左下角「当前视野」的线路段计数已把直流档与海缆层
**一并计入**（漏掉会让读数比实际看到的线少一截且不报错）。没有把电压项再塞进「统计筛选」子菜单 ——
那会与分级列表重复，且正是 §5.1 要避免的面板高度膨胀。

### 8.4 本次**未**做（诚实清单）

- 面板 1280×800 溢出的浏览器实测（见 8.2 第 6 条）。
- 任何 npm/cargo 新增依赖：**零新增**（红线保持）。

---

## 9. 阶段56-A3（发布）—— 进行中

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | `node scripts/gen_packs_manifest.mjs` 重算清单 | ✅ 已重算（8 个包的新 `features`/`bytes`/`sha256`/`sizeMb`；区域包的 `features` 来自 `run_pipeline.mjs --stage prepare,build` 刷新的报表，即**合并后**要素数） |
| 2 | 7 个 `osm-*.pmtiles` 重传 + `gem-plants.pmtiles` 首传 | ✅ 已完成（`node scripts/upload_packs.mjs`，2026-09-24，共 162 MB；每包 `.stage`→校验→删旧→改名，无缺失窗口） |
| 3 | `verify_packs.mjs --remote` 复核 | ✅ **远端段 8/8 全绿**（GEM 从"不存在"变为一致；修复前基线为 29 项问题）。⚠️ 该命令同时查**本机用户目录**，本机 7 个旧包仍报不符 ⇒ 退出码非 0，属预期（正是 G8 的场景） |
| 3b | **用户实际下载路径**（镜像 `gh-proxy.com`）复核 | ✅ 8/8：HEAD 200 且 `Content-Length` 等于清单 `bytes`；`Range: bytes=0-126` → **206 + 恰好 127 字节 + PMTiles 魔数** ⇒ **断点续传在镜像上仍然可用**（阶段46 的那条结论在本次重传后依旧成立） |
| 4 | §5.4 / G8 **包指纹失效策略** | ✅ 已实现（见 9.1） |
| 5 | 重打安装包 + `check_release_redlines.mjs --with-exe` | ✅ 已完成：`Global Power GIS_0.2.0_x64-setup.exe` = **48,128,414 B / 45.90 MiB**（红线 50 MB）；`--with-exe` 自检通过 |

> 阶段56-A3 收尾时的**意外观察**：核心区归档从 7.02 → **7.12 MB（+0.10）**，而安装包却从
> 46.12 → **45.90 MiB（−0.22）**。⇒ 再次印证 PROJECT_HANDOFF 里那条"体积归因"教训：
> **不能用单个资源的增量去推安装包增量**（NSIS 走 LZMA，压缩率与内容重复度强相关）。

### 9.1 G8 的实现（零 Rust 改动）

- `src/lib/packs.ts` 新增 `PackInstallState`（`missing` / `partial` / `installed` / **`outdated`**）
  与纯函数 `installStateOf(pack, status)`：**拿 `pack_status` 已回传的 `bytes` 与清单的 `bytes` 比对**。
- ⚠️ 判据是**字节数**不是 SHA256，两条别互相冒充：字节数不同 ⇒ 一定是不同版本；
  字节数相同 ⇏ 内容相同（同长度不同内容会漏判）。不在这里比 SHA256 的理由是
  8×30 MB 的哈希会卡渲染；而**下载路径本来就逐字节校验 SHA256**（`packs.rs` 只在长度+SHA256
  都通过时才 rename），所以这里要抓的是"装了旧版本"，字节数足够。
- `usePackDownloads` 暴露 `stateOf(pack)`；设置页「数据包管理」对过期包显示
  **「需更新」徽标 + 本机/清单字节数凭据 + 更新按钮**（复用既有 `download()`：
  成功即原子替换，失败时旧文件不动 —— `packs.rs` 的失败路径只删 `.part`）。
- 首启向导**不**把过期包当作"没装"（否则一次升级会在向导里悄悄下 58 MB），
  只在行上标「需更新」，重下的入口是设置页。
- 实测基线（重算清单后 `verify_packs.mjs --remote`）：**用户目录与远端各 7 个包全部过期、
  GEM 远端缺失 ⇒ UI 上应显示 7 个「需更新」+ 1 个「已下载」**。
  ⚠️ 这条是**数值预期**，尚未在运行中的应用里点过（浏览器里没有 Tauri 桥，`pack_status` 不可用）。
