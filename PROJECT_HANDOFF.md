# Global Power GIS — 项目交接文档

> 用途：开启新对话时无缝交接。**只读本文档 + 仓库现状即可恢复全部上下文。**
> 最后更新：2026-09-18（阶段 55：发布前体检 —— 发现并记录「GEM 包从未上传」，补上数据包校验脚本）
> 当前版本：**v0.2.0**

---

## 0. 交接须知（先读这段）

新对话开始时，**不要**凭本文档的数字直接改代码。本文档区分三类信息：

- ✅ **本轮已实测核实**：带出处（文件:行 / 命令输出）。
- ⚠️ **有出处但含义需注意**：项目里确有该数字，但口径容易记错（已标注）。
- ❓ **未核实**：来自口头描述或历史文档，落地前请先查证。

### 🔴 文档约定（阶段54 起执行，先看这条再看别的）

> **凡是写进本文档的数字，都要能立刻用一条命令验证；不能验证的，就别写进去。**

阶段54 体检时发现 **10 处**文档与仓库不一致，其中两条（「HEAD 是 `3219cef`、
领先 origin 3 个提交」与「本机已有 4 个数据包」）在写下后**一天内**就失效了。
结论是：**逐条改数字治不了本，要改的是「记录什么」。**

以下三类属**易失状态**，**禁止**写进正文，一律给查询命令：

| 易失状态 | 现查命令 |
|---|---|
| 当前提交 / 领先 origin 几个提交 | 见 §9「提交状态（现查）」 |
| 本机装了哪些数据包 | `node scripts/install_packs.mjs --list`（阶段54 已加 `--list`） |
| 构建产物的文件名与体积 | 见 §9「产物（现查）」 |
| 工具链绝对路径 | 见 §9 的环境自检块 |

**可以写、也值得写的**是那些**不随时间变化**的东西：口径定义、红线、已踩过的坑、
决策理由、以及**失败方案的记录**（例如「为什么不能把 v3 迁移删掉」）。
本文档 §6、§7 是全篇最有价值的部分，改动代码前务必读完。

### 依赖清单（阶段 52 破例 → 阶段 54 已收窄）

阶段 50 之前项目执行「零新增依赖」。阶段 52 为 CSV 导出的「另存为」破例引了
2 对包；**阶段 54 把其中一半收掉了**：

| 包 | 引入 | 现状 |
|---|---|---|
| `tauri-plugin-dialog`（cargo） | 阶段52 | 🟡 **保留** —— Rust 侧 `export.rs` 用它的 `DialogExt` 弹原生对话框 |
| `@tauri-apps/plugin-dialog`（npm） | 阶段52 | ✅ **已删** —— 前端不再弹对话框 |
| `@tauri-apps/plugin-fs`（npm） | 阶段52 | ✅ **已删** |
| `tauri-plugin-fs`（cargo 直接依赖） | 阶段52 | ✅ **已删**；但⚠️它仍是 `tauri-plugin-dialog` 的**传递依赖**，照样进二进制 ⇒ **不省体积** |
| `fs:write-all` 权限 | 阶段52 | ✅ **已删**（这条才是真正的收益） |

收窄的理由与「为什么不能只把写动作搬过去」的岔路说明，见
`src-tauri/src/export.rs` 头部注释（那段是本题的核心，别删）。

**⚠️ 后续若再想加依赖，仍需单独授权，不得援引阶段52 的破例为「可以随便加」的先例。**
反过来，**删依赖**（如阶段54 这次）方向是收紧，属于恢复原原则，不新增授权负担。

### 最容易记错 / 最容易过期的数字

| 数字 | 正确口径 | 性质 |
|---|---|---|
| `430,969` | **纯电力要素**（线路 / 变电站 / 电厂），**合并/切片前**口径 | ✅ 稳定（阶段56-A1 重建后逐区复核仍成立） |
| `431,031` | 同上 **+ 62 个换流站**（阶段56-A2） | ✅ 实测 = 430,969 + 62，逐位对得上 |
| `381,545` | **合并后**的 7 包要素数（阶段56-A2） | ✅ 实测 —— 几何合并把杆塔级碎线并成完整线路，**"合并前/合并后"是两个口径，别混用** |
| `154.96 MB` | 7 个区域包体积（阶段56-A2 重建，162,486,471 字节） | ⚠️ **易失**：A1 123.15 → 合并后 151.61 → A2 加字段后 154.96 |
| ~~`815,728`~~ | ~~清单全要素（含铁路 / 油气管道）~~ | 🔴 **已作废（阶段56-A1）** —— 铁路/管道整体撤销，该口径不再存在 |
| `34,936` | WRI 电厂行数（seed 库 `power_plants`） | ✅ 稳定 |
| `7.12 MB` | 长三角核心区切片体积 `osm_grid.pmtiles`（7,465,373 字节，22,233 要素） | ✅ 阶段56-A2 重建实测。⚠️ 与阶段43 含铁路管道的 5.56 MB、A1 的 7.02 MB **口径不同，不可互推** |
| ~~`4.68 MB` / `5.79 MiB`~~ | 长三角核心区切片体积（旧值） | 🔴 **已作废** —— 前者是阶段37 前的旧口径，后者从未与实测吻合（A1 实测 7.02 MB），阶段56-A2 起统一记 **7.12 MB** |
| 安装包体积 / SHA256 | — | ⚠️ **易失**：每次重建都变。**不要写进正文**，用 §10「产物（现查）」的命令现查 |

> 🔴 **口径铁律（阶段56-A2 更新）**：现在有两组**必须分清**的口径 ——
> ① **合并/切片前**的电力要素数 **`431,031`**（= A1 的 430,969 + 62 换流站）；
> ② **合并后**的 7 包要素数 **`381,545`**。
> 旧文档里的「清单全要素 `815,728`」随铁路/管道撤销而作废，**别再引用、别再并列**。

