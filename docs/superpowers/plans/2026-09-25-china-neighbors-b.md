# 项目 B（相邻带邻国）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> ⚠️ 本 harness 的子代理**只有只读工具**（无 write/shell）⇒ **不能**用 subagent-driven-development，
> 必须**内联执行**（同 A1 的裁定 R5）。Steps 用 `- [ ]` 跟踪。

**Goal:** 把「中国 + 相邻带邻国」的电力数据面做出来并发布：5 个邻国电网包 + 5 个同 bbox 底图包 + 多文种字形 + 运行时装载放宽。

**Architecture:** 数据面**完全复用**国内管线（`run_pipeline.mjs` → `apply prepare` → `build_pmtiles.mjs`），
邻国包与国内包同构（同切片参数、同分发通道、同运行时装载）。底图包走**第三类数据包** `kind: "basemap"`，
运行时以**独立叠加 source** 挂载（不动现有 basemap）。运行时只改三处品类判定与装载上限 2→3。

**Tech Stack:** Node（零新增依赖）+ Python 标准库 + PMTiles/MVT + MapLibre + Tauri v2（Rust 侧**不改**）。

**Spec:** `docs/superpowers/specs/2026-09-24-china-neighbors-design.md`（**含 §10 实施前复核** —— 三处修订必须遵守）

## Global Constraints

- **口径：纯电力**（不抓铁路/管道）。邻国包必须 `--category power,converters` ——
  只跑 power 会得到**没有直流分档**的包且**不报错**（设计 §10.2 第 2 条）。
- **切片参数与国内一致**：`--max-features-per-tile 20000 --cap-below-zoom 8`；核心区归档**不加**封顶。
- **`--out` 必须显式**（`build_pmtiles.mjs` 默认写 `osm_grid.pmtiles`，会静默覆盖核心区归档）。
- **两道属性白名单必须同步**：`prepare_osm_geojson.mjs` 的 `KEEP_PROPS` ↔ `build_pmtiles.mjs` 的 `keepProps`。
- **`is_dc` 必须在 `collapseProps` 里**（否则低缩放直流配色静默失效）。
- **零新增 npm/cargo 依赖**（项目红线）；**Rust 侧不改**。
- **清单顺序**：必须先出包 → 再 `gen_packs_manifest.mjs` → 再上传；否则老用户会看到"点不动的空区域"。
- **验证脚本是门禁**：每个新包都跑 `verify_pack.mjs` + `verify_power_only.mjs`；
  上传后跑 `verify_packs.mjs --remote`（期望退出码 0）。
- **抓取端点**：`--endpoint https://overpass-api.de/api/interpreter`（默认表第一个 `maps.mail.ru` 本机不可用）。
- **体积红线**：安装包 ≤ 50 MB（`check_release_redlines.mjs --with-exe`）。

## 文件结构（改动地图）

| 文件 | 职责 | 动作 |
|---|---|---|
| `scripts/pipeline_regions.mjs` | 12 个批次的唯一定义点 | ✅ 已加 5 条（T0） |
| `scripts/run_pipeline.mjs` | 批量驱动（类别/端点/阶段） | ✅ 已加 converters 与 `--endpoint`（T0） |
| `scripts/fetch_basemap.mjs` | 底图包生成（**已支持全部所需参数**，不改） | 只调用 |
| `scripts/gen_packs_manifest.mjs` | 清单生成（区域包 + GEM + **新增 basemap 段**） | T3 修改 |
| `src/lib/packs.ts` | 品类判定（新增 `"basemap"` + 显式判定函数） | T4 修改 |
| `src/components/WelcomeWizard.tsx` | 向导分组与选择 | T5 修改 |
| `src/pages/MapPage.tsx` | 区域选举 + 底图叠加 source 生命周期 + `PACK_MAX_ACTIVE` | T6 修改 |
| `scripts/fetch_glyphs.mjs` | 字形子集（单族 → 配置数组） | T7 修改 |
| `docs/PACKS_UPLOAD_RUNBOOK.md` | 上传手册（脚本已就绪） | T9 引用 |

---

## 计划总表

| # | 任务 | 产物 | 验收（命令 → 期望） | 预计 |
|---|---|---|---|---|
| T0 | 计划与前置 | 本文件 + 5 批次入表 + converters/endpoint | `--dry-run` 打印两条带 `--endpoint` 的命令 | ✅ 已完成 |
| T1 | `kp-kr` 数据面 | `data/packs/osm-kp-kr.pmtiles` + `public/osm/kp-kr_power.geojson` | 每个门禁 PASS；`is_dc` 在 z<8 为 100% | 0.5–1 h |
| T2 | `kp-kr` 底图包 | `data/packs/basemap-kp-kr.pmtiles` | PMTiles header 可读、含 `places` 层、体积实测记录 | 0.3 h |
| T3 | 清单 basemap 段 | `public/packs_manifest.json` 含 2 条新包（区域+底图） | `--dry-run` 前先确认包文件已存在；条目 `forRegion` 正确 | 0.5 h |
| T4 | `packs.ts` 品类语义化 | `PackKind = "region"\|"gem"\|"basemap"` + 三个判定函数 | `tsc --noEmit` 0 | 0.3 h |
| T5 | 向导按区域分组 | 向导里电网包与底图包成组显示 | 底图包**不再**被当成区域包；`tsc` 0 | 0.5 h |
| T6 | 选举过滤 + 上限 3 + 底图叠加 source | `MapPage.tsx` | 底图包不进 `activePacks`；`tsc`/`vite build` 0 | ✅ 已完成（T6a+T6b） |
| T7 | 字形多族（按实测裁族：SC + Noto Sans） | `src/lib/basemapFonts.generated.ts` 等 | 扫 6 份归档并集 1959 个码位；实测 2.28 MB（净增约 0.2 MB） | ✅ 已完成 |
| T8 | 其余 4 区域抓取+切片 | `osm-{mn,sea-mainland,ca,ru-far}.pmtiles` + 4 底图包 | 每包门禁 PASS | ✅ 已完成（5 包 `verify_pack` 8 项全绿） |
| T9 | 清单重算 + 上传 10 包 | Release 上 18 个资产一致 | `verify_packs.mjs --remote` → **退出码 0** | ✅ 已完成 |
| T10 | 重打安装包 + 红线 | `Global Power GIS_0.2.0_x64-setup.exe` | `check_release_redlines.mjs --with-exe` 通过、≤50 MB | ✅ 已完成（46.09 MB） |
| T11 | §7.1 七条验收 | 验收记录 | 含边境连续性抽样、地名无方块、中国侧零回归 | ✅ **7/7 已闭合**（④⑤⑥ 于 2026-09-26 运行时实测） |
| T12 | 文档同步 | README / README_OSM / PROJECT_HANDOFF | 口径、包数、体积、批次表一致 | ✅ 已完成 |

