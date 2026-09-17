# Global Power GIS — 项目交接文档

> 用途：开启新对话时无缝交接。**只读本文档 + 仓库现状即可恢复全部上下文。**
> 最后更新：2026-09-17（阶段 52 中途，含 CSV 导出与破例依赖）
> 当前版本：**v0.2.0**

---

## 0. 交接须知（先读这段）

新对话开始时，**不要**凭本文档的数字直接改代码。本文档区分三类信息：

- ✅ **本轮已实测核实**：带出处（文件:行 / 命令输出）。
- ⚠️ **有出处但含义需注意**：项目里确有该数字，但口径容易记错（已标注）。
- ❓ **未核实**：来自口头描述或历史文档，落地前请先查证。

### 依赖清单（阶段 52 起有破例）

阶段 50 之前项目执行「零新增依赖」。**阶段 52 破例新增 2 对包**（npm + cargo 各 2 个），
用于 CSV 导出的「另存为」对话框：

- `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` —— 弹原生「另存为」对话框
- `@tauri-apps/plugin-fs` / `tauri-plugin-fs` —— 写文件到用户选定路径

破例理由：CSV 导出必须让用户自选保存位置，浏览器原生 `<a download>` 只能写到系统默认
下载目录，无法满足。破例经**用户明确授权**（2026-09-17）。

**⚠️ 后续若再想加依赖，仍需单独授权，不得援引本次破例为「可以随便加」的先例。**

### 最容易记错的数字（四个）

| 数字 | 正确口径 |
|---|---|
| `430,969` | **纯电力要素**（线路 / 变电站 / 电厂） |
| `815,728` | **清单全要素**（含铁路 / 油气管道） |
| `46.54 MB` | 阶段50 记录的安装包体积；**版本已 bump 到 0.2.0，需重建后才有效** |
| `4.68 MB` | 长三角核心区切片体积 —— 🔴 **已过期**，实测 `osm_grid.pmtiles` = **7.49 MiB** |

> 🔴 **口径铁律**：说 `430,969` 必须带「电力要素」；说 `815,728` 必须带「清单全要素」。
> 两个都对，混用就错。

### 先做一次环境自检（见 §9）再动手

否则会卡在「找不到 node / python / git」——这三样**都不在 PATH**。

---

## 1. 项目目标

**Global Power GIS** —— 全球 / 全国电力与基础设施**离线 GIS 桌面应用**。

- 在**完全离线**的地图上浏览全球电厂分布，按燃料类型与装机容量筛选。
- 支持自然语言查询（本地 Ollama 优先，云端 API 可选）与结果高亮定位。
- 装完即用：内置 WRI 全量电厂数据 + Protomaps 离线底图，不依赖网络。
- 全国电网走**按需下载**的区域数据包，不塞进安装包。

---

## 2. 当前阶段

**阶段 51：UI/UX 最终打磨与产品化定型**（✅ 已完成，已提交 e31e881）

四项任务与验收结论：

| # | 任务 | 状态 | 结论 |
|---|---|---|---|
| 1 | 深色 / 浅色主题切换（纯 CSS 变量，零 UI 库） | ✅ | 新增 `src/lib/theme.ts`；`data-theme` + localStorage 双写；浅色实测生效 |
| 2 | 完善「关于」页面 | ✅ | 版本用 `getVersion()` 读取，**不写死**；许可全列 |
| 3 | 首次启动向导加「全选 / 取消全选」 | ✅ | 7 区域包走下载队列；**GEM 独立复选框**，不进 `finishBbox` |
| 4 | 1280×800 左侧看板滚动条 | ✅ 条件未成立 | 真首屏 `clientHeight 211 / scrollHeight 211` → **无滚动条**，故**未改**默认展开状态 |

### 阶段 51 遗留 / 已知不完美

1. **1280×800 边界情况**：用户手动展开「图层控制」后，面板 `693 / 704` → 溢出 **11px**，
   来源是「电力设施」组内部的 5 条电压分级勾选框。**未修**（怕无谓扩大改动面）。
   若要修：给这层加第三层折叠即可（`fuelMenuOpen` 已有可照抄的模式）。
2. ~~**原生标题栏仍是深色**~~ —— ✅ **阶段52 已修复**（`e31e881`）：
   新增 `syncNativeTheme()` 动态同步，`capabilities` 已放行
   `core:window:allow-set-theme`。