> 📌 为什么把「安装包体积」从「最容易记错的数字」里挪走：它不是**记错**，而是
> **必然过期**。阶段54 体检时本文档还写着「阶段50 记录的 46.54 MB，需重建后才有效」，
> 而 README 里同时存在 `0.1.0` 的文件名 —— 两个过期数字互相「印证」，
> 反而让人以为产物没问题。这类字段只该给命令。

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

## 2. 阶段进度

> 最新阶段（**阶段56-A2**）的详情见下方「阶段 56-A2」小节 +
> `README_OSM.md` 的「阶段56-A2」一节 + 设计文档 §8（实施记录）；
> 更早的阶段保留在此作为决策记录，**不必逐条读完**。

**阶段 56-A2：直流标签补抓 + 直交流分档 + 两个新图层**（✅ 数据与前端已完成，清单/重传属 A3）

| # | 任务 | 状态 | 实测 |
|---|---|---|---|
| 1 | `osm_ids` 上限 20→5 并让参数真正生效 | ✅ | 7 包 152.08 → 151.61 MB（**只 −0.31%**）；同源分解证明体积大头是 `length_km` 与 `osm_ids`，**不是**上限 |
| 2 | 补抓换流站 + `frequency`（新类别 `--category converters`） | ✅ | 9 作业零失败块：**70 个换流站 / 115,322 个 way 带 frequency**（`frequency=0` 1,874 条） |
| 3 | `is_dc` 三步判定 + `converter`/`cable` 图层 + 前端 | ✅ | **`is_dc=true` 线路 1,082 条**；8 个归档逐个断言「z<8 带 is_dc」**100%** |
| 4 | 重建 7 包 + 核心区并逐个跑门禁 | ✅ | 7 包 **154.96 MB**、核心区 **7.12 MB**；`verify_power_only` ×2 + `verify_pack` **8/8 全绿** |
| 5 | 清单重算 / 包指纹失效策略（G8） | ✅ | 清单已按 A2 产物重算；G8 用 `pack_status` 的 `bytes` 比对清单 ⇒ 过期包显示**「需更新」**而非「已下载」（零 Rust 改动） |
| 6 | 7 包重传 + GEM 首传 | ✅ | 2026-09-24 用 `node scripts/upload_packs.mjs` 一次传完（162 MB）：远端 8/8 与清单 `size`+`digest` 逐位吻合；`verify_packs.mjs --remote` **远端段全绿**（GEM 从 404 变为一致） |
| 7 | 重打安装包 | 🔄 | `tauri build` 进行中（核心区 7.12 MB）；完成后跑 `check_release_redlines.mjs --with-exe` |

> ⚠️ **未复测项**：图层面板 1280×800 默认态溢出 —— 本次无浏览器/CDP 通道，
> 只做了结构压缩（把"展开分级"箭头并进「输电线路」行，省 ~22px 抵消新增两个开关）。
> 复测方法与阶段54 相同（面板 `clientHeight == scrollHeight`）。
> ⚠️ 另外：G8 的「需更新」在**本机**可观察到（`%APPDATA%\...\packs\` 里 7 个区域包仍是上一版，
> `verify_packs.mjs --remote` 的本地段会报 14 项不符）—— 但那条 UI 路径需要带 Tauri 桥的运行实例，
> 本次只做到了"数值预期"（7 个需更新 + 1 个已下载），没在界面上点过。

**阶段 51：UI/UX 最终打磨与产品化定型**（✅ 已完成）

四项任务与验收结论：

| # | 任务 | 状态 | 结论 |
|---|---|---|---|
| 1 | 深色 / 浅色主题切换（纯 CSS 变量，零 UI 库） | ✅ | 新增 `src/lib/theme.ts`；`data-theme` + localStorage 双写；浅色实测生效 |
| 2 | 完善「关于」页面 | ✅ | 版本用 `getVersion()` 读取，**不写死**；许可全列 |
| 3 | 首次启动向导加「全选 / 取消全选」 | ✅ | 7 区域包走下载队列；**GEM 独立复选框**，不进 `finishBbox` |
| 4 | 1280×800 左侧看板滚动条 | ✅ 条件未成立 | 真首屏 `clientHeight 211 / scrollHeight 211` → **无滚动条**，故**未改**默认展开状态 |

### 阶段 51 遗留 / 已知不完美

1. ~~**1280×800 边界情况：图层控制溢出**~~ —— ✅ **阶段54 已修**，且**旧数字作废**：
   - 🔴 文档原记「`693 / 704` → 溢出 **11px**」**是过期的** —— 那是阶段52 把
     AI 工作台改成地图上方横向条**之前**的数。布局一变可用高度少了约 52px。
   - ✅ 阶段54 用浏览器实测（1280×800，工作台折叠，`.layerPanel` 的
     `max-height` = 641px）：

     | 状态 | clientHeight | scrollHeight | 溢出 |
     |---|---|---|---|
     | 电压分级**折叠**（改动后的默认） | 590 | 590 | **0** |
     | 电压分级展开（= 改动前的默认） | 641 | 706 | **65** |
     | 再展开「统计筛选」（15 个燃料项） | 641 | 1059 | 418 |
     | 再展开「图例」 | 641 | 1110 | 469 |

   - 修法：给「输电线路（按电压分级）」加第三层折叠（照抄 `fuelMenuOpen` 模式），
     默认折叠。**代价已如实记录**：这 5 条从「始终可见」变为需点一次 ——
     理由见 `MapPage.tsx` 中 `tierMenuOpen` 的注释。
   - **残余**：展开该层后仍溢出 65px（那 116px 是真实内容，641px 是硬上限，
     折叠只保证默认路径干净）；「统计筛选」15 项展开必然溢出，属阶段47-1
     已接受的立场。
2. ~~**原生标题栏仍是深色**~~ —— ✅ **阶段52 已修复**（`e31e881`）：
   新增 `syncNativeTheme()` 动态同步，`capabilities` 已放行
   `core:window:allow-set-theme`。
3. ~~**未提交**~~ —— ✅ **阶段52 已提交**（`e31e881` / `42cc5a6` / `3219cef`），详见 §10。

---

### 阶段 52（✅ 已完成）

**阶段 52：CSV 导出与 AI 工作台布局重构**

| # | 任务 | 状态 |
|---|---|---|
| 1 | 主题切换同步 Tauri 原生标题栏 | ✅ 已提交 e31e881 |
| 2 | AI 工作台改为地图上方横向条（乙方案） | ✅ 已提交 42cc5a6 |
| 3 | CSV 导出（另存为对话框） | ✅ 已提交 3219cef |
| 8 | 数据包多源降级（镜像失败切直连） | ✅ 已提交 59a8368（阶段53 的一并算了） |

### 阶段 53（✅ 已完成）

**阶段 53：数据包下载多源降级** —— `effectiveBasesOf()` 返回候选基址列表，
镜像失败自动切 `directBaseUrl` 重试一次；`isRetryableNetworkError()` 只对网络类错误
重试，校验失败 / 用户取消 / 文件占用**不重试**（重试只会浪费同样的时间）。

> ⚠️ 降级**不等于换托管**：它是「镜像挂了切直连」，而两者都不可达时仍然无解。
> 换托管仍待评估（见 §8）。

### 阶段 54（✅ 本阶段）

**阶段 54：修补批次** —— 全部是「修补」，不含新功能。

| # | 任务 | 状态 |
|---|---|---|
| 1 | CSV 写盘下沉 Rust，删除 `fs:write-all` 过宽权限 | ✅ |
| 2 | 修「图层控制」溢出（电压分级改可折叠，65px → 0） | ✅ |
| 3 | 修 `install_packs.mjs` 两个盲区（GEM / 用户目录） | ✅ |
| 4 | 文档治本：移除易失状态 + 修 10 处过时内容 | ✅ |
| 5 | 重新打包（0.1.0 → **0.2.0**）并量化体积 | ✅ 46.12 MiB，**比阶段50 还小 0.42 MB**，余量 3.88 MB |

**验收实测（阶段54，全部可复现）**：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm run build` | ✅ 0 退出码；产物内**无** `plugin-dialog` / `plugin-fs` / `write-all` 残留 |
| `cargo check` | ✅ 退出码 0 |
| `cargo test --lib` | ✅ 10 passed / 0 failed / 2 ignored（需外网） |
| `npm run tauri build` | ✅ 退出码 0，产出 `Global Power GIS_0.2.0_x64-setup.exe` |
| 二进制红线自检 | ✅ 4 项应未命中全部未命中；2 项**应命中**的对照项（`export_csv_file` / `tauri.localhost`）均命中 |
| 发布版启动冒烟 | ✅ 进程存活，窗口标题 `Global Power GIS`，内存 66.8 MB |
| 图层面板实测 | ✅ 默认态 `590 / 590`，溢出 0 |