> ### 📍 进度快照（2026-09-26 收尾）
>
> **T0–T12 全部完成，T11 七条全部闭合（含 2026-09-26 的运行时实测 ④⑤⑥）。**
>
> | 已核实的事实 | 证据 |
> |---|---|
> | 5 个邻国电网包 + 5 个底图包都在 | `data/packs/`，体积见 T8 表 |
> | 每个包过门禁 | `verify_pack.mjs` 5 包 × 8 项断言全绿；`verify_power_only.mjs` **12 区域 × 2 产物 = 24 次全 PASS** |
> | **远端齐备** | `verify_packs.mjs --remote` **退出码 0**（18 个资产与清单一致，328.75 MB；2026-09-26 复跑仍为 0） |
> | 构建与红线 | `tsc`/`vite build` 0；`check_release_redlines.mjs --with-exe` 通过 |
> | **安装包 ≤ 50 MB** | **46.09 MB**（手工量 NSIS 产物；红线脚本不含体积判据） |
> | 字形 | 2 族 / 95 个子集 / **2.28 MB**（净增约 0.2 MB）；覆盖 1922/1959 个码位 |
> | **运行时（新增）** | 三处边境两侧电网+底图都在；五处地名全部渲染为可读汉字；中国侧核心区优先与国内选举行为不变 |
> | 文档一致 | README / README_OSM / PROJECT_HANDOFF / PACKS_UPLOAD_RUNBOOK / .gitignore 已同步 |
>
> **运行时验证已于 2026-09-26 补上**（真跑实例 + CDP 驱动）：
> - **④ 边境连续性**：满洲里（中俄）、二连浩特（中蒙）、凭祥（中越）两侧 50 km 内电网与底图**都在**；
> - **⑤ 地名无方块**：平壤 / 首尔 / 乌兰巴托 / 曼谷 / 河内五处**全部可读**（东京按已修正的口径剔除）；
> - **⑥ 中国侧零回归**：长三角核心区仍不选举区域包、华北选举 3 个国内包且无叠加层。
>
> ⚠️ 但仍有一条**运行时没覆盖到的**：⑤ 的实际渲染走的是**中文名**（底图 `name:zh-Hans` 优先），
> 所以本阶段新增的**韩文/西里尔字形并没有被触发** —— 那部分仍只有静态码位扫描级证据。
> 详见下方「④⑤⑥ 运行时验收记录」。

### 运行时验收的**操作清单**（2026-09-26 已按此执行完毕，保留供复跑）

> ✅ **本清单已执行**（结论与实测数字见下方「④⑤⑥ 运行时验收记录」）。
> 前置里的「只装了 8/18」当时成立，跑之前已用 `install_packs.mjs --user-dir` 补到 18/18。
> 保留本文是给**以后复跑**用：坐标、判据、日志特征照抄即可。

**前置**：`%APPDATA%\...\packs\` 目前只装了 8/18 个包 ⇒ 邻国数据还没落到本机。
两种投放方式，任选：
- 应用内：设置 → 数据包管理 → 下载「朝鲜半岛 / 蒙古 / 中南半岛 / 中亚五国 / 俄相邻带」
  各自的**电网包 + 底图包**（成组显示）；
- 或命令行一次投满：`node scripts/install_packs.mjs --user-dir`（把 18 个包全投进用户目录）。

> ⚠️ **必须装底图包**，否则叠加 source 不会被触发（T6b 的判据是「区域包被选中
> **且**其底图包已安装」）。日志里应看到：
> `[MapPage] 加载邻国底图包 <key>（叠加 source basemap-overlay-<key>，图层 earth/water/roads/boundaries/places 共 5 个，…）`

| # | 看什么 | 怎么到那 | 期望 |
|---|---|---|---|
| ④-1 | 满洲里（中俄） | 缩放到 **z7**，中心约 `117.4E, 49.6N` | 边境两侧 50 km 内**电网线与底图都在**；中国侧底图与俄侧底图色调可能有差异（已知并接受） |
| ④-2 | 二连浩特（中蒙） | **z7**，中心约 `112.0E, 43.6N` | 同上（两侧预期由 `mn` + `basemap-mn` 提供） |
| ④-3 | 凭祥（中越） | **z7**，中心约 `106.8E, 22.1N` | 同上（两侧预期由 `huanan`/`sea-mainland` + `basemap-sea-mainland` 提供） |
| ⑤-1 | 平壤 / 首尔 | **z7**，中心约 `126.4E, 38.3N` | 地名有字、**不是方块**（这两个是 SC 汉字覆盖最好的情形） |
| ⑤-2 | 乌兰巴托 | **z7**，中心约 `106.9E, 47.9N` | 同上（注意：这里是**西里尔**地名的主要检验点） |
| ⑤-3 | 曼谷 / 河内 | **z7**，中心约 `103.2E, 17.4N` | 同上（泰文码位为 0，看到的多半是 `name:en` 拉丁名——**那是预期**） |
| ⑥ | 中国侧零回归 | **z7** 移到长三角 `120.5E, 31.2N`，再移到华北 `116.5E, 38.5N` | 与阶段54 一致：核心区优先仍生效（长三角只显示核心区那份）；图层开关行为不变 |

**判据与记录方式**：
- ④ 的通过标准是「**两侧都有**电网与底图」——**任何一侧空白即算失败**并记下来；
- ⑤ 的通过标准是「**地名有字形、不是方块**」；拉丁名（`name:en`）不算失败，
  因为 37 个码位**任何候选族都没有覆盖**（阿拉伯文/老挝文/缅甸文/罕见汉字），
  这是数据现状、且已由 `name:en` 兜底；
- 顺手记 `[MapPage]` 开头那几行日志（加载/卸载区域包与底图包），它们是"是否真的挂了/摘了"的直接证据。


---

## Task 1: `kp-kr` 数据面（power + converters → prepare → build）

> ### ✅ 已完成（2026-09-25）—— 实测记录
>
> **三轮补齐**才拿到完整覆盖：第 1 轮 power 6 块 + converters 1 块被 504 打回（流水线按设计**拒绝出包**，
> 状态 `fetch-incomplete`）；第 2 轮清到只剩 1 块（同时捞回电厂 2,634 → **5,357**，证明空洞是真缺失）；
> 第 3 轮清零 ⇒ `status: ok`（power 30/30、converters 30/30）。
>
> | 项 | 实测 |
> |---|---|
> | 要素 | **15,863**（合并后 line 8,032 ← 合并前 8,806、substation 2,465、plant 5,361、**converter 5**） |
> | 包体积 / 瓦片 | **4.51 MB** / 5,569 张；最大单瓦片 **174.7 KB**（< 500 KB）；封顶丢弃 0 |
> | 长度守恒 | 0.000%；合并率仅 8.8%（邻国 OSM 切分粒度比国内粗） |
> | 直流口径 | `frequency=="0"` 4 段 ⇒ **4 条直流线路**；端点接换流站 0；**frequency 覆盖 49.55%**（4,363/8,806 段） |
> | frequency 直方图 | 60Hz 5,198 / 50Hz 154 / 0 12 —— 与韩国 60 Hz 电网的地理事实一致；朝鲜侧多无标注 |
> | 门禁 | `verify_power_only`(geojson) PASS（`missing=(none)`，含 A2 的 frequency/is_dc 必查项）；`verify_power_only`(pmtiles) PASS；`verify_pack` **8 项全绿**，其中「z<8 线路带 is_dc」= **7,542/7,542 = 100%** |
>
> ⚠️ 数据产物在 `data/`、`public/osm/`（**均 gitignore**）⇒ 本任务没有可提交的代码/文档改动，
> 结论以本表为准；口径数字等 T12 一并写进 README_OSM。

**Files:**
- 读：`scripts/run_pipeline.mjs`、`scripts/fetch_osm_power.py`、`scripts/prepare_osm_geojson.mjs`、`scripts/build_pmtiles.mjs`
- 产物：`data/osm/kp-kr_power_*.geojson`、`data/osm/kp-kr_dc_tags.json`、`public/osm/kp-kr_power.geojson`、`data/packs/osm-kp-kr.pmtiles`

**Interfaces:**
- Consumes: `pipeline_regions.mjs` 的 `kp-kr` 条目（T0 已加）
- Produces: `data/packs/osm-kp-kr.pmtiles`（T3 清单、T9 上传、T6 运行时都要它）

- [ ] **Step 1: 跑全链路（已启动，可续跑）**

```powershell
node scripts/run_pipeline.mjs --regions kp-kr --category power,converters `
  --endpoint https://overpass-api.de/api/interpreter
```
Expected: `[fetch:power] 30 块` → `[fetch:converters] 30 块` → `▶ prepare` → `▶ build`

- [ ] **Step 2: 若有失败块，原样重跑补齐（只重试失败块）**

