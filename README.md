# Global Power GIS

全球电力基础设施 GIS 桌面应用 —— 面向全球电力设施地理数据的浏览、统计与分析。

## 当前阶段

**阶段35 —— 第一版完整可分发离线桌面应用**（2026-09-13）

已接入的能力：

- **地图**：离线 PMTiles 底图 + 本地中文字形（无网络也能出中文地名）
- **电网数据**：长三角真实 OSM 数据（22,380 条要素），本地切为 4.68 MB PMTiles 随安装包分发
- **电厂数据**：WRI Global Power Plant Database（34,936 行，内置种子库，首次启动自动播种）
- **图层控制**：`电厂 / 变电站 / 输电线路` 三个总开关；输电线路再按 `735kV 以上 / 500-734kV /
  220-499kV / 220kV 以下 / 电压未知` 五个原生复选框细分（**「电压未知」默认关闭**）
- **当前视野统计**：地图左下角实时显示「本视野：X 座电厂 · Y 段线路 · Z 座变电站」，
  `moveend` + 200ms 防抖；z≥8 按 `osm_id` 去重（精确），z<8 因归档未保留 `osm_id` 而标注为「按源统计」
- **空间智能问答**：地图页顶部浮动查询框（AI 配置与 CSV 导出仍在设置页），
  把**当前视野 bbox + 已选图层**作为上下文下发给大模型 / 本地规则引擎，
  于是「当前视野里最大的5个电厂」会真的按视野过滤；
  视野移动后旧结果（表格 + 地图高亮）自动清空，不会留下「地图飘走了、表格还停在原处」
- **多轮对话记忆**：追问「那最大的5个水电站呢？」会继承上一轮的地理框架，只替换用户显式改写的部分。
  实测追问 SQL 仍带 `lon/lat BETWEEN ? AND ?`；对照 Python 独立复核：视野内 Hydro 计数 = 0（全库 7156 条），
  即「0 行」是地域约束生效的真值，而非数据缺失
  （本地 `qwen2.5:7b` 在追问时经常不输出 `inViewport`，因此在 LLM 路径补了一条确定性继承规则：
  指代词 + 上一轮带视野 + 本轮未换国家 → 继承上一轮视野）
- **左侧智能工作台**：地图页查询框改为可折叠工作台（折叠后只剩竖向导轨，图层面板随之归位），
  显示「对话历史（N 轮）」与每条问/AI 解析，默认最近 5 轮 + 展开更多（最多保留 20 轮）；
  新查询发起瞬间旧表格与地图高亮立即清空，不留视觉残留

![阶段33：追问继承地理约束 + 多轮对话历史](docs/screenshots/phase33-multi-turn-memory-followup.png)

![阶段33：左侧 AI 工作台折叠后只剩导轨](docs/screenshots/phase33-workbench-collapsed.png)

## 分发包（第一版完整可分发离线版）

安装包：`src-tauri/target/release/bundle/nsis/Global Power GIS_0.1.0_x64-setup.exe`

- 体积 **44.38 MB**（NSIS，中文安装界面）；SHA256 `55747905BDFDD93AC7DFDBD4B6B693B0B5DA6C7B130B9DBACEA0A7DBF68D6805`
- 裸主程序 10.77 MB；安装包比它多出 33.6 MB，正是下面三份资源的 LZMA 压缩后体积

三份关键资源随包分发（可核：`src-tauri/target/release/nsis/x64/installer.nsi` 里的 `File /a` 指令）：

| 资源 | 安装后位置 | 体积 |
|---|---|---|
| 离线底图 PMTiles | `maps\basemap.pmtiles` | 31.77 MB |
| 长三角 OSM 电网切片 | `maps\osm_grid.pmtiles` | 4.68 MB |
| 电厂数据种子库 | `seed\global_power_gis.db` | 2.98 MB |

**三项全离线**：底图与电网切片来自安装目录（本地 `asset` 协议）、电厂数据来自 SQLite 种子库
（首启播种到 `%APPDATA%\com.pstar119.globalpowergis\global_power_gis.db`）、自然语言查询走本机 Ollama。

> 设置页自检显示 `substations 0 / transmission_lines 0` **属正常**：这两张表是早期演示数据，
> 阶段29 起的真实电网数据在 PMTiles 切片里，不再入库。