**阶段 54 遗留 / 未做**：

- ⚠️ **原生「另存为」对话框的实际点击路径未验证** —— 只验证到
  「`cargo check` 通过 + 命令已注册 + 产物无 `plugin-dialog`/`plugin-fs` 残留」。
  真实对话框需要桌面窗口，请在 `npm run tauri dev` 里点一次「当前视野 → 导出」确认。
- 「统计筛选」15 项展开必然溢出，未处理（见 §2 第 1 条残余）。
- 阶段 52 遗留的**体积待评估项已消账**（本阶段实测 46.12 MiB，余量 3.88 MB）；
  **托管迁移仍未做**，见 §8 第 2 条（它是当前唯一的「外部单点故障」）。

---

### 阶段 55（✅ 本阶段）

**阶段 55：发布前体检与断点修复** —— 没有新功能，只有「把体检发现的东西修掉 + 让同类问题不再复发」。

| # | 事项 | 状态 |
|---|---|---|
| 1 | 发布前体检：把文档声称的每一项逐条复现（不抄文档） | ✅ 见下表 |
| 2 | 新增 `scripts/verify_packs.mjs` —— **本地 + 远端资产**一致性校验 | ✅ 一次调用即可发现「包没上传」 |
| 3 | 新增 `docs/PACKS_UPLOAD_RUNBOOK.md` —— 上传与复核手册（三条路） | ✅ |
| 4 | 清掉 `bundle\nsis\` 里阶段50 遗留的 `0.1.0` 安装包，并**重打 0.2.0** | ✅ 该目录现只剩当前版本；安装包已含 `lang="zh-CN"` |
| 5 | 修正「安装包红线自检」的**作用域**（原做法在 exe 里搜前端字符串，**永远搜不到**） | ✅ 新增 `scripts/check_release_redlines.mjs`（扫 dist + 对照串） |
| 6 | 🔴 **上传 `gem-plants.pmtiles` 到 `v1.0-packs`** | ⏳ **待执行**（需 GitHub 凭据，见 §8 第 1 条） |

体检实测（阶段55，可复现）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `vite build` | ✅ 退出码 0 |
| 种子库 | ✅ v1–v9 **9/9 success=1**；`power_plants` **34,936**；`gem_coal_plants` 已 DROP；三索引齐 |
| 清单求和 | ✅ 8 包 / **815,728** 全要素 / 178,588,968 B |
| 随包资源 | ✅ 底图 33,307,918 B、核心区 7,853,248 B、seed 9,437,184 B |
| `StatsDashboard` 快照 | ✅ 与库内真值一致（34,936 行 / 5,707.0 GW / 15 类） |
| 产物版本 | ✅ 三个版本号（`package.json` / `Cargo.toml` / `tauri.conf.json`）均为 0.2.0 |
| **远端数据包资产** | 🔴 **7/8 —— `gem-plants.pmtiles` 从未上传**（`verify_packs.mjs --remote` 点名） |
| 未复现项 | ⚠️ `cargo test --lib` 本次未跑（沙箱拦截 cargo，需提权）；桌面冒烟需真实窗口 |

> 📌 **本次体检最大的收获不是「哪几个数字过期」，而是一条此前没有任何检查能覆盖的链路**：
> 清单由本地文件生成（不联网），而「远端到底有没有这个文件」**从来没人问过**。
> ⇒ 这类断点**看代码发现不了**，只能真的去问一次远端。这就是第 2 项脚本的存在理由；
> 它同时是 §11.3 第 5 条的落地。

---

## 3. 已完成功能清单

### 3.1 数据层

| 数据 | 内容 | 出处 / 核实状态 |
|---|---|---|
| WRI 电厂 | **34,936 座**（seed 库 `power_plants`） | ✅ 本轮实测 `SELECT count(*)` = 34936 |
| GEM 发电设施 | **33,790 机组 → 聚合为 14,793 座电站**<br>煤炭 4,865 / 油气 6,390 / 生物质 3,538 | ✅ 脚本头部与 README/迁移注释三处一致；<br>包内 14,793 为本轮实测 |
| GEM 覆盖范围 | ⚠️ **只有三类机组级 tracker：煤炭 / 油气 / 生物质**。<br>**风 / 光 / 水 / 核 / 储不在开放 API 里** —— 它们只在需要**填表申请**的 GIPT（182,400 机组）中 | ✅ `scripts/import_gem_plants.py` 的 `TYPES` 只有三项；<br>开放 API 对 `nuclear`/`hydro`/`wind`/`solar` 逐个返回 `total=0` |
| 全国 7 区域 OSM 电网 | **阶段56-A2 重建实测**：合并后 **381,545 个 / 154.96 MB**（162,486,471 字节）<br>换流站 62 个 · `is_dc=true` 线路 1,082 条 · frequency 覆盖 27.2% | ✅ 8 个归档逐个跑 `verify_power_only` + `verify_pack` 全绿；<br>合并**前**口径为 **431,031**（= A1 的 430,969 + 62 换流站） |
| ~~同上，旧口径~~ | ~~**电力要素 430,969 个 / 123.15 MiB**（A1 重建值）~~ | ⚠️ 仍是**合并/切片前**的正确口径，但**不是**包内要素数（包内是合并后的 381,545）—— 两个口径别混用 |
| ~~同上，清单口径~~ | ~~**全要素 815,728 个 / 163.25 MiB**~~ | 🔴 **已作废（阶段56-A1）**：铁路/管道撤销后不再有"全要素"口径 |
| ~~铁路 / 油气管道~~ | ~~随区域包分发~~ | 🔴 **已撤销（阶段56-A1）**：**数据与显示一并移除**（抓取类别 → prepare 合并表 → 切片白名单 → 前端图层/面板/图例）。历史口径与实测数据保留在 `README_OSM.md` 阶段43 章节 |
| 换流站 / 直流 | 换流站 **62 个**（7 包，核心区另 4 个）；`is_dc=true` 线路 **1,082 条**；`power=cable` 单独成层 | ✅ 阶段56-A2 补抓 70 个换流站 / 115,322 个 way 带 frequency；判定三步见设计 §4.1 |
| 离线底图 | Protomaps 切出的 `basemap.pmtiles`，**33,307,918 B = 31.77 MiB**（**不进 Git**） | ✅ 本轮实测 |
| 核心区电网 | `resources/maps/osm_grid.pmtiles`，**7,465,373 B = 7.12 MB**（阶段56-A2 重建，22,233 要素），bbox `[118,27,123,33]`（长三角+浙江） | ✅ 实测（A1 为 7.02 MB、阶段43 含铁路管道为 5.56 MB —— 口径不同不可互推） |

> 📌 **口径（阶段56-A2 更新）**：包内要素用 **「合并后」381,545**；描述"抓到了多少 OSM 要素"用
> **「合并前」431,031**。旧文档并列的「全要素 / 纯电力」两套数字**已成历史**，不要再并列引用。

### 3.2 架构层

| 项 | 值 | 核实 |
|---|---|---|
| 安装包体积 | ⚠️ **易失，不写正文** —— 用 §10「产物（现查）」现查。阶段55 重打包基线：`48,355,932 B = 46.12 MiB`，裸 exe `9,938,944 B = 9.48 MiB`，余量约 3.88 MiB | ✅ 阶段55 打包实测 |
| 裸主程序 | **9,938,944 B = 9.48 MiB**（阶段50 为 9,713,664 B ⇒ dialog 插件 + `export.rs` + 阶段55 重打包，共 **+0.22 MiB**） | ✅ 阶段55 实测 |
| ⚠️ 体积归因 | 裸 exe **+0.20 MiB**，但安装包 **−0.42 MiB**（46.54 → 46.12）。**两者方向相反是正常的** —— 资源段的 LZMA 压缩率与前端 bundle 大小都会影响最终结果，**不能拿裸 exe 增量去推安装包增量** | ✅ 本轮实测 |
| 安装包内容 | **只有 3 项**：seed 库 + `basemap.pmtiles` + `osm_grid.pmtiles` | ✅ 本轮实测 `tauri.conf.json` 的 `bundle.resources` |
| 数据包数量 | **8 个**（7 区域 + 1 GEM = **170.32 MiB**），全部按需下载 | ✅ 本轮实测清单求和 |
| 数据包托管 | GitHub Release `v1.0-packs`，默认走 `gh-proxy.com` 加速镜像；`directBaseUrl` 为降级备用 —— **阶段53 起已接入代码**（见下行）<br>⚠️ **但 GEM 包从未上传到该 Release ⇒ 新装用户下载必失败**（阶段55 实测；修法见 §8 第 1 条，修好后请删掉本句） | ✅ 本轮实测 `manifest.release` + `verify_packs.mjs --remote` |
| 下载目录 | `%APPDATA%\com.pstar119.globalpowergis\packs\`（**运行时第一顺位**）<br>⚠️ 易失状态，**不写具体包数** —— 用 `node scripts/install_packs.mjs --user-dir --list` 现查 | 🔴 本文档原写「本机实测已有 4 个包」，阶段54 实测**该目录为空**；已按 §0 文档约定改为给命令 |
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
- 实现分两处（**阶段54 起写盘在 Rust**）：
  | 层 | 文件 | 职责 |
  |---|---|---|
  | 前端 | `src/lib/csvExport.ts` | 拼 CSV 字符串（BOM + RFC 4180 转义）+ 翻译错误码 |
  | Rust | `src-tauri/src/export.rs` | 弹原生「另存为」+ 写盘（**路径不经过前端**） |

- ⚠️ 依赖：只有 **cargo 侧** `tauri-plugin-dialog`。前端**不装**任何文件插件，
  `fs:write-all` 与 `dialog:allow-save` 两条权限已删（见 §0 依赖清单）。
- 🔴 `export.rs` 头部说明了「为什么不能只把写动作搬到 Rust」——
  那是本功能的**安全边界**所在，改这块前必读。

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
| `src-tauri/src/export.rs` | 🆕 阶段54：CSV 导出的「另存为 + 写盘」。**头部注释说明了权限边界，改前必读** |
| `src-tauri/capabilities/default.json` | 🆕 阶段54：删掉 `fs:write-all` / `dialog:allow-save` 后只剩 4 条权限 |
| `public/packs_manifest.json` | 数据包清单（由脚本生成，**不要手改**） |
| `scripts/verify_packs.mjs` | 🆕 阶段55：清单 vs **本地磁盘** vs **远端 Release 资产**（三方一致性；缺哪个包直接点名） |
| `scripts/check_release_redlines.mjs` | 🆕 阶段55：发布前红线自检。**前端查 `dist/`、Rust 才查 exe**（Tauri 压缩内嵌资源，搜 exe 对前端无效） |
| `docs/PACKS_UPLOAD_RUNBOOK.md` | 🆕 阶段55：数据包上传与复核手册（gh CLI / 网页 / REST 三条路） |
| `scripts/` | 见 §9 命令表 |
| `docs/screenshots/` | 阶段验收截图 |

> 📌 **仓库根曾经有一个垃圾文件**（`ntent .srclibpacks.ts  Select-Object -First 260`，
> 失控重定向产生的）。✅ **阶段54 实测确认已不存在** —— 仓库根只剩
> `.gitattributes` 与 `.gitignore` 两个文件。
> ⚠️ 顺便更正本文档此前的一句话：它写「本轮实测仍在，未跟踪」，但那次「实测」
> 已经过期。这正是 §0「文档约定」要防的那类错误 —— **别再把文件系统状态写进正文**。

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

## 8. 下一步计划（阶段 55+）

> 阶段54 是**修补批次**，第 1 条是**阶段55 体检挖出来的断点**（一次上传即可闭合），
> 第 2 条起才是**功能推进**。按「投入产出比 × 风险」排序。

1. **A3：电网数据发布**（阶段56-A3，🔴 紧随 A2）。
   数据、前端、清单、指纹策略都已完成并验证，**只剩"把产物推出去"这一步**：
   - ✅ 已做：清单重算（8 个包的新 `features`/`bytes`/`sha256`）；
     **7 包重传 + GEM 首传已完成**（`node scripts/upload_packs.mjs`，162 MB，
     每包"先传 `.stage`→校验 digest→删旧→改名"，全程无资产缺失窗口）；
     `verify_packs.mjs --remote` 远端段 8/8 全绿；
     包指纹失效策略（G8，见设计 §9.1）—— 过期包在设置页显示「需更新」+ 本机/清单字节数凭据，
     一键更新复用既有原子替换下载。
   - 🔄 进行中：重打安装包（`tauri build`）并跑 `check_release_redlines.mjs --with-exe`。
   - ⏭️ 之后可选：把本机 `%APPDATA%` 里 7 个旧包更新掉
     （应用内「设置 → 数据包管理 → 更新」，或 `node scripts/install_packs.mjs`）——
     不更新也不影响功能，但地图上看到的仍是上一版数据（且现在会被标成「需更新」）。
   - ⚠️ 本机现状：`gh` 未安装、无 `GITHUB_TOKEN`；上传脚本走的是凭据管理器里那条带 `repo`
     权限的 classic OAuth（`git credential fill`），**从不打印 token**。


2. **上传 `gem-plants.pmtiles`**（🔴 **当前唯一的功能性断点**）。
   阶段55 体检实测：Release `v1.0-packs`（建于 2026-09-14，早于阶段50 的 GEM 打包方案）
   只有 **7 个 `osm-*.pmtiles`**，**GEM 包从未上传**；而清单已给它写了 `downloadUrl`
   ⇒ **新装用户点「GEM Plants」必然下载失败**（阶段53 的多源降级只是换到同样 404 的直连）。
   - 现查：`node scripts/verify_packs.mjs --remote`（会直接点名缺哪个资产）
   - 修法：`docs/PACKS_UPLOAD_RUNBOOK.md`（gh CLI / 网页 / REST 三条路 + 上传后复核指纹）
   - ⚠️ 为什么它在「换托管」之前：这**不是**架构议题，只是**一次上传**（10 分钟）；
     不传，GEM 图层对所有新用户就是死的。
   - 🔎 为什么此前没人发现：**开发机上永远复现不了** —— 本机那个文件是
     `install_packs.mjs --user-dir` **投放**的，不是下载来的；而
     `gen_packs_manifest.mjs` 只按本地文件算指纹，**从不检查远端是否真有这个资产**。
   - ✅ **修好后请删掉本条**，并删掉 §3.2「数据包托管」那一行末尾的 ⚠️ 标注。

3. **项目 B：邻国数据扩展** —— 设计已就绪
   `docs/superpowers/specs/2026-09-24-china-neighbors-design.md`（⚠️ 该文档带"口径变更通告"，
   实施前需按纯电力口径复核一遍；A2 的补抓通道与 `is_dc` 判定可直接复用）。

2. **数据包托管迁移** —— 评估脱离 GitHub Release（当前靠 `gh-proxy.com` 镜像）。
   ⚠️ 清单的 `directBaseUrl` 字段已**真接入代码**（阶段53，见 §3.2）——
   但那是**降级**，不是**换托管**：前者是「镜像挂了切直连」，后者是「换到 Cloudflare R2
   / 阿里云 OSS / 腾讯云 COS 等更可控的源」。两者独立，换托管仍待评估。

   🔴 **为什么它值得排在功能之前**：整条分发链路是**单点依赖**一个免费第三方代理。
   SHA256 保证了**完整性**（镜像篡改会被 `CHECKSUM_MISMATCH` 拦下），但**可用性**
   完全押在它身上；且降级链的另一端是 GitHub，国内同样不可控 ⇒
   **降级在关键时刻可能降不动**。这是当前唯一的「外部单点故障」。

   ✅ **利好**：代码侧几乎不用改 —— `gen_packs_manifest.mjs` 的 `DEFAULT_BASE_URL`
   被注释明确标为「整个下载分发链路的**唯一配置点**」。迁移 = 上传 170 MB +
   改 1 个常量 + 重跑脚本。

   💡 顺带建议的小重构：把清单 `release` 从「两个字段（`baseUrl`/`directBaseUrl`）」
   升级为**候选源数组**（`bases: [{url, priority}]`）。语义更清晰，也天然支持多源。
   ⚠️ `public/packs_manifest.json` 是**脚本生成**的，**不能手改**。

3. **Tauri 自动更新**（updater）—— 与第 2 条同批做（更新清单也放同一个托管上）。
   ⚠️ **与「零新增依赖」红线冲突，需单独授权**。`installMode: currentUser` 与
   NSIS updater 兼容 ✅。
   📌 **为什么重要**：这正是阶段54 发现的「安装包还停在 0.1.0」的另一面 ——
   没有 updater，「重新打包」的收益只能靠用户手动重装兑现。

4. **GeoJSON 导出** —— 与已实现的 CSV 导出并列。
   ⚠️ **范围限制必须先想清楚**：
   - 电厂（SQLite 34,936 条）→ 可完整导出 ✅
   - **OSM 电网要素（切片里的 430,969 个）→ 导不了**：它们在 PMTiles 里，
     且 z<8 瓦片**刻意降采样**（省略 140,614 个要素），只能靠
     `queryRenderedFeatures` 拿到当前渲染的部分，**必然漏数据**
   ⇒ 建议**第一版只导电厂**（与 CSV 口径一致），UI 上写清范围。
     诚实说明限制，好过一个会漏数据的「完整导出」。

5. **复杂 AI 空间查询** —— 多图层叠加、缓冲区、空间关系（相交/包含/邻近）。
   🔴 **核心障碍**：数据是**分裂的** —— 电厂在 SQLite（可 SQL），电网在 PMTiles
   （只能 MapLibre 查）。跨两者做空间关系**没有统一查询引擎**。
   ⇒ **路径1（推荐）**：把需求**限制在 SQLite 能做的那一半**。「某电厂 50km 内的
   其他电厂」完全可在 SQL 里做：`idx_power_plants_lat_lon` 先粗筛经纬度包围盒，
   再精算 Haversine。提示词加 `bufferKm` 维度，复用现有 bbox 注入机制。
   **不需要 SpatiaLite / 任何新依赖。**
   ⇒ 路径2（引入 SpatiaLite）触发依赖红线 + 体积增长 + 迁移不可逆，**暂不建议**。

6. **GEM 可再生能源引入** —— ⚠️ **这是合规问题，不是技术问题**。
   风/光/水/核/储**不在开放 API 里**，只在需填表申请的 GIPT（182,400 机组）。
   ⇒ **第一步是读条款（能否再分发？许可是否仍是 CC BY 4.0？），不是写代码。**
   **在许可明确前，不要下载并分发。**

   🟢 **技术侧的好消息（本文档此前写错了，此处更正）**：
   旧文写「扩到三类电源就会顶破 50 MB 红线」—— 那是**阶段48 把 GEM 塞进 SQLite
   种子库**时的判断。阶段50 起 GEM 走 `packs/` 按需下载、**不进安装包**
   ⇒ **扩容不再受 50 MB 红线约束**。这个前提变化当时没被记录，是本轮体检发现的。

7. **数据看板动态化** —— `StatsDashboard.tsx` 仍是**写死的 WRI 快照**
   （带「静态原型」徽标）。索引已就绪（`idx_power_plants_fuel_cover`，阶段47 专为此加），
   成本低、用户感知强。**建议尽早做**。

8. **阶段54/55 遗留**：原生对话框的点击路径未验证（见 §2 阶段54 遗留）、
   §11.3 的剩余小项。

---

## 9. 常用命令

### 环境准备（每个新终端都要做，node / python 都不在 PATH）

🔴 **别照抄路径 —— 先查**。本文档此前写死「node 在 `%LOCALAPPDATA%\Programs\nodejs`、
python 在 `%LOCALAPPDATA%\Programs\Python\Python311`」，**阶段54 实测这台机器上两处都不存在**
（node 在 `D:\Node,js`，python 在 `C:\Python314`）。所以改成下面的探测式写法：

```powershell
# 1) 先问系统
Get-Command node,npm,python,git -ErrorAction SilentlyContinue | Select-Object Name,Source
# 2) 找不到再按候选位置逐个探（存在性一目了然）
@("D:\Node,js\node.exe","$env:LOCALAPPDATA\Programs\nodejs\node.exe",
  "C:\Python314\python.exe","$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
  "D:\Git\cmd\git.exe") |
  ForEach-Object { "{0,-6} {1}" -f (Test-Path $_), $_ }
