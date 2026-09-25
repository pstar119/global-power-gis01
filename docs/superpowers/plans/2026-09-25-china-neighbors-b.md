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
| T6 | 选举过滤 + 上限 3 + 底图叠加 source | `MapPage.tsx` | 底图包不进 `activePacks`；`tsc`/`vite build` 0 | 1–1.5 h |
| T7 | 字形多族（KR/JP/Thai + 西里尔按扫描） | `src/lib/basemapFonts.generated.ts` 等 | `fetch_glyphs.mjs --estimate` 实测增量；安装包仍 ≤50 MB | 1–2 h |
| T8 | 其余 4 区域抓取+切片 | `osm-{mn,sea-mainland,ca,ru-far}.pmtiles` + 4 底图包 | 每包门禁 PASS | 13–21 h（挂机） |
| T9 | 清单重算 + 上传 10 包 | Release 上 18 个资产一致 | `verify_packs.mjs --remote` → **退出码 0** | 0.5 h + 上传 |
| T10 | 重打安装包 + 红线 | `Global Power GIS_0.2.0_x64-setup.exe` | `check_release_redlines.mjs --with-exe` 通过、≤50 MB | 0.3 h |
| T11 | §7.1 七条验收 | 验收记录 | 含边境连续性抽样、地名无方块、中国侧零回归 | 1 h |
| T12 | 文档同步 | README / README_OSM / PROJECT_HANDOFF | 口径、包数、体积、批次表一致 | 0.5 h |

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

> ### 进展：**T6a 已完成（2026-09-25）**，T6b 待做
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
> **T6b（待做）**：底图包叠加 source 的**生命周期**（与 GEM 同构）——
> 当选中的区域包存在 `forRegion === 该 key` 的底图包且**已安装**时，
> 以独立 source `basemap-overlay-<key>` 叠加，只挂 `earth/water/boundaries/places/roads`，
> 用 `moveLayer` 精确插在「中国底图之上、电网图层之下」；卸载时连同图层一起摘。
> 现有 `BASEMAP_SOURCE`（`"basemap"`）的 URL/图层/样式**一行不动**。
> ⚠️ 没有 T6b 时：邻国区域能正常显示电网，但**看不到邻国底图**（不报错，只是底图是空的）。
> 它不阻塞 T3/T9（清单与上传），阻塞的是 §7.1 第 4/5 条验收（边境连续性与地名无方块）。

**Files:**
- Modify: `src/pages/MapPage.tsx`（选举过滤、`PACK_MAX_ACTIVE`、新增 basemap 叠加生命周期）

- [ ] **Step 1: 选举只认区域包**

```ts
// 原：.filter((p) => !isThematicOverlay(p))  ← 底图包会被选进来、占名额、被当 grid 图层挂载
const candidates = packsManifest.packs.filter(isRegionPack);
```

- [ ] **Step 2: `PACK_MAX_ACTIVE` 2 → 3**（`PACK_MIN_ZOOM` 保持 6）

- [ ] **Step 3: 底图包叠加生命周期（与 GEM 同构）**

```ts
// 当选中的区域包有 forRegion === 该 key 的底图包**且已安装**时，作为独立 source 叠加：
//   id: `basemap-overlay-${key}`；tiles: pmtiles://…；只挂 earth/water/boundaries/places/roads
// 位置：压在中国底图图层之上、电网图层之下（用 moveLayer 精确插位，别依赖 addLayer 追加到顶）
```
Expected: 现有 `BASEMAP_SOURCE`（`"basemap"`）的 URL/图层/样式**一行不动**

- [ ] **Step 4: `tsc --noEmit` 0 与 `vite build` 0 → Commit**

---

## Task 7: 字形多族

**Files:**
- Modify: `scripts/fetch_glyphs.mjs`（单族 → 配置数组）、`src/lib/basemapFonts.generated.ts`（重新生成）、`MapPage.tsx`（`text-font` 改多族 fontstack）

- [ ] **Step 1: 字体族从常量改配置数组**（每族：family / fontsource CSS 地址 / CDN 基址 / 输出目录）
- [ ] **Step 2: 先加 KR / JP / Thai 三族**
- [ ] **Step 3: 重扫**5 份新底图归档 `places` 层码位（含 T2 的 `basemap-kp-kr`），只下载命中子集
- [ ] **Step 4: 西里尔按扫描结果决定**是否加 `Noto Sans`（不预设结论）
- [ ] **Step 5: `text-font` 改 `[SC, KR, JP, Thai]`；`fetch_glyphs.mjs --estimate` 记录增量 → Commit**

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

---

## Task 9: 清单重算 + 上传 10 个新包

- [ ] **Step 1: 确认 10 个包文件都在**（5 电网 + 5 底图）
- [ ] **Step 2: `node scripts/gen_packs_manifest.mjs`** → 清单 18 条
- [ ] **Step 3: `node scripts/upload_packs.mjs --dry-run`** → 确认计划里是 8 个"已一致（跳过）"+ 10 个"新增"
- [ ] **Step 4: `node scripts/upload_packs.mjs`**（**对外发布，需用户确认**）
- [ ] **Step 5: `node scripts/verify_packs.mjs --remote`** → **退出码 0**

---

## Task 10–12: 安装包、验收、文档

- [ ] T10 `npm run tauri build` → `check_release_redlines.mjs --with-exe` → 记录体积（≤50 MB）
- [ ] T11 设计 §7.1 七条：①每包门禁 ②远端全绿 ③构建红线 ④**边境连续性抽样**（满洲里/二连浩特/凭祥，两侧 50 km 内电网与底图都存在）⑤**地名无方块**（平壤/首尔/乌兰巴托/东京/曼谷/河内）⑥中国侧零回归（长三角/华北 + 安装包 ≤50 MB）⑦`--bbox` 非国界的偏差已写进 README 与向导文案
- [ ] T12 同步 README / README_OSM / PROJECT_HANDOFF / 设计文档（把"实测项"换成实测值）

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