Run: 同上命令。
Expected: 已完成的块打印「已完成，跳过」；失败块重抓；`meta.complete=true`、`failed_chunks=[]`

- [ ] **Step 3: 确认产物与元数据**

```powershell
Get-Content data/osm/kp-kr_power_meta.json | Select-String 'complete|failed_chunks'
Get-Content data/osm/kp-kr_converters_meta.json | Select-String 'complete|failed_chunks|count'
Get-Item data/packs/osm-kp-kr.pmtiles | Select-Object Name,Length
```
Expected: 两个 `complete": true`；包文件存在

- [ ] **Step 4: 逐归档跑门禁（两个脚本都要）**

```powershell
node scripts/verify_power_only.mjs public/osm/kp-kr_power.geojson
node scripts/verify_power_only.mjs data/packs/osm-kp-kr.pmtiles
node scripts/verify_pack.mjs data/packs/osm-kp-kr.pmtiles
```
Expected: 全 PASS；`verify_pack` 里「z<8 的线路要素带 is_dc」= 100%、「最大单瓦片 < 500 KB」

- [ ] **Step 5: 记录实测（直流口径、要素数、体积）**

Run: `node data/_a2_accept_sample.mjs public/osm/kp-kr_power.geojson`
Expected: 打印换流站数 / is_dc 线路数 / frequency 覆盖率 → 抄进 README_OSM

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(b): kp-kr 数据面（power+converters）与门禁实测"
```

---

## Task 2: `kp-kr` 底图包

**Files:**
- 产物：`data/packs/basemap-kp-kr.pmtiles`

- [ ] **Step 1: 先生成（源与国内同源，勿改）**

```powershell
node scripts/fetch_basemap.mjs --bbox 124.3,33.1,131.0,43.1 `
  --global-maxzoom 4 --region-minzoom 5 --region-maxzoom 8 `
  --out data/packs/basemap-kp-kr.pmtiles