### ⚠️ 生产包使用本地 Ollama 的前提（实测踩到的唯一一坑）

生产版前端源是 `http://tauri.localhost`，而 Ollama 默认只放行 `localhost / 127.0.0.1` 这类源，
于是「测试连接」会报 `Failed to fetch`。实测对照（同一个 Ollama，只换 Origin）：

| Origin | 结果 |
|---|---|
| `http://localhost:1420`（dev） | `200` + `Access-Control-Allow-Origin: http://localhost:1420` |
| `http://tauri.localhost`（生产） | **`403 已禁止`** |

放行方式（无需管理员权限，可随时改回）：

```powershell
[System.Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS',
  'http://tauri.localhost,http://localhost:*,http://127.0.0.1:*','User')
```

设完**必须重启 Ollama**（托盘图标退出后重新打开）才生效。
注意这不是本项目代码缺陷，也**不是 CSP 问题** —— 被 CSP 拦会报 `Refused to connect`。

### 安装包红线自检（在裸 exe 二进制里逐字符串搜）

| 关键字 | 结果 |
|---|---|
| `9222` | 未命中 ✅ |
| `remote-debugging` | 未命中 ✅ |
| 硬编码 API Key（`sk-*` / `Bearer *` / `api_key=`） | 源码扫描零命中 ✅ |
| `additionalBrowserArgs` | 命中，但那是 Tauri 自身给 WebView2 传 `--disable-features=…` 的字段名；本项目 `tauri.conf.json` 未配置该项 |

打包注意：`target/release` 从零重建时，实时防护会偶发抢占新产物，报
`link.exe` / `icu_properties_data` 的 `拒绝访问 (os error 5)`，**原样重试一次即过**（本阶段实测）。

取数与切片流程见 [`README_OSM.md`](./README_OSM.md)。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 前端框架 | React 19 |
| 语言 | TypeScript |
| 构建工具 | Vite 8 |
| 包管理器 | npm |

## 运行方式

### 前置要求

- **Node.js** —— `^20.19.0 || >=22.12.0`（Vite 8 的要求）
- **Rust 工具链**（Tauri 需要，含 `cargo`）
- **WebView2 Runtime**（Windows 10 / 11 通常已内置）

### 安装依赖

```bash
npm install
```

### 启动开发模式

```bash
npm run tauri dev
```

### 其他常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 只启动前端开发服务器（不含桌面外壳） |
| `npm run build` | 只构建前端产物到 `dist/` |
| `npm run tauri build` | 构建并打包桌面应用安装包 |
| `node scripts/fetch_basemap.mjs` | 生成离线底图（见下），**全新克隆后必须先跑一次** |
| `node scripts/fetch_glyphs.mjs` | 生成离线中文字形（见下），同上 |

### 离线底图（必做的前置步骤）

应用使用 Protomaps 的矢量底图（ODbL，需署名 OpenStreetMap）作为地图背景。

底图归档由脚本从公开的行星归档里**按需切出**，产物约 32 MB，属于可完整重建的派生产物，
因此**不进 Git**（见 `.gitignore`）。全新克隆后，在打包之前需要先执行：

```bash
node scripts/fetch_basemap.mjs --estimate-only   # 可选：只试算体积，不下瓦片
node scripts/fetch_basemap.mjs                   # 生成 src-tauri/resources/maps/basemap.pmtiles
```

- 默认范围：**全球 z0-z4**（全世界都有轮廓）+ **中国中东部 z5-z8**（bbox `98,18,128,46`）；
  用 `--bbox` / `--global-maxzoom` / `--region-maxzoom` / `--source` 可自行裁剪。
- 脚本依赖 `build.protomaps.com` 的 **HTTP Range** 支持：实测下载 1107 个瓦片只发了 37 次
  区间请求（合并边界 64 KB）。
- 前端通过 Tauri 的 **asset 协议**按需读取该文件（已验证返回 `206 Partial Content`）；
  实测「启动 + 拖动 + 放大」全过程只读取了 1.78 MB / 31.76 MB。
- 底图缺失时应用会正常启动，只显示纯色背景并给出提示，不会崩溃。