3. ~~**未提交**~~ —— ✅ **阶段52 已提交**（`e31e881` / `42cc5a6` / `3219cef`），详见 §10。

---

### 阶段 52（进行中）

**阶段 52：CSV 导出与 AI 工作台布局重构**

| # | 任务 | 状态 |
|---|---|---|
| 1 | 主题切换同步 Tauri 原生标题栏 | ✅ 已提交 e31e881 |
| 2 | AI 工作台改为地图上方横向条（乙方案） | ✅ 已提交 42cc5a6 |
| 3 | CSV 导出（另存为对话框，破例新增 dialog + fs） | ✅ 已提交 3219cef |
| 4 | 数据包托管迁移评估 | ⏸ 未开始 |
| 5 | 复杂 AI 空间查询 | ⏸ 未开始 |
| 6 | GeoJSON 导出 | ⏸ 未开始 |
| 7 | GEM 可再生能源引入 | ⏸ 未开始 |
| 8 | 数据包多源降级（镜像失败切直连） | ✅ 已提交 59a8368 |

**阶段 52 遗留**：
- `fs:write-all` 权限是全放开（因为用户可能选任意路径），后续可考虑用 `fs:scope` 收紧
- 待评估：新增的 dialog + fs 插件对安装包体积的影响（待下次打包实测）

---

## 3. 已完成功能清单

### 3.1 数据层

| 数据 | 内容 | 出处 / 核实状态 |
|---|---|---|
| WRI 电厂 | **34,936 座**（seed 库 `power_plants`） | ✅ 本轮实测 `SELECT count(*)` = 34936 |
| GEM 发电设施 | **33,790 机组 → 聚合为 14,793 座电站**<br>煤炭 4,865 / 油气 6,390 / 生物质 3,538 | ✅ 脚本头部与 README/迁移注释三处一致；<br>包内 14,793 为本轮实测 |
| GEM 覆盖范围 | ⚠️ **只有三类机组级 tracker：煤炭 / 油气 / 生物质**。<br>**风 / 光 / 水 / 核 / 储不在开放 API 里** —— 它们只在需要**填表申请**的 GIPT（182,400 机组）中 | ✅ `scripts/import_gem_plants.py` 的 `TYPES` 只有三项；<br>开放 API 对 `nuclear`/`hydro`/`wind`/`solar` 逐个返回 `total=0` |
| 全国 7 区域 OSM 电网 | **电力要素 430,969 个 / 116.52 MB**<br>（华东 93,559 · 华中 57,576 · 华南 45,295 · 华北 62,820 · 东北 29,948 · 西南 73,055 · 西北 68,716） | ⚠️ **口径 = 纯电力要素**（线路 / 变电站 / 电厂）。<br>出处 `README.md:339`、`README_OSM.md:825`（阶段38，2026-09-13） |
| 同上，**清单口径** | **全要素 815,728 个 / 163.25 MiB**（7 个区域包） | ✅ 本轮按 `public/packs_manifest.json` 求和。<br>⚠️ 与上一行**不是**矛盾：阶段39 增补了铁路 / 油气管道等非电力要素，**分块数仍是 806**（同一抓取网格），故要素数变大 |
| 铁路 / 油气管道 | 随区域包分发（含在上一行「全要素」口径内） | ❓ 单独计数未核实 |
| 离线底图 | Protomaps 切出的 `basemap.pmtiles`，**33,307,918 B = 31.77 MiB**（**不进 Git**） | ✅ 本轮实测 |
| 核心区电网 | `resources/maps/osm_grid.pmtiles`，**7,853,248 B = 7.49 MiB**，bbox `[118,27,123,33]`（长三角+浙江） | ✅ 本轮实测。<br>🔴 `README.md` 写的 **4.68 MB 已过期** —— 那是核心区归档**加入铁路/管道之前**的数字 |

> ⚠️ **两个数字口径不同，不可混用**：
> `815,728` 是**清单全要素**（含铁路 / 油气管道），`430,969` 是**纯电力要素**。
> 二者都对，因为它们统计的不是同一件事。

### 3.2 架构层