```
Expected: 写出 pmtiles；控制台给出体积

- [ ] **Step 2: 回读校验（含 `places` 层，否则地名字形无从谈起）**

Run: `node scripts/verify_power_only.mjs data/packs/basemap-kp-kr.pmtiles`
Expected: `readback ok>0`（结构可读即可；内容层名用下面的脚本核对 `places`）

- [ ] **Step 3: 记录实测体积 → 写进设计文档 §4.1（把"区间估计"换成实测值）**

- [ ] **Step 4: Commit**

---

## Task 3: 清单新增 basemap 段

> ### 进展：**脚本段已完成（2026-09-25）**；清单重算**推迟到 T9 上传前**
>
> `gen_packs_manifest.mjs` 已加 basemap 扫描段（`kind:"basemap"` + `forRegion` + `features:null`，
> 包缺失时告警而不写废条目），并插入 `[...regionPacks, ...basemapPacks, ...thematicPacks]`。
> 本地实跑验证：清单 **8 → 18 条**（region:12 + basemap:5 + gem:1；5 条 `forRegion` 指纹非空）。
>
> 🔴 **但这份新清单没有提交**：它给 5 个邻国电网包/底图包写了 `downloadUrl`，
> 而那些资产**还没上传**（T9）⇒ 提交它等于让 master 的构建带上必然 404 的下载入口。
> ⇒ 处置：`git checkout -- public/packs_manifest.json` 还原成 8 条那份，**T9 上传完成后再重算并提交**
> （顺序：出包 ✅ → 上传 → 重算清单 → 提交）。与顶部「T6 先于 T3」同一条道理：
> **清单必须只引用真实存在的远端资产**。

> ### 🔴 顺序约束（2026-09-25 进度检查发现）：**T6 必须先于 T3 落地**
>
> 实测 `MapPage.tsx` 的选举过滤仍是 `.filter((p) => !isThematicOverlay(p))`（第 4627 行），
> 而它用的是**本文件内的局部** `isThematicOverlay`（第 2617 行）。只要清单里出现
> `kind: "basemap"` 的条目，它就会被当成**区域包**：被选进 `activePacks`、占掉装载名额
> （当前上限仍是 2）、并以 `source-layer: "grid"` 去挂载一个**根本没有 grid 层**的归档
> —— 全部**静默**，不报错。
> ⇒ 在 T6（改用 `isRegionPack` 并导入 `packs.ts` 的判定）完成之前，**不要**把带 basemap 的清单推出去
> （本地跑一次没问题，别上传、别打包）。T9 上传前必须确认 T6 已在。

**Files:**
- Modify: `scripts/gen_packs_manifest.mjs`（区域包段之后、GEM 段之前）

**Interfaces:**
- Produces: 清单条目 `{ key: "basemap-<region>", kind: "basemap", forRegion: "<region>", label, file: "packs/basemap-<region>.pmtiles", bbox: <与区域包相同>, features: null, bytes, sha256, sizeMb, downloadUrl }`（T4/T5/T6 消费）

- [ ] **Step 1: 加 basemap 扫描段**

```js
// 依 forRegion 与区域包成对生成；包不存在时沿用旧清单指纹并**大声告警**（与区域包同一约定）
const basemaps = [];
for (const r of REGIONS) {
  const f = join(ROOT, "data", "packs", `basemap-${r.key}.pmtiles`);
  if (!existsSync(f)) { console.warn(`⚠️ 未找到 basemap-${r.key}.pmtiles —— 该区域底图包不进清单`); continue; }
  const buf = readFileSync(f);
  basemaps.push({
    key: `basemap-${r.key}`, kind: "basemap", forRegion: r.key,
    label: `${r.label} · 底图`, provinces: r.provinces,
    file: `packs/basemap-${r.key}.pmtiles`, bbox: r.bbox,
    features: null,
    sizeMb: Number((buf.length / 1048576).toFixed(2)),
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
    downloadUrl: `${BASE_URL}/basemap-${r.key}.pmtiles`,
  });
}
```

- [ ] **Step 2: 与区域包一起写入 `packs`（顺序：区域 → 底图 → GEM）**

- [ ] **Step 3: 重算并核对（**前置：对应的包文件必须已经存在**）**

Run: `node scripts/gen_packs_manifest.mjs` → Expected: 打印每个包一行；`basemap-kp-kr` 有非空 `bytes/sha256`

- [ ] **Step 4: Commit**

---

## Task 4: `packs.ts` 品类语义化

**Files:**
- Modify: `src/lib/packs.ts`（`PackKind` 与判定函数）、`src/pages/MapPage.tsx`（import 处）

**Interfaces:**
- Produces: `isRegionPack(p): boolean`（`kind === "region" || kind === undefined`）、`isBasemapPack(p): boolean`（`kind === "basemap"`）、`isThematicOverlay(p)` 语义收窄为 `kind === "gem"`；`PackEntry` 增可选 `forRegion?: string`

- [ ] **Step 1: 定义三态与判定函数**

```ts
export type PackKind = "region" | "gem" | "basemap";
export function isRegionPack(p: Pick<PackEntry, "kind">): boolean {
  return p.kind === "region" || p.kind === undefined; // 缺省=区域包（旧清单兼容）
}
export function isBasemapPack(p: Pick<PackEntry, "kind">): boolean {
  return p.kind === "basemap";
}
```
Expected: `tsc --noEmit` 通过（此时 MapPage 的本地 `isThematicOverlay` 仍存在，T6 再统一）

- [ ] **Step 2: `tsc --noEmit` 0 → Commit**

---

## Task 5: 向导按区域分组

**Files:**
- Modify: `src/components/WelcomeWizard.tsx:86` 与渲染行

- [ ] **Step 1: 过滤改为 `isRegionPack`；底图包单独一组**

```ts
const regionPacks = useMemo(() => packs.filter(isRegionPack), [packs]);
const basemapPacks = useMemo(() => packs.filter(isBasemapPack), [packs]);
```
Expected: 底图包**不再**出现在"选区域"列表里；底图按 `forRegion` 与同区域电网包成组显示（标注两份体积）

- [ ] **Step 2: 勾选/下载队列只对区域包生效（底图包跟随同区域勾选）**

- [ ] **Step 3: `tsc --noEmit` 0 → Commit**

---

## Task 6: 选举过滤 + 装载上限 + 底图叠加 source

> ### 进展：**T6a 与 T6b 都已落地（2026-09-25）**
>
> **T6a（安全关键，已落地并验证）**：
> - `MapPage.tsx` 的选举过滤 `.filter((p) => !isThematicOverlay(p))` → **`.filter(isRegionPack)`**
>   （并导入 `packs.ts` 的判定函数）—— 这一步解除了「底图包被当区域包、占名额、
>   以 `source-layer:"grid"` 静默错挂」的风险 ⇒ **T3 的前置条件已满足**；
> - `PACK_MAX_ACTIVE` **2 → 3**（设计 §2 决策 6，附代价说明：不能再往上加）；
> - `resolvePackResource` 的日志标签改三态（底图包/数据包/区域包）。
> - 验收：`tsc --noEmit` 0；`vite build` 0（1,479.46 kB / gzip 430.31 kB）；
>   静态复核旧反向判据已只剩注释。
>
> **T6b（✅ 已落地）**：底图包叠加 source 的**生命周期**（与 GEM 同构）——
> 当选中的区域包存在 `forRegion === 该 key` 的底图包且**已安装**时，
> 以独立 source `basemap-overlay-<key>` 叠加，只挂 `earth/water/boundaries/places/roads`，
> 用 `moveLayer` 精确插在「中国底图之上、电网图层之下」；卸载时连同图层一起摘。
> 现有 `BASEMAP_SOURCE`（`"basemap"`）的 URL/图层/样式**一行不动**。
> ⚠️ 没有 T6b 时：邻国区域能正常显示电网，但**看不到邻国底图**（不报错，只是底图是空的）。
> 它不阻塞 T3/T9（清单与上传），阻塞的是 §7.1 第 4/5 条验收（边境连续性与地名无方块）。
>
> ### ✅ T6b 实测与三项实施裁定（2026-09-25）
>
> | 项 | 结果 |
> |---|---|
> | `npm run typecheck` | **0 错误** |
> | `npm run build` | **0 错误**，1,482.02 kB / gzip 431.00 kB |
> | 旧反向判据 | `.filter(isRegionPack)` 已是唯一选举判据；本次又发现并删掉一份**本地的** `isThematicOverlay` 副本（两态时代遗留），改为从 `packs.ts` 导入 |
>
> **裁定一：插位分两种，不是一个**。「压在中国底图之上、电网图层之下」对**填充/线**成立，
> 对 `places`（符号）不成立 —— 符号层自带碰撞检测与 `text-allow-overlap:false`，
> 插到现有地名 `basemap-place-labels` **之前**才能保证「有中国底图的地方照样用中文地名」，
> 否则边境会出现同一座城市两个标签。两种插位的锚点：
> 填充/线 → 第一个**无后缀**的电网图层（`osm-line-735`，核心区图层建图期就加了、永不摘除）；
> 符号 → `basemap-place-labels`。两者都取不到时（底图归档缺失，样式里只有 `background`）
> **追加到最顶** —— 没有兜底会变成「底图包下载成功、图上却没有底图」，而 `moveLayer`
> 对不存在的 `beforeId` 是**静默失败**。
>
> **裁定二：叠加 source 要设 `bounds`**（取清单条目的 `bbox`；缺失才退回全球，宁可多请求瓦片
> 也不要把底图裁没）。`bounds` 只**限制请求的瓦片范围**，不改变级别：
> z0–4 仍然是归档里的全球瓦片（该区域那一份），z5–8 换成本区域瓦片 —— 与设计一致。
> 不设 bounds 的话，同一份 z0–4 瓦片会在任何视野下都被请求，别的邻国区域也会画上它。
>
> **附：一次只挂一个叠加层**。`PACK_MAX_ACTIVE(3)` 可能同时选中「中国某区域 + 两个邻国」，
> 但视野中心只在一个邻国上；挂多份会让边境处两套叠加层互相重叠（同一邻国只有一份底图包，
> 重复挂也没有意义）。取 `activePacks` 里**第一个**「有底图包且已安装」的区域。
>
> **裁定三：主题要跟着走**。`applyBasemapTheme` → **`applyBasemapPaint(map, theme, overlayKeys)`**：
> 叠加层是另一套图层 id，浅色主题下不重刷就会「中国那半浅色、邻国那半深色」。
> 叠加层可能是在用户切主题**之后**才挂上的，所以挂载时会补刷一次；
> 模块级 `basemapOverlayKeys` 只服务这一件事，**不参与「挂没挂」的判定**（那以 `map.getSource()` 为准）。
>
> **附带修掉的一处旧缺陷**：`onPackInstalled` 一律以**清单条目的 `key`** 为准
> （原来对底图包会用 basename 推导出的 `basemap-kp-kr`，而它在清单里的 key 是区域名 ——
> 不修则底图包**重下/更新后叠加层永远不会重挂**，且不报错）。清单里查不到条目时才退回 basename 推导。
>
> **实测数据（归档解开逐层打印，`basemap-kp-kr.pmtiles`，10.45 MB，`z0-8`）**：
> `z0` 全球瓦片图层 = `boundaries/earth/landcover/water`（**没有 `places`**）；
> `z4+` 起 = `boundaries/earth/landcover/landuse/places/roads/water`；
> `z8` 共 66 张瓦片 4.48 MB。元数据里的 `minzoom`：`boundaries`/`earth`/`water` 0、
> `places` 1、`landuse` 2、`roads` 3、`landcover` **0–7**。
> ⇒ 底图覆盖「z≥5 空白」确实由本任务补上；`places` 的标签在 z≥6 是有的（但归属与
> 缺字属 T7 字形那一档，本任务只保证图层挂对地方）。
>
> **未完成的前置（阻塞运行时验证，不阻塞本任务交付）**：
> 🔴 **T3 还没做** —— `public/packs_manifest.json` 里**没有** `kind:"basemap"` 的条目
> （当前 8 条：7 个区域包 + GEM），`gen_packs_manifest.mjs` 也还没有 basemap 段。
> 于是 T6b 的效果在运行时**暂时无法触发**（叠加 source 需要清单条目才能被找到）。
> T3 落地后本任务**无需再改代码**；届时按 §7.1 第 4/5 条验收（边境连续性、地名无方块）。

**Files:**
- Modify: `src/pages/MapPage.tsx`（选举过滤、`PACK_MAX_ACTIVE`、新增 basemap 叠加生命周期）

- [x] **Step 1: 选举只认区域包**

```ts
// 原：.filter((p) => !isThematicOverlay(p))  ← 底图包会被选进来、占名额、被当 grid 图层挂载
const candidates = packsManifest.packs.filter(isRegionPack);
```

- [x] **Step 2: `PACK_MAX_ACTIVE` 2 → 3**（`PACK_MIN_ZOOM` 保持 6）

- [x] **Step 3: 底图包叠加生命周期（与 GEM 同构）**

```ts
// 当选中的区域包有 forRegion === 该 key 的底图包**且已安装**时，作为独立 source 叠加：
//   id: `basemap-overlay-${key}`；tiles: pmtiles://…；只挂 earth/water/boundaries/places/roads
// 位置：压在中国底图图层之上、电网图层之下（用 moveLayer 精确插位，别依赖 addLayer 追加到顶）
```
Expected: 现有 `BASEMAP_SOURCE`（`"basemap"`）的 URL/图层/样式**一行不动** ✅

- [x] **Step 4: `tsc --noEmit` 0 与 `vite build` 0** ✅（提交并入下一次推送）

---

## Task 7: 字形多族

> ### ✅ 已完成（2026-09-25）—— 但**结论与设计 §6.2 第 2 条相反**，按实测裁族
>
> **实测（`scripts/scan_place_codepoints.mjs` + `scripts/glyph_coverage.mjs`，6 份底图归档的并集）**：
>
> | 项 | 实测 |
> |---|---|
> | 扫描归档 | 核心 `basemap.pmtiles` + 5 份邻国底图包；码位**并集 1959 个** |
> | 谚文（韩） | **0 个码位**（邻国底图的 `places` 里根本没有谚文） |
> | 假名（日） | **0 个码位** |
> | 泰文 | **0 个码位** |
> | 西里尔 | **66 个码位**（ca 64 + ru-far 51，有重叠） |
> | 阿拉伯 / 老挝 / 缅甸 | 22 / 9 / 5 个码位（**任何候选族都没有子集**） |
>
> **逐族新增覆盖**（顺序 = `text-font` 回退顺序）：
> `Noto Sans SC` 新增 **1913**；`Noto Sans KR` **0**；`Noto Sans JP` **1**（U+59F6）；
> `Noto Sans Thai` **0**；`Noto Sans` 新增 **9**（哈萨克/蒙古语西里尔：U+493/49A/49B/4A3/4AE/4AF/4D8/4D9/4E9）。
>
> ⇒ **裁定（用户拍板）：只加 `Noto Sans`（西里尔），不加 KR / JP / Thai。**
> 设计 §6.2 第 2 条写的「先加 KR / JP / Thai 三族」是**基于假设**（以为会出现这些文字），
> 扫描结果推翻了它 —— 加了净收益 0~1 个码位、代价 +1~3 MB 进安装包。
> 日韩地名在这份数据里走 `name:en` 兜底（拉丁字母）。
>
> **交付**：
> - `scripts/fetch_glyphs.mjs`：单族 → `FAMILIES` 配置数组；扫**多份**归档取并集；
>   `--archive` 可重复 / `--archives a,b`；**自动清理不再命中的孤儿子集**
>   （`.woff2` 被 gitignore，孤儿会静默进安装包 —— 实测清理掉 1 个）。
> - `src/lib/basemapFonts.generated.ts`：新增 `BASEMAP_TEXT_FONT`（文字栈，2 族 / 95 条 font-face），
>   `BASEMAP_FONT_FILES` 改为按族分组。
> - `src/pages/MapPage.tsx`：`text-font` 由 `[BASEMAP_FONT_FAMILY]` 改为 `BASEMAP_TEXT_FONT`。
> - 实测体积：**95 个文件 / 2.28 MB**（SC 2237.2 KB + Noto Sans 101.0 KB）。
>   阶段27 的基线是「1 份归档 / 86 个子集 / 2.1 MB」⇒ 扩到 6 份归档的并集后只多了约 0.2 MB。
>
> ### 🔴 一处旧实现是多余的（顺手删掉）
> 阶段27 的注释写「把字体文件交给 CSS Font Loading API」，但**不需要产出或注入任何 CSS 文件**：
> `FontFaceManager.setFontFaces()`（`node_modules/maplibre-gl/src/render/font_face_manager.ts`）
> 把每个 face **直接 `new FontFace(...)`** 交给 `document.fonts`，**自己另起内部族名**
> （`maplibre-gl-font-face-<n>`）——它**不读 CSS、也不用 CSS 里的字体族名**。
> 所以：`font-faces` 的**键**才是 `text-font` 里的名字；多族 = 多键；族间回退靠 `text-font` 的先后顺序。
> 三条结论都写进了脚本头部注释，避免后人再按「CSS 注入」的思路改坏它。
>
> ### ⚠️ 体积红线的正式验收仍待 T10
> 字体进安装包（`public/fonts`），所以 `check_release_redlines.mjs --with-exe` 要在 T10 重打安装包时跑。
> 本次净增约 **0.2 MB**（不是设计预估的 +2–6 MB —— 那是按"加三族"估的）。

**Files:**
- Modify: `scripts/fetch_glyphs.mjs`（单族 → 配置数组）、`src/lib/basemapFonts.generated.ts`（重新生成）、`MapPage.tsx`（`text-font` 改多族 fontstack）

- [x] **Step 1: 字体族从常量改配置数组**（每族：family / fontsource CSS 地址 / CDN 基址 / 输出目录）
- [x] **Step 2: 先加 KR / JP / Thai 三族** → **被实测推翻**：三族各新增 0 / 1 / 0 个码位，**裁定不加**（见上表）
- [x] **Step 3: 重扫**6 份底图归档 `places` 层码位（含 T2 的 `basemap-kp-kr` 与核心底图），只下载命中子集
- [x] **Step 4: 西里尔按扫描结果决定** —— **缺 9 个码位，加 `Noto Sans`**（设计 §6.2 第 4 条要的正是这个结论）
- [x] **Step 5: `text-font` 改多族 fontstack；记录增量** —— **2.28 MB**（净增约 0.2 MB），`tsc`/`vite build` 0

---

## Task 8: 其余 4 区域（挂机）

> ### ✅ 已定：**稀疏区改粗网格**（2026-09-25，用户拍板 B 方案）
>
> 决策依据是 kp-kr 的实测锚点：**60 块 ≈ 1.45 h ⇒ 87 秒/块（含 504 重试开销）**。
> 若照设计表原网格，其余 4 区是 1,101×2 = **2,202 块 ≈ 53 h（2.2 天）**；
> 改粗后 = **230 块 ≈ 5–8 h**，而**数据完全相同**（同 bbox、同查询，只是切块更粗）。
> 依据：A2 的补抓就是按 ≈5°×4° 在全国（含华东密集区）跑完的，没有超时；
> 而这些区域是 OSM 稀疏区（设计自己记了 MN 约 990 条 line），小块纯属把时间花在空查询上。
>
> 落地方式：**写进批次定义**（`pipeline_regions.mjs` 每个稀疏批次带 `target: {lon:5, lat:4}`，
> `gridFor()` 优先用它），而不是每次手传 `--target-cell` —— 这样断点键、清单 `chunks`、文档表三处同源。
> 实测网格：mn **6x3**、sea-mainland **3x6**、ca **8x5**、ru-far **13x3**（单元 ≈5°×4°）。
> ⚠️ kp-kr 保持原细网格（已跑完；韩国密度高，细网格有理由）。

对 `mn` / `sea-mainland` / `ca` / `ru-far` 各跑一次（一条命令跑完 4 个区域，串行）：

```powershell
node scripts/run_pipeline.mjs --regions mn,sea-mainland,ca,ru-far --category power,converters --endpoint https://overpass-api.de/api/interpreter
```
每批完成后立刻跑门禁（同 T1 Step 4），失败块原样重跑补齐（kp-kr 的经验：通常 2–3 轮清空）。

> ### ✅ 已完成（2026-09-25）—— 4 区全部跑完，5 个包门禁全绿
>
> `data/packs/pipeline_report.json` 里 12 个批次**全部 `status: "ok"`**（含 4 个新批次），
> 各批 `complete: true` / `failed_chunks: []`。实测（`data/packs/` 文件字节数）：
>
> | 区域 | 网格 | 电网包 | 底图包 |
> |---|---|---|---|
> | `mn` 蒙古 | 6x3 | 11.41 MB | 9.48 MB |
> | `sea-mainland` 中南半岛 | 3x6 | 18.24 MB | 15.50 MB |
> | `ca` 中亚五国 | 8x5 | 35.98 MB | 24.13 MB |
> | `ru-far` 俄相邻带 | 13x3 | 16.06 MB | 20.97 MB |
> | `kp-kr` 朝鲜半岛（T1/T2） | 6x5 | 4.51 MB | 10.45 MB |
>
> **门禁（2026-09-25 实跑，5 个包逐个 `node scripts/verify_pack.mjs`）：8 项断言全绿**，
> 退出码 0。要点摘录：
> - 最大单瓦片：kp-kr 174.7 KB / mn 110.7 KB / sea-mainland 274.7 KB / ca 370.0 KB / ru-far 179.3 KB（均 < 500 KB）
> - **`z<8` 的线路要素带 `is_dc` 比例全是 100%**（7542/7542、20320/20320、35337/35337、58091/58091、20452/20452）
>   ⇒ 低缩放直流配色不会静默失效
> - 无解码失败、无 `undefined/null` 属性值；z≥8 各 ftype 专属属性与扩容属性都命中
> - `ru-far` 的 `converter` 显示「未抽样到」——该区换流站要素为 0（`converters 0 features`），不是缺陷
>
> ⚠️ 设计 §7.1 第 1 条的完整口径还要 `verify_power_only.mjs`（geojson + pmtiles 两份），
> 那一步留到 T11 一并跑并留档；本次已跑的是 `verify_pack.mjs`（体积与不丢数据口径）。

---

## Task 9: 清单重算 + 上传 10 个新包

> ### ✅ T9 已完成（2026-09-25）—— 10 个包已上传，远端门禁退出码 0
>
> | 步骤 | 结果 |
> |---|---|
> | Step 1 10 个包文件都在 | ✅ 5 电网（4.51 / 11.41 / 18.24 / 35.98 / 16.06 MB）+ 5 底图（10.45 / 9.48 / 15.50 / 24.13 / 20.97 MB） |
> | Step 2 `gen_packs_manifest.mjs` | ✅ 清单 **18 条**：`region:12 + basemap:5 + gem:1`；5 条 `forRegion` **指纹非空**；`downloadUrl` 无 null |
> | Step 3 `upload_packs.mjs --dry-run` | ✅ 计划正是 **8 个「已一致（跳过）」+ 10 个「新增」** |
> | Step 4 上传 | ✅ `upload_packs.mjs --yes`，**10 个新增全部成功**：逐个「上传为 `.stage` → 远端校验 size+digest → PATCH 改回正式名」，**全程无资产缺失窗口**；已一致的 8 个跳过 |
> | Step 5 `verify_packs.mjs --remote` | ✅ **退出码 0**：远端 18 个资产与清单**全部一致**（`🔴 未发现问题`） |
>
> **两处操作性记录**（避免下次再踩）：
> - `upload_packs.mjs` 默认**交互式**问一次 `yes`；后台/脚本跑必须加 **`--yes`**，
>   否则会以 `Detected unsettled top-level await` 退出（exit 1）而**看起来像失败**。
> - `verify_packs.mjs --remote` 同时报「本机 `%APPDATA%\...\packs\` 装了 8/18」——
>   **那是正常的**（数据包按需下载）；要本地投满用 `install_packs.mjs --user-dir`。
>   门禁的判据是**远端那 18 行**，不是本机装了几个。
>
> **远端资产实测（2026-09-25，GitHub API）**：18 个资产合计 **328.75 MB**
> —— 区域包 12 个 241.16 MB、底图包 5 个 80.52 MB、GEM 1 个 7.07 MB。
> 新上传的 10 个资产下载次数均为 0（刚上线，符合预期）。
>
> 上传完成后**清单与远端已一致** ⇒ T3 的处置条件满足，18 条清单已提交；
> T10 那份 46.09 MB 的安装包因此也**变得可发布**（它带着同一份 18 条清单）。

- [x] **Step 1: 确认 10 个包文件都在**（5 电网 + 5 底图）
- [x] **Step 2: `node scripts/gen_packs_manifest.mjs`** → 清单 18 条
- [x] **Step 3: `node scripts/upload_packs.mjs --dry-run`** → 确认计划里是 8 个"已一致（跳过）"+ 10 个"新增"
- [x] **Step 4: `node scripts/upload_packs.mjs --yes`**（10 个新增全部上传成功）
- [x] **Step 5: `node scripts/verify_packs.mjs --remote`** → **退出码 0**

---

## Task 10–12: 安装包、验收、文档

> ### ✅ T10 已完成（2026-09-25）—— 体积与红线实测
>
> | 项 | 实测 |
> |---|---|
> | `npm run tauri build` | ✅ 退出码 0（Rust release 编译 3 分 20 秒） |
> | NSIS 安装包 | **46.09 MB（48,327,873 字节）≤ 50 MB 红线** |
> | 裸 exe | 9.67 MB |
> | `check_release_redlines.mjs --with-exe` | ✅ **通过**（dist 5 条禁用串全未命中、对照串 `localhost:11434` 命中；exe 侧禁用串未命中、`export_csv_file`/`tauri.localhost` 命中） |
>
> **体积构成（实测，用来核对"字体净增 0.2 MB"这个数字）**：
> 随包资源 = `basemap.pmtiles` 31.76 MB + `global_power_gis.db` 9.00 MB + `osm_grid.pmtiles` 7.12 MB
> + `osm-zhejiang.pmtiles` 3.48 MB + dist 4.89 MB（其中字体 2.28 MB）+ 裸 exe 9.67 MB ≈ 66 MB 未压缩，
> LZMA 压到 46.09 MB。本次相对上一版的净增就是字体的 **+0.18 MB**（2.10 → 2.28 MB）
> 与清单的 +0.02 MB ⇒ 与实测增幅一致。
>
> ⚠️ **`check_release_redlines.mjs` 不检查安装包体积**（它只查 dist 与 exe 里的禁用/对照串，
> 全文没有 50 MB 判据）⇒ 50 MB 红线必须**另外手工量 NSIS 产物**，
> 不能把"红线脚本通过"当成"体积达标"。这是一处容易自欺的地方，记在这里。
>
> ✅ **这份安装包现在可发布**：T9 已把 10 个新包上传完成，`verify_packs.mjs --remote` 退出码 0，
> 清单里的 18 条与远端 18 个资产**全部一致** —— 不存在「点不动的空区域」。
> （构建当时的清单就已经是 18 条，所以**不需要**重新打包。）

- [x] T10 `npm run tauri build` → `check_release_redlines.mjs --with-exe` → 记录体积（≤50 MB）
- [x] T11 设计 §7.1 七条：①每包门禁 ②远端全绿 ③构建红线 ④**边境连续性抽样**（满洲里/二连浩特/凭祥，两侧 50 km 内电网与底图都存在）⑤**地名无方块**（平壤/首尔/乌兰巴托/曼谷/河内——**东京已按口径修正剔除**）⑥中国侧零回归（长三角/华北 + 安装包 ≤50 MB）⑦`--bbox` 非国界的偏差已写进 README 与向导文案 —— **④⑤⑥ 2026-09-26 运行时实测闭合**
- [x] T12 同步 README / README_OSM / PROJECT_HANDOFF / 设计文档（把"实测项"换成实测值）

---

## T11 验收记录（设计 §7.1 逐条）

> 结论：**七条全部闭合**。①②③⑦ 是静态/构建/远端级证据；**④⑤⑥ 已于 2026-09-26 补上运行时实测**
> （真跑实例 + CDP 驱动，见下方「④⑤⑥ 运行时验收记录」）。
> ⇒ 项目 B 至此**不再存在"只差真跑一次"的条目**。

| # | 条目 | 状态 | 证据 |
|---|---|---|---|
| ① | 每批次独立验收 | ✅ | `verify_pack.mjs` × 5 邻国包（8 项断言全绿，见 T8）；`verify_power_only.mjs` × **12 区域 × 2 产物 = 24 次全 PASS**（下表） |
| ② | 远端资产齐备 | ✅ | `verify_packs.mjs --remote` **退出码 0**；18 个资产 = 区域包 12 + 底图包 5 + GEM 1 = **328.75 MB** |
| ③ | 红线与构建 | ✅ | `npm run typecheck` 0；`npm run build` 0（1,485.29 kB / gzip 432.05 kB）；`check_release_redlines.mjs --with-exe` 通过 |
| ④ | **边境连续性抽样** | ✅ **已闭合（2026-09-26 运行时实测）** | 三处边境**两侧**都有电网要素与底图要素，见下方「④⑤⑥ 运行时验收记录」；截图 `phase56b-border-{manzhouli,erenhot,pingxiang}.png` |
| ⑤ | **地名无方块** | ✅ **已闭合（2026-09-26 运行时实测）** | 平壤 / 首尔 / 乌兰巴托 / 曼谷 / 河内**五处全部为可读汉字**，无方块；截图 `phase56b-placename-*.png`。口径仍为**去掉东京**：日本不在本阶段范围，现有底图只到 128E（见下方说明） |
| ⑥ | 中国侧零回归 | ✅ **已闭合** | 安装包 **46.09 MB ≤ 50 MB** ✅、`tsc`/`vite build` 0 ✅、指纹未变 ✅；**运行时**实测长三角核心区仍不选举区域包（只用核心区归档）、华北选举 3 个国内包且无叠加层 ⇒ 与阶段54 一致（`PACK_MAX_ACTIVE` 2→3 是唯一影响选举的改动，核心区优先逻辑未动） |
| ⑦ | 文档一致 | ✅ | README（当前阶段段落改阶段56-B、包数与 `PACK_MAX_ACTIVE` 数字）、README_OSM（新增 §十九 阶段56-B 全文 + 作废旧口径）、PROJECT_HANDOFF（数字表 + A3 状态 + 新增项目B条目）、`PACKS_UPLOAD_RUNBOOK`（顶部现状与 18/18 期望）、`.gitignore`（字体体积与多族说明） |

### ④⑤⑥ 运行时验收记录（2026-09-26，真跑实例）

**怎么跑的（可复现）**

- 前置：`node scripts/install_packs.mjs --user-dir` ⇒ **18/18** 到位（原先只装了 8 个）。
- 起实例：临时给 `tauri.conf.json` 的窗口加 `"additionalBrowserArgs": "--remote-debugging-port=9222"`，
  再 `npm run tauri dev`。**为什么必须改配置**：Tauri 自己会传默认参数，WebView2 一旦看到
  显式 `additionalBrowserArgs` 就**忽略** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量
  （本机实测：只设环境变量时 9222 端口**不监听**）。量完已 `git checkout -- src-tauri/tauri.conf.json`
  还原，确认工作区无 `9222` 残留。
- 驱动：CDP 连 `http://127.0.0.1:9222`，从 React fiber 的 `useRef` 链里取出 MapLibre 实例，
  用 `jumpTo` 定位、`queryRenderedFeatures` 计数、`Page.captureScreenshot` 留图
  （脚本 `data/cdp/drive.mjs` + `layerbox.js`；`data/` 被 gitignore，脚本会留在原地可复用）。