### 离线中文字形（必做的前置步骤）

底图地名用中文渲染，靠的是 MapLibre v6 的 **`font-faces`** 样式属性 —— 它把字体文件
交给浏览器的 CSS Font Loading API 本地绘制，**不需要任何字形（glyphs）服务器**：

- 样式中**完全不设 `glyphs`**。MapLibre 的 GlyphManager 在 glyphs 为空时会走本地绘制，
  因此一个字形请求都不会发出，真正离线。
  （顺带一提：Protomaps 官方字体资源里**没有 CJK**，其 CJK 码位区间返回的是空字形，
  所以本来也没有现成的中文字形服务器可用。）
- 字体取自 `@fontsource/noto-sans-sc`（按 unicode-range 切成 101 个子集）。
  `scripts/fetch_glyphs.mjs` 会先扫底图归档、统计 `places` 图层实际用到的码位，
  **只下载命中的子集**（实测 86 个 / 2.1 MB，全量约 4 MB）。
- `font-faces` 是**懒加载**的：只有某个字真的被画出来时才去取它所在的子集。
- 字体文件在 `public/fonts/`（已 gitignore）；生成的清单
  `src/lib/basemapFonts.generated.ts` 进 Git —— 缺字体时只会告警回退，不会崩。

### 目录结构

```
├─ index.html
├─ package.json
├─ vite.config.ts
├─ src/                     前端源码
│  ├─ App.tsx               应用入口
│  ├─ App.css               全局样式与深色主题配色令牌
│  ├─ components/           布局外壳
│  │  ├─ AppLayout.tsx      侧边栏 + 顶栏 + 内容区骨架
│  │  ├─ Sidebar.tsx        导航菜单（可折叠）
│  │  ├─ TopBar.tsx         标题栏
│  │  └─ GreetSelfCheck.tsx 前后端通信自检
│  └─ pages/                页面
│     ├─ MapPage.tsx        地图（MapLibre GL + 瓦片底图 + OSM 电力图层）
│     ├─ StatsPage.tsx      统计（真实数据：电厂数 / 总容量 / 国家 / 燃料）
│     └─ SettingsPage.tsx   系统设置（仍为禁用占位）
└─ src-tauri/               Tauri 后端
   ├─ tauri.conf.json       窗口 / 打包 / 安全配置
   ├─ capabilities/         权限声明
   ├─ icons/                应用图标
   └─ src/                  Rust 源码
```

## 已知限制

- **极少数地名仍会缺字** —— 阶段27 接入中文字形后的残留边界。
  - 现象：个别地名可能少一两个字，而不是整条标签不显示。
  - 原因：字形按需裁剪（见下方「离线中文字形」），我们只下载了
    `places` 图层实际用到的码位所命中的 86 个字体子集。
    实测 1766 个码位里有 **23 个没有任何子集覆盖**（缅甸文、泰文，以及一个
    CJK 扩展 B 区汉字），这些字无字形可用。
  - 已有缓解：标签回退链是 `name:zh-Hans → name:zh-Hant → name:en → name`，
    所以绝大多数情况会退回英文而不是显示空白。
- **变电站与电厂的圆点「点不开」** —— 目前只有**输电线路**有 `click` 处理器。
  - 现象：点击地图上的变电站 / 电厂圆点没有任何反应，光标也不会变成手型。
  - 原因：`MapPage.tsx` 里共 6 个 `click` 处理器，分别绑定 `CLUSTER`、`PLANT`（数据库）、
    `SUBSTATIONS`（数据库）、`LINES_HIT`（数据库）、`OSM_LINES_HIT`，
    外加一个地图级回调（区域包线路）；
    **`OSM_SUBSTATION_LAYER_ID` / `OSM_PLANT_LAYER_ID` 以及区域包对应的四个图层都没有处理器**。
    它们在代码里只出现在「点优先」的**抑制列表**中（避免线路弹窗盖住点要素）。
  - 连带影响：`buildSubstationPopup` 只挂在数据库的 `SUBSTATIONS_LAYER_ID` 上，
    而该表当前 **0 行**，所以这个弹窗实际上从不出现。
  - 这是**功能缺口**而非渲染故障；已列入阶段40 待办。
