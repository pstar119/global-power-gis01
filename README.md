# Global Power GIS

全球电力基础设施 GIS 桌面应用 —— 面向全球电力设施地理数据的浏览、统计与分析。

## 当前阶段

**前端 UI 骨架（尚未接入任何真实数据）**

三个页面（地图 / 统计 / 设置）的界面与基础交互已完成，但以下能力**均未接入**：

- 地图引擎与瓦片数据（规划：MapLibre GL JS + PMTiles）
- 任何数据源（本地离线数据库 / 在线 API）
- AI 模型
- 真实电力设施数据 —— 统计页全部数值为 `0`

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

## 目录结构

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
│     ├─ MapPage.tsx        地图（纯 CSS 模拟底图）
│     ├─ StatsPage.tsx      统计（数值全部为 0）
│     └─ SettingsPage.tsx   系统设置（全部为禁用占位）
└─ src-tauri/               Tauri 后端
   ├─ tauri.conf.json       窗口 / 打包 / 安全配置
   ├─ capabilities/         权限声明
   ├─ icons/                应用图标
   └─ src/                  Rust 源码
```

## 已知限制

- **底图没有文字标注（无地名）** —— 阶段26 的已知妥协。
  - 现象：矢量底图只渲染陆地 / 水域 / 道路 / 边界，**看不出任何地名**。
  - 原因：文字渲染必须依赖 `glyphs` 字形服务器，而本项目样式是**全离线内联**的，
    没有字体源；MapLibre 的 `symbol` 图层在缺 `glyphs` 时 `text-field` 根本渲染不出来。
  - 数据侧其实是够的：底图归档的 `places` 图层**自带 `name:zh-Hans` / `name:zh-Hant`
    （中文地名）**，所以「恢复中文标签」在数据上可行，缺的只是字形包。
  - 代价：需要额外打包 CJK 字形范围（体积代价较大，具体数值待实测），
    阶段26 为控制体积**暂不引入**，地图上的文字信息目前由聚合数字的 HTML 标记承担。
  - 现状：**恢复中文标签是下一阶段（阶段27）的目标。**
- **离线底图有覆盖范围**：全球 z0-z4 + 中国中东部（bbox `98,18,128,46`）z5-z8。
  该范围之外放大到 z5 以上只是把 z4 瓦片 overzoom —— 矢量放大不会糊，但细节不再增加。
- **全新克隆后必须先跑一次 `node scripts/fetch_basemap.mjs` 才能打包**，
  因为底图归档不进 Git（见上方「离线底图」）。

## 说明

- 界面为**固定深色主题**，不跟随系统浅色模式
- 当前不含任何真实数据，统计数值均为 `0`，设置项均为禁用占位
- 应用图标为手写 SVG 生成的占位图标，后续可替换为正式品牌图标