- ⚠️ **两个坑（以后复用会再遇到）**：
  1. `queryRenderedFeatures` 的 box 必须传 `[[x1,y1],[x2,y2]]` 两元组 —— 传扁平的
     `[x1,y1,x2,y2]` 是**非法几何，静默返回空数组**（不报错，第一次就踩了）。
  2. `map.project()` 给的是**画布内**坐标，而 CDP 截图是**整页**坐标。本机 1280×800 窗口里
     画布只有 **1083×751、偏移 (197,49)** ⇒ 不加上偏移去裁剪会整体错位（第一次裁出来一片空白）。

**④ 边境连续性**（判据：两侧 50 km 内电网与底图都在）——用 ±0.7° 经度（≈50 km）分东西两框计数

| 点 | 生效区域包 | 叠加底图 | 外侧框（对方国家） | 中国侧框 |
|---|---|---|---|---|
| 满洲里（中俄）117.4E/49.6N | mn、ru-far、dongbei | `basemap-overlay-mn` | 220kV 线路 11 + 变电站 15 + 命中线 47；底图 earth/roads(5+5)/boundary/place 全来自 **overlay** | 220kV 28 + 500kV 3 + 变电站 56 + 电厂 4 + dongbei 4；底图 overlay label 2 |
| 二连浩特（中蒙）112.0E/43.6N | mn、xibei、huabei | `basemap-overlay-mn` | 220kV 1 + 变电站 9 + 电厂 5；底图 global **+** overlay-mn（earth/roads/boundary） | 220kV 25 + 500kV 6 + 变电站 19 + 电厂 6 + huabei 命中 3；底图 global + overlay-mn |
| 凭祥（中越）106.8E/22.1N | sea-mainland、huanan、xinan | `basemap-overlay-sea-mainland` | 220kV 3 + 变电站 15 + 电厂 11；底图 global + overlay（earth/water/roads/boundary） | 220kV 15 + 500kV 1 + 变电站 38 + 电厂 71 + 命中 102；底图 global + overlay |