```

探到之后，把实际路径填进这个前缀里（下面用本机 2026-09-18 实测值作示例）：

```powershell
$env:Path = "D:\Node,js;" `
  + [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' `
  + [System.Environment]::GetEnvironmentVariable('Path','User')
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
```

| 工具 | 本机实测（2026-09-18） | 备注 |
|---|---|---|
| node / npm | `D:\Node,js`（**v26.9.0**） | 便携版，**不在 PATH** |
| python | `C:\Python314\python.exe`（3.14） | **不在 PATH**；⚠️ `run_pipeline.mjs` 里另有候选逻辑 |
| git | `D:\Git\cmd\git.exe` | **不在 PATH**；⚠️ 沙箱会屏蔽 D 盘，调用需非沙箱模式 |

> ⚠️ **版本差异会咬人**：文档原写「Node 20.20.2 / npm 10.8.2、Python 3.11.9」，
> 本机已是 Node 26 / Python 3.14。若脚本行为与文档不符，**先核对版本再怀疑代码**。
>
> ⚠️ **脚本里写死解释器路径是个已存在的隐患**：`scripts/run_pipeline.mjs` 的
> `pythonPath()` 候选表只有 `%LOCALAPPDATA%\Programs\Python\Python311\python.exe`
> 一个绝对路径（其余靠 `PYTHON` 环境变量或 PATH 兜底）。本机没有那个路径时，
> 它会落到裸 `python` —— 是否能跑取决于 PATH。
> 用 `$env:PYTHON = "C:\Python314\python.exe"` 可显式指定，这是目前最稳的用法。

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
$env:PYTHON = "C:\Python314\python.exe"   # ← 先看一下 §9 顶部关于解释器路径的告警
python scripts/serve_packs.py         # 本地提供 Range 支持，用于验证下载/断点续传
node scripts/install_packs.mjs --user-dir   # 投放 8 个包到用户目录（**运行时第一顺位**）
node scripts/install_packs.mjs --list       # 只列现状；默认目标是 dev 的 target/debug/packs
node scripts/verify_packs.mjs --remote      # 清单 vs 本地 vs **远端资产**（发布前必跑；缺资产会点名）
node scripts/check_release_redlines.mjs --with-exe   # 发布前红线自检（**前端查 dist**，Rust 才查 exe）
python scripts/make_seed_db.py        # 重建 seed 库（从已迁移的 live DB 走 VACUUM INTO）
python scripts/import_gem_plants.py   # 抓取 GEM 三类电源 → 电站级 GeoJSON
```