| 项 | 值 | 核实 |
|---|---|---|
| 安装包体积 | **48,802,068 B = 46.54 MiB**（NSIS，中文安装界面）<br>文件名仍是 `Global Power GIS_0.1.0_x64-setup.exe`，时间戳 2026-09-16 20:28 | ⚠️ 属**阶段50 记录值**；<br>版本已 bump 到 0.2.0，**需重新构建后才有效** |
| 裸主程序 | **9,713,664 B = 9.26 MiB** | ✅ 本轮实测 |
| 安装包内容 | **只有 3 项**：seed 库 + `basemap.pmtiles` + `osm_grid.pmtiles` | ✅ 本轮实测 `tauri.conf.json` 的 `bundle.resources` |
| 数据包数量 | **8 个**（7 区域 + 1 GEM = **170.32 MiB**），全部按需下载 | ✅ 本轮实测清单求和 |
| 数据包托管 | GitHub Release `v1.0-packs`，默认走 `gh-proxy.com` 加速镜像；`directBaseUrl` 为降级备用 —— **阶段53 起已接入代码**（见下行） | ✅ 本轮实测 `manifest.release` |
| 下载目录 | `%APPDATA%\com.pstar119.globalpowergis\packs\`<br>（本机实测已有 4 个包：gem + 华东 / 华南 / 华中） | ✅ 本轮实测 |
| 资源解析顺序 | ① `%APPDATA%\...\packs\` → ② `$RESOURCE/packs/` | ✅ `src-tauri/src/packs.rs` `resolve_pack_resource` |
| 包是否已装 | 运行时用 **127 字节 Range 探测**（只读，从不下载） | ✅ `MapPage.tsx` `ensurePmtilesArchive` |
| 渲染 | PMTiles 流式渲染（`asset:` 协议 + vector source） | ✅ |
| 传输 | 断点续传 + SHA256 校验 + 原子 rename | ✅ |
| 传输（阶段53） | **多源降级**：镜像（`baseUrl`）失败自动切直连（`directBaseUrl`）重试一次；仅网络类错误触发重试，校验类不重试 | ✅ |
| 资源协议白名单 | `$RESOURCE/maps/**`、`$RESOURCE/packs/**`、`$APPDATA/packs/**` | ✅ `tauri.conf.json` |
| 数据库版本 | `_sqlx_migrations` 到 **v9**，v1–v9 **9/9 success=1** | ✅ 本轮实测 |
| 现存索引 | `idx_power_plants_gppd_idnr` / `idx_power_plants_lat_lon` / **`idx_power_plants_fuel_cover`** | ✅ 本轮实测 |
| seed 库 | **9,437,184 B = 9.00 MiB**；`gem_coal_plants` 已 DROP | ✅ 本轮实测 |
| 开发库（本机） | 14,528,512 B（含 v9 迁移后的状态） | ✅ 本轮实测 |

> 📌 **体积归因的历史教训**：当初 GEM 进 SQLite 时那 **+6.10 MB** 只让安装包涨了 **0.82 MB**
> （45.72 → 46.54）—— 数据库走 LZMA 后压缩率很高。
> ⇒ **「种子库大小」与「分发包膨胀」不是一回事，评估体积时别直接相加。**

**三项全离线**：底图与电网切片来自安装目录（本地 `asset` 协议）、电厂数据来自 SQLite 种子库
（首启播种到 `%APPDATA%\com.pstar119.globalpowergis\global_power_gis.db`）、自然语言查询走本机 Ollama。

> 设置页自检显示 `substations 0 / transmission_lines 0` **属正常**：这两张表是早期演示数据，
> 阶段29 起的真实电网数据在 PMTiles 切片里，不再入库。

**GEM 的运行架构**（阶段50 起 —— **不进安装包，也不进 SQLite**）：

| 项 | 值 |
|---|---|
| 数据包 | `GEM Plants` — `packs/gem-plants.pmtiles`（**7,414,329 B = 7.07 MiB**，按需下载） |
| 清单条目 | `{ key: "gem", kind: "gem", label: "GEM Plants" }` |
| MapLibre source | `gem-pmtiles` —— **PMTiles vector source**（`pmtiles://` 协议） |
| `source-layer` | `gem`（归档内部 MVT 图层名，**不是** `gem-plants`） |
| MapLibre layer | `gem-plants` —— 单一 circle 图层，**默认关闭** |

### 3.3 AI 层

- 本地推理：**Ollama + Qwen 2.5 7B**（`http://localhost:11434`，已在 CSP 白名单）
- 云端可选：DeepSeek / 通义（dashscope）/ 智谱（bigmodel），**需用户自填 Key**（存 localStorage）
- 空间上下文注入：当前视野 / bbox / 缓冲距离参与提示词
- 多轮对话记忆；**追问继承地理约束**（补了确定性继承规则，绕开 `qwen2.5:7b` 追问时不输出
  `inViewport` 的问题）
- 相关文件：`src/lib/llm.ts`、`src/lib/nlq.ts`、`src/lib/aiQuery.ts`、
  `src/components/AiQueryPanel.tsx`、`src/components/MapQueryBox.tsx`
- **CSV 导出**在 `AiQueryPanel.tsx`（带 UTF-8 BOM + RFC 4180 转义 + 延迟 `revokeObjectURL`）
- 离线自测：`scripts/mock_ollama.mjs`
- 证据截图：`docs/screenshots/phase31-llm-in-viewport-query.png`、
  `phase33-multi-turn-memory-followup.png`

### 3.4 UI 层

- **深色主题**（阶段51 起可切浅色）
- **左侧数据看板**：当前视野统计 / 数据看板 / 图层控制 / 图例，四块可折叠
- **数据看板** `src/components/StatsDashboard.tsx`（**阶段45 引入的静态原型**，数字取自
  **WRI 真实快照**：34,936 座 / 5,707.0 GW / 15 类；带「静态原型」徽标 + 脚注，避免被误认为已完成功能）
  - ⚠️ 该看板的数字是**写死的快照**，不随查询/视野变化
- **多行弹窗**：电厂、变电站、输电线路、GEM 各自字段
- **图例折叠**；**图层控制折叠**（阶段45 为 1280×800 定的默认：只展开「电力设施」）
- **首次启动向导** `src/components/WelcomeWizard.tsx`：选区域 → 选主题包 → 选底图 → 下载
- 证据截图：`docs/screenshots/`（phase30 电压分档与视野统计、phase32 页面切换保状态、
  phase36 弹窗盖过悬浮面板、phase37 核心区南北、phase39 区域包）

### 3.5 数据模型：GEM 已从 SQLite 迁出（阶段 50 完成）

**这是最容易踩的历史坑，务必了解：**

- GEM 数据**不再**存在 SQLite 的 `gem_coal_plants` 表 → 改为 **PMTiles 数据包**。
- `migrations/009_drop_gem_coal_plants.sql` 已**真实执行**（v9，`success=1`）。
  ✅ **本轮实测确认：表已 drop，`sqlite_master` 里查不到 `gem_coal_plants`，无残留索引。**
- 前端只有**一个** vector source（`gem-pmtiles`）+ **一个** layer（`gem-plants`），
  source-layer 名为 `gem`。旧的 GeoJSON source / 两个旧图层已删除。
- 图层名从「GEM 煤炭数据」改为 **「GEM 发电设施」**，并保留 legacy 别名迁移
  （`LAYER_KEY_MIGRATIONS` + `normalizeLayerKeys`，避免老用户 localStorage 丢图层）。
- **GEM 现在是实心彩色圆**（按 `plant_type` 三色），**不是**空心环 —— 旧描述别再沿用。
- 旧脚本已归档为 `scripts/archive/import_gem_coal_legacy.py`（阶段51-A），
  **该脚本现已无法运行**（误跑会抛 `ImportAbort`，不会写坏数据）。
- 现在的刷新链路是「抓取 → GeoJSON → pmtiles → 数据包」：
  ```text
  scripts/import_gem_plants.py     抓取三类电源，产出电站级 GeoJSON
  scripts/build_pmtiles.mjs        用 --kind gem 切成 packs/gem-plants.pmtiles
  scripts/gen_packs_manifest.mjs   刷新清单里的 sizeMb / sha256 / bytes
  ```

### 3.6 数据导出（阶段 52）

- **地图页「当前视野」面板**右侧有「导出」按钮，导出**当前视野内的全部电厂**
- 走**原生「另存为」对话框**（用户自选路径），默认文件名
  `当前视野电厂_z{zoom}_{timestamp}.csv`
- **CSV 列**（9 列）：GPPD ID / 电厂名称 / 国家/地区 / 燃料类型 / 装机容量 / 纬度 /
  经度 / 投运年份 / 所有者
- 坐标精度 **5 位**（约 1m）；z < 8 时文件名带 `_z5` 之类标记
- **AI 查询结果**的 CSV 导出（设置页 `AiQueryPanel`）**也走同一套** `downloadCsv`
- 实现文件：`src/lib/csvExport.ts`（从 `AiQueryPanel.tsx` 抽出，两处共用）
- ⚠️ 依赖 `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs`（见 §0 依赖清单）

---

## 4. 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | **Tauri 2.11.5**，identifier `com.pstar119.globalpowergis`，targets `nsis`，`installMode: currentUser` |
| 前端 | **React 19.1.0** + **TypeScript ~6.0.3** + **Vite 8.3.0** |
| 地图 | **MapLibre GL 6.9.0** + **pmtiles 4.5.0** |
| 数据 | **SQLite（sqlx + `tauri-plugin-sql`，features `["sqlite"]`）** + seed 库 + PMTiles |
| 文件对话框 | **@tauri-apps/plugin-dialog 2.7.3** + **@tauri-apps/plugin-fs 2.5.2**（阶段52 破例） |
| AI | **Ollama**（本地）+ 可选云端 API |
| 窗口 | 1280×800，min 1000×700 |

> **注意驱动是 sqlx 不是 rusqlite**：版本表叫 `_sqlx_migrations`（列：version / description /
> checksum / success / installed_on），**没有** `migrations` 表。

`tsconfig` 严格档：`strict`、`noUnusedLocals`、`noUnusedParameters`，`include: ["src"]`。
→ 留个未用变量都会编译失败。

---

## 5. 关键文件路径

| 路径 | 作用 |
|---|---|
| `src/pages/MapPage.tsx` | **最大文件（约 5000 行）**：MapLibre 全部初始化、GEM/OSM 图层、弹窗、主题化、看板 |
| `src/components/AppLayout.tsx` | ⚠️ **注意在 `components/` 下，不是 `src/AppLayout.tsx`**。外壳：侧边栏 + 顶栏 + 内容区 |
| `src/components/StatsDashboard.tsx` | 数据看板（**静态原型**，数字取自 WRI 快照） |
| `src/components/WelcomeWizard.tsx` | 首次启动向导 |
| `src/components/AiQueryPanel.tsx` | AI 配置 + CSV 导出（设置页） |
| `src/components/MapQueryBox.tsx` | 地图页查询入口（提问 + 看结果） |
| `src/components/PackManager.tsx` | 数据包管理（dev 专用，生产返回 null） |
| `src/lib/llm.ts` | LLM 接入（Ollama / 云端） |
| `src/lib/nlq.ts` | 自然语言查询编排 |
| `src/lib/theme.ts` | 🆕 阶段51：主题 store（零依赖，模块级订阅表） |
| `src/lib/packs.ts` | 数据包元信息、URL 拼接、`PackKind = "region" \| "gem"` |
| `src/lib/csvExport.ts` | 🆕 阶段52：CSV 导出（dialog + fs），两处共用 |
| `src-tauri/tauri.conf.json` | 版本 / 标识 / 窗口 / CSP / asset 白名单 / `bundle.resources` |
| `src-tauri/src/lib.rs` | **手写显式迁移数组** `migrations()`（v1–v9，`include_str!`） |
| `src-tauri/src/packs.rs` | `pack_download` / `resolve_pack_resource` / `ensure_*` |
| `public/packs_manifest.json` | 数据包清单（由脚本生成，**不要手改**） |
| `scripts/` | 见 §9 命令表 |
| `docs/screenshots/` | 阶段验收截图 |

**仓库根有一个垃圾文件，建议清掉**（失控重定向产生的）：
`ntent .srclibpacks.ts  Select-Object -First 260`（本轮实测仍在，未跟踪）。

---

## 6. 严格红线（逐条，不得违反）

1. **零新增依赖（阶段52 起已有 4 项破例授权）。**
   不引入任何新的 npm / cargo 依赖，除非用户**明确授权**。

   **已有的逐阶段授权清单**：
   - `maplibre-gl` / `pmtiles`（阶段早期，地图与切片）
   - `plugin-sql` / `tauri-plugin-sql`（阶段早期，数据库）
   - `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog`（**阶段52 破例**，另存为对话框）
   - `@tauri-apps/plugin-fs` / `tauri-plugin-fs`（**阶段52 破例**，写文件到用户路径）

   ⚠️ 这些是**先例，不是「可以随便加」**。每次新增仍需单独授权。
2. **不碰 `public/osm/smoketest_power.geojson`。**
   - 实际路径：**`public/osm/smoketest_power.geojson`（560,577 B）** —— ✅ 本轮实测。
     - 🔴 **不是 `data/osm/`**：`data/osm/` 下放的是抓取/切片**中间产物**（`core_*` 等），
       没有这个文件。测试路径前先 `Get-ChildItem -Recurse -Filter` 找一次，别照抄二手说法。
     - `dist/osm/smoketest_power.geojson` 只是 `vite build` 拷贝出来的**副本**，删了会重建。
   - 它是 `MapPage.tsx` 的 `OSM_DATA_URL = "/osm/smoketest_power.geojson"` **回退数据源**。
   - 它**被 `.gitignore` 忽略**（规则 `.gitignore:47` 的 `/public/osm/`，✅ 本轮 `git check-ignore -v` 确认），
     即**未跟踪文件** → **删除后只能重跑脚本恢复**，无法从 Git 恢复。
3. **`PACKS_BASE_URL` 绝不进生产环境。** 已有双重保险（见 §7 第 3 条）。
4. **不引入 Zustand / Redux / 任何 UI 库。** 状态一律 `useState` / `useReducer` + 原生 CSS Module。
5. **图层 ID 与配色不变。** 主题化只改**明暗令牌**，不改燃料配色本身。
6. **`.pmtiles` 与 `.geojson` 源数据继续 `.gitignore`。**
   注意规则是**目录级**的 —— ✅ 本轮核实为：
   - `.gitignore:35` `/src-tauri/resources/maps/**/*.pmtiles`
   - `.gitignore:46` `/data/`
   - `.gitignore:47` `/public/osm/`
   - `.gitignore:80` `**/packs/*.pmtiles`（**必须 `**` 前缀**，否则匹配不到 `src-tauri/resources/packs/`）

   这**不是扩展名级**的规则 —— 这正是 `smoketest_power.geojson` 能留在仓库外、
   而 `public/` 下其他资产正常跟踪的原因。
7. **已应用的迁移不能删改，只能新增。**
   sqlx 会逐版本比对 checksum；并且 `ignore_missing` 默认 false，
   **从数组里删掉一个已应用的版本会直接让连接池注册失败**，
   而且失败后重试会「假成功」（失败的 `remove()` 已经把条目摘掉了）—— **极难定位**。
   要撤销已应用的改动（如删索引），只能**新增一条迁移**去做 `DROP INDEX`，
   **绝不能删迁移文件或改已应用的 SQL**。

---

## 7. 已知坑（踩过的，别再踩）

1. **Tauri `safe_file_name` 拒绝 `.db`**
   → 不要试图把 `.db` 通过 asset 协议/路径 API 暴露；数据库走 SQL 插件通道。
   另：`packs.rs` 的 `safe_file_name()` 只放行 `.pmtiles` ⇒ **数据包只能是 pmtiles**，
   想下载 `.db` 必须先松这个安全边界（不值得）。
2. **GEM `location_id` 需复合键去重**
   → 单看 `location_id` 会把不同国家/不同机组的记录误合并；
   必须与其它标识组成复合键（详见 `scripts/import_gem_plants.py`）。
   ⚠️ 三个 tracker 的 `location_id` **共用同一套 L 编号空间**，实测 628 处重号。
3. **`PACKS_BASE_URL` 被 Vite 剥离**
   → Vite 的 `resolveEnvPrefix` 只暴露 `VITE_` 前缀的变量；
   且 `src/lib/packs.ts` 里 `DEV_BASE_URL_OVERRIDE` 在 `!import.meta.env.DEV` 时直接 `return null`。
   **两层保护，别为了调试去掉任何一层。**
4. **本地 Range 测试必须用 `scripts/serve_packs.py`**
   → 普通静态服务器不返回 `206 Partial Content`，会误导「包损坏」的判断。
5. **`lib.rs` 里解释代码块必须用 ` ```text ` 而不是 ` ```rust `**，否则 cargo doctest 会失败。
6. **Vite dev 只把 webview 的 `console.warn`/`error` 转发到终端，`console.info` 不会。**
   想靠 `console.info` 观察运行时行为是看不到的 → 改成 `console.warn` 临时调试，或写进 DOM。
7. **`setPaintProperty` 的取值类型是「按属性名收窄」的。**
   把 `(id, prop, value)` 抽成一个通用小工具 → 类型宽化成「所有 paint 属性的并集」 →
   必然 `TS2345`。**只能逐条字面量调用**（阶段51 实测撞了两次）。
8. **PowerShell 5.1**：`.ps1` 无 BOM 会被当 ANSI 读 → 中文乱码/解析错误；
   `Select-String` 没有 `-Recurse`；
   `Get-ChildItem dir -Include *.js` **不加 `-Recurse` 返回空**；
   原生命令的 `NativeCommandError` 常是包装了 cargo/git 的 stderr，不是真错；
   `Get-Content json -Raw | ConvertFrom-Json` 要加 `-Encoding UTF8`，否则中文乱码导致解析失败。

---

## 8. 下一步计划（阶段 53+）

1. **数据包托管迁移** —— 评估脱离 GitHub Release（当前靠 `gh-proxy.com` 镜像）。
   ⚠️ 清单的 `directBaseUrl` 字段已**真接入代码**（阶段53，见 §3.2）——
   但那是**降级**，不是**换托管**：前者是「镜像挂了切直连」，后者是「换到 Cloudflare R2
   / 阿里云 OSS / 腾讯云 COS 等更可控的源」。两者独立，换托管仍待评估。
2. **Tauri 自动更新**（updater）。
3. **复杂 AI 空间查询** —— 多图层叠加、缓冲区、空间关系（相交/包含/邻近）。
4. **GeoJSON 导出** —— 与已实现的 CSV 导出并列，让 GIS 软件（QGIS 等）能直接读。
5. **GEM 可再生能源引入** —— 现包只有煤炭 / 油气 / 生物质三类；
   扩到全能源会显著增大体积（迁移注释里提过「扩到三类电源就会顶破 50 MB 红线」），
   需先解决分发策略。⚠️ 风/光/水/核/储**不在开放 API 里**，要走 GIPT 的填表门控，
   合规与自动化链路都要重新评估。
6. **阶段51 遗留**：11px 溢出（见 §2）、原生标题栏主题同步（见 §2）。
7. **文档债务**：README 的「已知限制」与体积表已过时（见 §11）。

---

## 9. 常用命令

### 环境准备（每个新终端都要做，node / python 都不在 PATH）

```powershell
$env:Path = "$env:LOCALAPPDATA\Programs\nodejs;" `
  + [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' `
  + [System.Environment]::GetEnvironmentVariable('Path','User')
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
```

| 工具 | 路径 |
|---|---|
| Node 20.20.2 / npm 10.8.2 | `%LOCALAPPDATA%\Programs\nodejs\`（便携版，**不在 PATH**） |
| Python 3.11.9 | `%LOCALAPPDATA%\Programs\Python\Python311\python.exe`（**不在 PATH**） |
| git | `D:\Git\cmd\git.exe` |

### 开发 / 构建

```powershell
npm run typecheck        # tsc --noEmit
npm run build            # tsc && vite build
npm run tauri dev        # 真实桌面窗口（迁移会在这里真正执行）
npm run tauri build      # 出 NSIS 安装包
```

> 阶段50–51 的验收口径：**`typecheck` 与 `build` 都要 0 退出码**，且 `tauri dev` 能起来。

### 数据链路

```powershell
node scripts/fetch_basemap.mjs        # 生成 resources/maps/basemap.pmtiles（全新克隆必跑）
node scripts/fetch_glyphs.mjs         # 生成离线中文字形（缺了不崩，会告警回退）
node scripts/gen_packs_manifest.mjs   # 重新生成 public/packs_manifest.json
python scripts/serve_packs.py         # 本地提供 Range 支持，用于验证下载/断点续传
node scripts/install_packs.mjs        # 把 data/packs/*.pmtiles 装到用户目录
python scripts/make_seed_db.py        # 重建 seed 库（从已迁移的 live DB 走 VACUUM INTO）
python scripts/import_gem_plants.py   # 抓取 GEM 三类电源 → 电站级 GeoJSON
```

### 只读复核手法（很值钱，零依赖、绕开应用本身）

```powershell
# 用 Python 内置 sqlite3 只读打开，检查迁移版本 / 表 / 行数
$py = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
#   db = %APPDATA%\com.pstar119.globalpowergis\global_power_gis.db
#   连接串用 Path(db).as_uri() + "?mode=ro"

# 用 Node 直接读清单求和（不要手算）
node -e "const p=require('./public/packs_manifest.json').packs;console.log(p.length, p.reduce((a,b)=>a+(b.features||0),0))"
```

> ⚠️ **PowerShell 里写多行 Python 别用 `& $py -c "..."`**（引号会被吞，报 `SyntaxError`）。
> 用 here-string 管道：`$code = @' ... '@; $code | & $py -`

### 全新克隆后能跑起来的最小步骤

```
npm install
node scripts/fetch_basemap.mjs     # ← 少了这步 tauri build 会失败（bundle.resources 引用它）
node scripts/fetch_glyphs.mjs      # 中文字形子集（缺了也不崩，MapLibre 告警并回退系统字体）
npm run tauri dev
```

---

## 10. 提交状态

- **阶段 50–52 的改动均已提交，全部未 push。**
- 当前 `HEAD`：`3219cef`（`feat: CSV 导出（另存为对话框，破例新增 dialog + fs 插件）`）
- `origin/master`：`dd15d2d`（`docs: 修订 README 过时内容 + 新增 PROJECT_HANDOFF.md`）
- **领先 origin 3 个提交**：
  - `3219cef` —— feat: CSV 导出
  - `42cc5a6` —— feat(map): AI 工作台改为地图上方横向条（阶段52 乙方案）
  - `e31e881` —— feat(theme): 切换主题时同步 Tauri 原生窗口标题栏
- 工作区**干净**（无未暂存、无未跟踪文件）。

### 打包注意（未变）

`target/release` 从零重建时，实时防护会偶发抢占新产物，报
`link.exe` / `icu_properties_data` 的 `拒绝访问 (os error 5)`，**原样重试一次即过**。
另：**应用还在运行会锁住 exe**，也会报同样的错 —— 先看有没有残留进程再归因。

⚠️ **新增 dialog + fs 插件后**，`cargo build` 会**首次拉取新 crate 并编译**（约 1~3 分钟）。
之后增量编译，不影响日常。

---

## 11. 文档待修正项（README 已过时之处）

以下是**本轮实测发现的、README 与代码不一致**的地方，尚未修改 README：

| # | README 的说法 | 仓库真值 |
|---|---|---|
| 1 | `README.md:283-292`、`346`：**「变电站与电厂的圆点『点不开』…… 已列入阶段40 待办」** | 🔴 **已过时** —— **阶段41 已修复**。现在统一走地图级回调 `showOsmPointOrLine()`（`MapPage.tsx:1161`），**点优先**（`HIT_BBOX_PAD=7` 扩大命中区），核心区与区域包共用同一路径，并已补上指针反馈 |
| 2 | `README.md:45` 体积表：长三角 OSM 电网切片 **4.68 MB** | 🔴 **已过期** —— 实测 `osm_grid.pmtiles` = **7.49 MiB**（核心区在阶段43 加入了铁路/管道） |
| 3 | `README.md`「当前阶段」写**阶段48-A** | 已落到**阶段51**（本文档 §2） |
| 4 | `README.md:339` 的 `430,969 / 116.52 MB` | ✅ **正确**，但必须带「电力要素」口径（见 §3.1） |
| 5 | README「数据来源与许可」未记录阶段52 破例新增的 dialog + fs 插件 | 🆕 **需补**：加一句「本项目原本零新增依赖，阶段52 为 CSV 导出的另存为对话框破例新增 2 个插件」，并说明破例经用户授权 |

> 建议在阶段52 开头一并修掉这 4 条，避免下一位接手者被第 1 条误导去「修一个已经修好的 bug」。