- 三处**两侧都有**电网与底图 ⇒ **④ 通过**；截图 `docs/screenshots/phase56b-border-{manzhouli,erenhot,pingxiang}.png`。
- 三处生效包数都是 **3 = `PACK_MAX_ACTIVE`**（上限生效、没超选）；`[MapPage] 加载邻国底图包 <key>`
  与移开后的 `卸载邻国底图包` 都真实出现 ⇒ T6b 的挂/摘生命周期在实例里成立。
- ⚠️ **一处设计限制（不是缺陷，但要知道）**：叠加层**同时只挂一个**（取 `activePacks` 里第一个
  有底图包的邻国）。满洲里同时选中 mn/ru-far/dongbei，实际挂上的只有 `basemap-overlay-mn`；
  实测该 bbox 正好覆盖俄侧用量，所以俄侧底图照样有 —— 但「同时需要两个邻国底图」的视野
  （如中俄蒙三界交汇）**依赖第一个包的 bbox 恰好够用，没有兜底**。

**⑤ 地名无方块（五处）**

| 抽样点 | 数据里的 `name` | **实际渲染** | 出处 |
|---|---|---|---|
| 平壤 | 평양시 | **平壤市** | `basemap-place-labels` |
| 首尔 | 서울특별시 | **首尔特别市**（另见 仁川广域市 / 城南市） | 同上 |
| 乌兰巴托 | Улаанбаатар | **乌兰巴托** | 同上 |
| 曼谷 | กรุงเทพมหานคร | **曼谷** | 同上 |
| 河内 | Hà Nội | **河内市**（另见 海防市） | 同上 |