> 阶段54 修了 `install_packs.mjs` 的两个盲区：此前它**只认 `osm-*.pmtiles`**
> （GEM 包永远投放不了），且**没有一条路径能投进用户目录**。
> 现在两类包都处理，`--user-dir` 直投 `%APPDATA%\<identifier>\packs\`；
> `--only` 也接受别名（`gem-plants` / `gem` 都行）。

### 只读复核手法（很值钱，零依赖、绕开应用本身）

```powershell
# 用 Python 内置 sqlite3 只读打开，检查迁移版本 / 表 / 行数
$py = "C:\Python314\python.exe"   # ← 换成 §9 探测到的实际路径
#   db = %APPDATA%\com.pstar119.globalpowergis\global_power_gis.db
#   连接串用 Path(db).as_uri() + "?mode=ro"
#   ⚠️ 多行脚本写进临时 .py 文件再跑，比 here-string 更省事：
#      用 create_file 写到 data/（该目录被 gitignore），跑完删掉

# 用 Node 直接读清单求和（不要手算）
node -e "const p=require('./public/packs_manifest.json').packs;console.log(p.length, p.reduce((a,b)=>a+(b.features||0),0), p.reduce((a,b)=>a+b.bytes,0))"
# 期望：8  815728  178588968
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

## 10. 提交状态（**现查，勿抄**）