- **离线底图有覆盖范围**：全球 z0-z4 + 中国中东部（bbox `98,18,128,46`）z5-z8。
  该范围之外放大到 z5 以上只是把 z4 瓦片 overzoom —— 矢量放大不会糊，但细节不再增加。
- **全新克隆后必须先跑两个生成脚本才能打包**（产物都不进 Git，见下）：
  ```bash
  node scripts/fetch_basemap.mjs   # 离线底图，约 32 MB
  node scripts/fetch_glyphs.mjs    # 离线中文字形，约 2.1 MB
  ```

## 已知性能观察

地图「本视野」统计有一条 **50ms 护栏**（超过就写警告日志，并按约定停下来汇报、不硬撑）。
以下是实测记录，刻意区分**已解释**与**尚未解释**两档 —— 混在一起写会让后人误以为都查清了。

### 已解释：30~75ms 这一档

| 视野 | 区域包 | 视野统计耗时（多次采样） |
|---|---|---|
| 长三角（仅核心区） | 无 | 32.6 / **54.5** / **75.4** / 43.8 ms |
| 四川（2 个区域包） | xinan,xibei | 13.9 / 26.4 / 13.3 / 18.7 / 30.2 ms |
| 全国 z4 | 无 | 12.9 / 26.2 / 24.9 ms |

两条结论：

- **加载区域包不会让统计变慢** —— 带 2 个包的四川反而比只画核心区的长三角更快。
  （这条是有意做的对照测量：50ms 告警出现时，不能默认是自己刚改的东西引入的。）
- 30~75ms 来自长三角那份密集数据的**既有开销**，与区域包无关。
  低缩放（z1.5 启动时）单张瓦片装了约 2.5 万个要素，是这一档的主要来源。

### 尚未解释：1 秒级停顿

实测到一条 **`1015.9ms`** 的告警，比上面那一档高出一个数量级。

- 观察时的环境：本机**并发跑着 `npm run build`**（CPU/IO 争抢，可能饿死了 webview）
- ⚠️ **「最大嫌疑」不等于「已证实」**：目前没有对照测量能把它归因到任何具体机制，
  所以按**未解释**记录，不写成「与某改动无关」
- 处理决定（2026-09-14）：**现阶段不做强行优化**，留待在**真实用户电脑**上观测

复现与排查建议：机器空闲、不并发跑构建时重复上面的对照测量；若 1 秒级停顿仍出现，
再查 `queryRenderedFeatures` 在大范围低缩放下的行为 —— 现有日志已把「渲染查询」与
「SQL 往返」拆成两段计时，可直接看是哪一段慢。

## 说明

- 界面为**固定深色主题**，不跟随系统浅色模式
- **已内置真实数据**（不再是占位，阶段37–39 完成）：
  - **全球电厂 34,936 条** —— WRI Global Power Plant Database，入库于 `power_plants` 表
  - **全国 7 大区域电网数据包** —— OSM 电力要素共 **430,969 个**、合计 **116.52 MB**，
    以 PMTiles 存于 `data/packs/osm-<region>.pmtiles`（**不进 Git**），前端按需加载
- 地图支持**按需加载**与**空间查询**：
  - 按需加载：z ≥ 6 且视口覆盖到该区域时才挂载，**最多同时 2 个**包，避免内存爆掉
  - 空间查询：按国家 / 燃料筛选，可限定「**当前视野**」（bbox 条件由 `nlq.ts` 写进 SQL）；
    命中后飞行到**数据算出的** bbox 并高亮，点数超上限时只飞行、不高亮
  - 区域包**输电线路**可**点击查看属性**，属性来自瓦片，不走数据库；
    ⚠️ **变电站 / 电厂圆点目前点不开**（无 `click` 处理器），见下方「已知限制」
- ⚠️ **低缩放有刻意的降采样**（不是数据缺失）：z < 8 的瓦片按**电压等级由高到低**封顶
  **2 万要素/瓦片**，全国视角下合计省略 **140,614** 个要素；**z ≥ 8 完整保留**，放大即可见全部
- 设置项**仍为禁用占位**（`SettingsPage.tsx` 全部 `disabled`），属已知未完成项
- 应用图标为手写 SVG 生成的占位图标，后续可替换为正式品牌图标