- 五处**全部是可读汉字、没有一处方块** ⇒ **⑤ 通过**（`phase56b-placename-*.png`，含两张放大件）。
- 🔎 **机制（比"通过"本身更重要）**：该图层 `text-field` 是
  `coalesce(name:zh-Hans → name:zh-Hant → name:en → name)`，`text-font` 是
  `["Noto Sans SC Offline", "Noto Sans Offline"]`。这五座城在底图里**都有中文名**
  ⇒ 真正画出来的是**中文**，吃的是 **CJK 字形**；本阶段新增的韩文/西里尔字形是**兜底链的下一级**，
  在这五个点上**根本没被触发**。
  ⇒ 所以 ⑤ 证明的是「**中文兜底层完好、CJK 字形完整**」，**不等于**证明了「韩文/西里尔原文也能画」。
  后者仍只有 T7 的码位扫描 + 归档实解这一级（静态）证据。要真验，得找一个
  **只有本地文字、既无中文名也无英文名**的地名（泰/老边境的部分村镇更接近这种情形，
  但那里的兜底是 `name:en`，仍是拉丁字母）。

**⑥ 中国侧零回归**

| 视野 | 生效包 | 叠加层 | 实测 |
|---|---|---|---|
| 长三角 120.5E/31.2N（**在核心区 bbox 内**） | **无**（`packKeysInLayers` 为空） | 无 | 只用核心区归档：220kV 1704 / 500kV 536 / 735kV 44 / 直流 38 / 变电站 1377 / 换流站 3 / 电厂 232 ⇒ **核心区优先仍生效** |
| 华北 116.5E/38.5N | huabei、huadong、dongbei | **无** | 三包都出图（huabei 220kV 711 / 500kV 156 / 735kV 45）+ 底图 + 电厂 ⇒ 国内选举正常 |