‼️ 本节此前写着「HEAD 是 `3219cef`、领先 origin 3 个提交」—— **那是错的**，
实际当时已全部 push。这类信息**每做一次提交就失效**，所以按 §0 的文档约定
不再写具体值，改为给命令：

```powershell
$git = 'D:\Git\cmd\git.exe'   # git 不在 PATH；且沙箱会屏蔽 D 盘，需非沙箱模式执行
& $git log --oneline -5                      # 最近提交
& $git status --short                        # 工作区是否干净（无输出 = 干净）
& $git log --oneline origin/master..HEAD     # 领先 origin 几个提交（无输出 = 已同步）
& $git log --oneline HEAD..origin/master     # 落后多少个（无输出 = 不落后）
```

### 产物（现查）

```powershell
# 安装包文件名 / 体积 / 构建时间 —— 一眼看出产物是否落后于代码
Get-ChildItem src-tauri\target\release\bundle\nsis\*.exe |
  Select-Object Name, Length, LastWriteTime
# 裸主程序（用于横向对比体积变化）
Get-Item src-tauri\target\release\global-power-gis.exe |
  Select-Object Name, Length, LastWriteTime
```

> 🔎 **判断产物是否落后，只看一个信号**：产物 `LastWriteTime` 是否**晚于**
> 最后一次提交的时间。阶段54 体检时就是这个信号暴露了「安装包还停在 v0.1.0」
> —— 三个版本号（`package.json` / `Cargo.toml` / `tauri.conf.json`）都是 0.2.0，
> 只有产物是旧的。