- 国内视野**不出现任何叠加底图 source**（叠加层只对邻国区域生效）⇒ 中国侧渲染路径与阶段54 一致；
  截图 `phase56b-regression-{yrd-core,huabei}.png`。
- 图层默认可见性与代码里的 `DEFAULT_ON_TIERS` 一致（735/500/220 + 直流 + 换流站 + 海缆默认开；
  **<220 与 电压未知默认关**）。这条**与本阶段无关**：`git diff 8e7a824..HEAD -- src/pages/MapPage.tsx`
  显示 B 阶段对地图页的改动只有「叠加层生命周期」与「选举过滤」，没碰默认档位。

**顺带发现（不属验收项，供以后参考）**

1. **左侧面板会挡住靠西的标注**：1280×800 下「当前视野 / 图层控制」面板占到约 x<497px。
   以 126.4E 为中心时平壤落在 x≈424 —— **整座城的标注被面板盖住**；把中心移到 124.9E 后同一标注可见。
   ⇒ 面板遮挡是**既有布局**，不是本阶段引入；但以后验收"某地地名可见"这类条目时，
   取样中心要避开面板覆盖区，否则会得出假的"没画出来"。
2. 验收期间曾观察到外部鼠标事件把地图从满洲里拖到长三角（一次性），已排除是应用自身行为；
   后续若再跑 CDP 验收，最好先确认没人在动那个窗口。

### ① 的 24 次门禁明细（`node scripts/verify_power_only.mjs <文件>`，全部 PASS）
| 区域 | geojson 线路数 / 属性缺失 | 归档 readback |
|---|---|---|
| `huadong` | 63,994 / `(none)` | ok=10（含 `grid` 层）z0-12 |
| `huazhong` | 40,166 / `(none)` | ok=23 z0-12 |
| `huanan` | 31,604 / `(none)` | ok=21 z0-12 |
| `huabei` | 44,153 / `(none)` | ok=22 z0-12 |
| `dongbei` | 19,659 / `(none)` | ok=26 z0-12 |
| `xinan` | 47,416 / `(none)` | ok=27 z0-12 |
| `xibei` | 45,628 / `(none)` | ok=25 z0-12 |
| `kp-kr` | 8,032 / `(none)` | ok=18 z0-12 |
| `mn` | 13,774 / `(none)` | ok=24 z0-12 |
| `sea-mainland` | 31,036 / `(none)` | ok=18 z0-12 |
| `ca` | 41,287 / `(none)` | ok=25 z0-12 |
| `ru-far` | 13,087 / `(none)` | ok=22 z0-12 |

- geojson 侧判据：**必备属性一个都不能缺**（`missing=(none)` 才算 PASS）——24 次里 12 次全绿。
- 归档侧判据：**结构可读 + 含 `grid` 层**（脚本自己打印 `readback ok=N missing=M`；
  `missing` 是抽样到但**没有 grid 层**的瓦片数 —— 该判据由**是否有瓦片可读**决定，
  所以 `ok` 只要 > 0 即 PASS；实测每包 `ok` 都是 10~27）。

### ④⑤ 的**包覆盖**前置核实（实测，不启动应用也能做的那一半）

把 6 个抽样点丢进已发布包的 bbox 里查（结果如下）——这一步能排除「点压根不在任何包里」
这种必然失败，但**不能替代**真实渲染：

| 抽样点 | 落在哪些电网包 | 落在哪些底图包 |
|---|---|---|
| 满洲里 中国侧 117.38,49.6 | `mn`、`ru-far` | `basemap-mn`、`basemap-ru-far` |
| 满洲里 俄侧 116,49.8 | `mn`、`ru-far` | `basemap-mn`、`basemap-ru-far` |
| 二连浩特 中国侧 111.98,43.65 | `mn` | `basemap-mn` |
| 二连浩特 蒙侧 110.5,43.6 | `xibei`、`mn` | `basemap-mn` |
| 凭祥 中国侧 106.76,22.11 | `huanan`、`xinan`、`sea-mainland` | `basemap-sea-mainland` |
| 凭祥 越侧 106.3,21.6 | `huanan`、`xinan`、`sea-mainland` | `basemap-sea-mainland` |
| 平壤 125.75,39.03 | `dongbei`、`kp-kr` | `basemap-kp-kr` |
| 首尔 126.98,37.57 | `kp-kr` | `basemap-kp-kr` |
| 乌兰巴托 106.92,47.92 | `xibei`、`mn` | `basemap-mn` |
| 曼谷 100.5,13.75 | `sea-mainland` | `basemap-sea-mainland` |
| 河内 105.85,21.03 | `huanan`、`sea-mainland` | `basemap-sea-mainland` |
| **东京 139.69,35.69** | **无** | **无** |

⇒ 三处边境的**两侧都在包内**（这满足 ④ 的必要条件）；
5 个底图包的 `bbox` 与同区域电网包**逐个完全一致**（`forRegion` 关联正确）。

> ### 🔴 发现一处**验收口径本身有问题**：**东京（139.69E）不在任何包的覆盖内**
>
> 现有底图只覆盖到 **128E**，而本阶段 5 个邻国批次**不含日本**（kp-kr 的 bbox 是 124.3–131E）。
> ⇒ 东京在任何缩放级下都看不到邻国底图，**这是本节新增的口径缺口，不是本阶段引入的回归**：
> 阶段54 的底图同样只到 128E，东京的底图覆盖从来就没做（设计 §7.1 第 5 条把东京列进抽样点，
> 但 §1.2 的目标只写了"5 个邻国"，两者本来就不自洽）。
> **处置**：①⑤ 的运行时验收**去掉东京**，并在 T12 已同步的文档里如实写明
> 「日本不在本阶段范围内，东京无底图/电网包」——不把"数据现状"包装成"验收通过"。
> 若将来要覆盖东京，是**新批次**（`jp`）的工作量，不属于本项目 B。


---

## 自检（对设计文档逐条）

| 设计条目 | 落在哪个任务 |
|---|---|
| §1.2 目标 1（5 邻国电网包） | T1、T8 |
| §1.2 目标 2（5 底图包 + `kind: "basemap"`） | T2、T3 |
| §1.2 目标 3（多文种字形） | T7 |
| §1.2 目标 4（装载上限 2→3） | T6 Step 2 |
| §1.2 目标 5（中国侧零回归） | T6 Step 1/3、T11 第 6 条 |
| §3.1 批次入表 | T0 ✅ |
| §3.3 切片参数与清单不手改 | T1、T8、T3 |
| §4.1 底图生成 | T2 |
| §4.2 清单形状（`forRegion`、`features: null`） | T3 |
| §4.4 4a 独立叠加 source | T6 Step 3 |
| §5.1 / §5.2 / §5.3 三处必改 | T4 / T5 / T6 |
| §5.4 不需要改的 | 已核实，无任务（**Rust 不改**） |
| §6 字形 | T7 |
| §7.1 验收七条 | T11 |
| §10.2 三处修订 | T0（口径/converters/顺序）、全计划遵守 |

**占位符扫描**：无 TBD/TODO；每个改动任务都给了文件、命令与期望。**类型一致性**：`isRegionPack`/`isBasemapPack`/`forRegion` 在 T3–T6 间命名一致。