### 打包注意（未变）

`target/release` 从零重建时，实时防护会偶发抢占新产物，报
`link.exe` / `icu_properties_data` 的 `拒绝访问 (os error 5)`，**原样重试一次即过**。
另：**应用还在运行会锁住 exe**，也会报同样的错 —— 先看有没有残留进程再归因。

⚠️ **新增依赖后**，`cargo build` 会**首次拉取新 crate 并编译**（约 1~3 分钟）。
之后增量编译，不影响日常。阶段54 删掉 `tauri-plugin-fs` 的直接依赖**不会**让编译更快
—— 它仍是 `tauri-plugin-dialog` 的传递依赖，照样要编译。

---

## 11. 文档卫生（阶段54 已清理，此处留档防复发）

### 11.1 阶段54 修掉的 10 处不一致

| # | 位置 | 原说法 | 真值 |
|---|---|---|---|
| 1 | `README` 当前阶段 | 阶段52「进行中」 | 实际已到阶段53/54 |
| 2 | `README` 说明区 | 「界面为**固定深色主题**」 | 🔴 阶段51 已实现浅色切换 |
| 3 | `README` 说明区 | 「设置项**全部** `disabled`」 | 仅 3 组静态占位；主题/数据包/关于/AI 已生效 |
| 4 | `README` 依赖表 | dialog + fs 两个插件 | 前端那一半已删（见 §0） |
| 5 | `README` 体积表 | 长三角 `4.68 MB` | `7.49 MiB`（正文已改，此处核对一致） |
| 6 | 本文档 §10 | HEAD `3219cef`、**领先 origin 3 个提交** | 🔴 **已全部 push，0 领先** |
| 7 | 本文档 §3.2 | 本机已有 **4 个数据包** | packs 目录**为空** |
| 8 | 本文档 §5 | 仓库根有垃圾文件「本轮实测仍在」 | 已不存在 |
| 9 | 本文档 §9 | node/python 绝对路径 | 🔴 两处路径在本机**都不存在** |
| 10 | 本文档 §2 | 图层控制溢出 **11px** | 🔴 实测 **65px**（阶段52 布局改动后失效） |

### 11.2 数字过期的**三类成因**（比逐条改更重要）

| 成因 | 例子 | 对策 |
|---|---|---|
| **易失状态**被写进正文 | HEAD 哈希、领先几个提交、本机装了几个包 | §0 文档约定：禁止写，改给命令 |
| **布局/实现改动**让旧测量失效 | 11px → 65px（AI 工作台改横向条） | 数字旁**必须带测量条件**（窗口尺寸、面板状态、`max-height`） |
| **环境差异** | node/python 路径、版本号 | 给探测命令，不给固定值 |

### 11.3 仍值得跟进的小项（非缺陷；阶段55 后剩余）

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~`scripts/run_pipeline.mjs:158` 写死 `Python311` 绝对路径~~ | ✅ **阶段54 已修** —— 改为「`$env:PYTHON` 优先 → 扫 `Python3*` 常见目录 → 裸 `python`」三级，并打印实际用到的解释器。实测本机自动探测到 `C:\Python314\python.exe`（旧代码会静默落到裸 `python` 而失败） |
| 2 | `index.html` 的 `data-theme` 由 JS 设置，无内联引导脚本 | 浅色用户启动理论上会闪一帧深色背景。**先观察再改** —— Tauri 本地资源加载极快、此时 `#root` 为空，大概率不可感知 |
| 3 | ~~`index.html` 的 `<html lang="en">` 而界面全中文~~ | ✅ **阶段54 已改为 `zh-CN`**（无障碍正确性，非外观问题）。⚠️ 阶段54 打出的安装包里**仍是旧值**（产物比该提交早 2.5 分钟），阶段55 重打包后已对齐 |
| 4 | `index.html` favicon 指向 `public/vite.svg` | Vite 默认残留，与 README「图标为占位」说法一致，等正式图标时一并换 |
| 5 | ~~数据包本地校验尚无脚本~~ | ✅ **阶段55 已做** —— `scripts/verify_packs.mjs`：本地（字节数 + SHA256）+ **远端 Release 资产**一次校验。命名与原建议（`verify_packs_local.mjs`）有出入：它同时覆盖远端，而「远端缺资产」正是阶段55 抓到的那个真问题，只查本地就发现不了 |
| 6 | ~~`bundle\nsis\` 里同时留着旧的 `0.1.0` 安装包~~ | 🟡 **阶段55 已清理旧包，但成因未修**：NSIS 新包是**追加**而非替换，下次重打包后仍要人工确认一次。建议后续在打包脚本里加一步清旧包 |
| 7 | 前端**零自动化测试** | `package.json` 无 test 脚本、无 vitest/jest 依赖、`src/` 下 0 个测试文件；Rust 侧有 10 个单测。UI 行为目前全靠人肉 + 截图验收 |
| 8 | 安装包是**同版本号覆盖式重打** | 阶段55 重打了 `0.2.0`：文件名不变、内容变了。分发时无法靠文件名区分「阶段54 的 0.2.0」与「阶段55 的 0.2.0」。下次重打包建议升 patch 版本（`0.2.1`），三处版本号需同步 |
| 9 | ~~「安装包红线自检」在 exe 里搜前端字符串~~ | ✅ **阶段55 已改** —— Tauri 在 release 里把前端资源 **Brotli 压缩**后嵌入，所以 bundle 里的字符串**在 exe 里永远搜不到**（污染了也「未命中」）⇒ 那条检查给的是**假绿灯**；同时 exe 里能搜到的 `lang="en"` 是 **Brotli 静态字典**的假阳性。现改为 `scripts/check_release_redlines.mjs`：**前端查 `dist/`，Rust 才查 exe**，且带对照串 |

> 📌 第 5、6 条是**防 P0 类问题复发**的那两条：阶段54 的体检就是靠手工比对
> 才发现「本机一个包都没有」与「安装包还停在 0.1.0」。自动化后，
> 这两类问题在打包前就能暴露，不必靠下一次人肉体检。
>
> 📌 阶段55 又证明了一次同一件事，但方向不同：**这两个检查都只看本地**，
> 所以它们**永远发现不了**「清单说得对、远端却没有这个文件」。
> ⇒ 教训不是「再加一个检查」，而是**检查的作用域要和风险的作用域对齐**：
> 风险在远端，就必须真的去问一次远端（`verify_packs.mjs --remote`）。
