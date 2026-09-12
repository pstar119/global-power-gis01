# 阶段28：接入真实 OSM 电网数据（数据准备与切片手册）

本文件只讲**数据怎么来、怎么切片**。前端图层的加载与样式改造是下一步，
等数据切出来之后再动 `MapPage.tsx`。

范围：**长三角试点**（`118,29,123,33`）—— 实测该范围内有 **15,524 条** `power=line` way。
跑通链路后再用 `--bbox` 扩到别的区域，**不需要改任何代码逻辑**。

---

## 一、先看实测：本机工具链到底什么能用

阶段28 开工前把每条路都探过一遍（2026-09-12），别再重复试错：

| 路径 | 实测结果 |
|---|---|
| `download.geofabrik.de`（常规 OSM 抽取） | ❌ 8s 超时 |
| `download.bbbike.org` / `download.openstreetmap.fr` | ✅ 可达，但只给 `.osm.pbf`（需 libosmium 解析） |
| `overpass-api.de` | ✅ **可用**，`out geom;` 直接带坐标 → **本方案用它** |
| `overpass.kumi.systems` / `overpass.osm.jp` | ❌ 超时 |
| `overpass.private.coffee` | ⚠️ 可达但慢（7.5s），已作为脚本内的备用端点 |
| `github.com` release 附件下载 | ❌ 20s+ 超时（`codeload.github.com` 源码包 **✅ 通，但很慢 ~27 KB/s**） |
| `tippecanoe` / `conda` / `mamba` / `scoop` / `osmium` CLI | ❌ 本机**全部不存在** |
| Docker | ❌ 未安装；且 `hub.docker.com` **不可达**，即使装了也拉不到镜像 |
| WSL | ⚠️ 组件在，但**没有安装任何发行版**（`wsl -l -v` 只打印帮助） |
| conda-forge 的 `tippecanoe` | ✅ 有 `linux-64/osx-64/osx-arm64/linux-ppc64le/linux-aarch64`，**❌ 没有 `win-64`** |
| npm 的 `tippecanoe` 包 | ❌ 只是个壳（README 明说 "You must install Tippecanoe separately"） |
| 清华镜像 `ubuntu` / `msys2` / `anaconda` / `pypi` | ✅ 全部可达 |

**结论：Windows 原生拿不到 tippecanoe，只有 Linux 环境里有现成构建。所以走 WSL（路径 A）。**

---

## 二、第一步：抓数据（Windows 本机就能跑）

```powershell
# 只统计数量与电压分布，不落盘（先看规模）
python scripts/fetch_osm_power.py --estimate-only

# 正式抓长三角，产物落 data/osm/
python scripts/fetch_osm_power.py --preset yrd
```

脚本特性（都对着一堆坑写的）：

- **纯标准库**（urllib / json），不引入任何依赖。
- **分块抓取**：bbox 默认切成 4×4 = 16 块，每块 3 个查询（lines / substations / plants），
  块间 sleep 2 秒，失败重试 3 次并自动切换备用端点。
- **把 `remark` 一律当失败**。Overpass 出错时会返回 **HTTP 200 + `remark` 字段**
  （比如 `"runtime error: Query timed out"`），只看状态码会把失败当成功、静默丢掉整片区域。
  顺带一提：它的超时文案是 `timed out`（**带空格**），用 `"timeout" in remark` 匹配不到。
- **跨块去重**：相邻块会重复返回边界上的要素，按 `osm_id` 去重。
- **`power=line` 是按杆塔切碎的**（长三角 15,524 条），这是 OSM 的数据特征，不是 bug。
  线段首尾相接，视觉上看不出接缝，**本阶段不做合并**（合并涉及变电所边界、同塔双回方向
  连续性等拓扑问题，复杂度高且与「拿到真实数据并切片」无关）。

产物（都在 `/data/` 下，**已被 `.gitignore` 忽略**，不会污染仓库）：

```
data/osm/yrd_power_lines.geojson        1269+ 条 LineString，带 vclass / voltage_kv
data/osm/yrd_power_substations.geojson  Point，带 vclass / substation_kind
data/osm/yrd_power_plants.geojson       Point，带 plant_source
data/osm/yrd_power_meta.json            数量、电压分布、耗时
```

`vclass` 的取值就是前端要用的四档：`735+` / `500-734` / `220-499` / `<220`，外加 `unknown`
（实测长三角有约 22% 的线路没有 `voltage` 标签 —— 这是 OSM 的现实，不是解析 bug）。

---

## 三、第二步：装 tippecanoe（WSL，路径 A｜推荐）

> 需要你在**管理员 PowerShell** 里执行前两条 —— 装 WSL 发行版要 UAC 提权 + 重启，
> 这一步我代劳不了，装完后面的都能跑。

```powershell
# 1) 装 WSL 与 Ubuntu（管理员 PowerShell；完成后按要求重启）
wsl --install -d Ubuntu

# 2) 重启后进入 Ubuntu，设置用户名密码
wsl
```

Ubuntu 里换清华源并装依赖：

```bash
# 换 apt 源（清华镜像，本机实测可达）
sudo sed -i 's|http://archive.ubuntu.com|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list
sudo apt update
sudo apt install -y curl bzip2

# 装 miniconda（从清华镜像，本机实测 200）
curl -L -o /tmp/miniconda.sh https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash /tmp/miniconda.sh -b -p $HOME/miniconda
eval "$($HOME/miniconda/bin/conda shell.bash hook)"

# 把 conda 也指向清华镜像
conda config --add channels https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge
conda config --add channels https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main
conda config --set show_channel_urls yes

# 直接从 conda-forge 装 tippecanoe（linux-64 有官方构建，免编译）
conda create -y -n tiles -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge tippecanoe
conda activate tiles
tippecanoe --version     # 应输出版本号
```

> ⚠️ 别在 Windows 上 `conda install tippecanoe`：conda-forge **没有 win-64 构建**（已实测确认）。

### 路径 B（不想装 WSL 时的备选：MSYS2 源码编译）

清华有 MSYS2 镜像，且 `codeload.github.com` 实测可达（只是慢）：

```bash
# MSYS2 从清华镜像装好后，在 MSYS2 MINGW64 终端里：
pacman -S --needed base-devel mingw-w64-x86_64-toolchain mingw-w64-x86_64-sqlite3 mingw-w64-x86_64-zlib

curl -L -o /tmp/tip.tar.gz https://codeload.github.com/felt/tippecanoe/tar.gz/refs/tags/2.79.0
tar -xzf /tmp/tip.tar.gz -C /tmp
cd /tmp/tippecanoe-2.79.0 && make -j4 && make install
```

这条路会真的编译源码，遇到 MSYS2 的 POSIX 差异时需要自己趟；**能用 WSL 就别走这条**。

### 明确排除的路径（省得你再试）

- **Docker**：`hub.docker.com` 不可达，拉不到任何镜像。
- **Windows 原生 conda**：conda-forge 无 `win-64` 构建。
- **npm 的 `tippecanoe`**：只是 PATH 上已有二进制的壳。
- **GitHub Releases 二进制**：本机超时。
- **自己用 Python 写 PMTiles/MVT 写入器**：明确否决 —— 二进制格式 + Hilbert 排序手写
  风险太高，隐蔽 bug 会让地图直接不正常。

---

## 四、第三步：切片（在 WSL 里执行）

把抓好的 GeoJSON 拷进 WSL（或直接在 WSL 里访问 `/mnt/d/Projects/global-power-gis/data/osm/`）。

```bash
cd /mnt/d/Projects/global-power-gis
conda activate tiles

tippecanoe \
  --output=data/osm/osm_grid.pmtiles \
  --force \
  -L'{"file":"data/osm/yrd_power_lines.geojson","layer":"power_lines","minzoom":4,"maxzoom":14}' \
  -L'{"file":"data/osm/yrd_power_substations.geojson","layer":"power_substations","minzoom":6,"maxzoom":14}' \
  -L'{"file":"data/osm/yrd_power_plants.geojson","layer":"power_plants","minzoom":6,"maxzoom":14}' \
  -y vclass -y voltage_kv -y name -y power -y line_kind -y substation_kind -y plant_source -y osm_id \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --simplification=10 \
  --attribution='© OpenStreetMap contributors (ODbL)'
```

逐参数说明（每个都有理由，不是抄来的）：

| 参数 | 为什么 |
|---|---|
| `-L'{...}'` × 3 | **一次产出、三个图层**：前端只需要一个 source，靠 `source-layer` 区分。JSON 形式可以给每层单独的 zoom 区间 —— 变电站/电厂在低级别太密，从 z6 起才画 |
| `-y …` | 只保留前端真正要用的属性。不裁剪属性会让瓦片大不少（`osm_id` 保留着方便点选时回溯 OSM） |
| `--drop-densest-as-needed` | 低级别要素过密时自动抽稀，保证单个瓦片不超尺寸上限。**这是防止「地图白屏」的关键参数** |
| `--extend-zooms-if-still-dropping` | 抽稀还压不下去时自动再深入一级，而不是硬塞 |
| `--simplification=10` | 折线抽稀力度（默认 1 太保守）。10 在 z4 视觉上没问题，能显著减小体积 |
| `--attribution` | OSM 数据是 **ODbL**，署名是法律要求，写进归档元数据里 |
| `--force` | 允许覆盖已有产物，方便反复调参 |

### 校验产物

```bash
ls -lh data/osm/osm_grid.pmtiles

# 用官方 pmtiles 工具看头部（若 conda 里没带，可用 npx —— 本机 npm 镜像可达）
pmtiles show data/osm/osm_grid.pmtiles
```

期望看到：`tile type: mvt`、`min zoom: 4`、`max zoom: 14`、`bounds` 覆盖长三角。

---

## 五、产物放哪里（本阶段：**不打包**）

按约定，本阶段**不把 OSM 切片打进安装包**，先本地验证样式与性能。两个可选位置：

| 方案 | 位置 | dev 可用 | 安装后可用 | 是否进安装包 |
|---|---|---|---|---|
| **甲（推荐）** | `%APPDATA%\com.pstar119.globalpowergis\maps\osm_grid.pmtiles` | ✅ | ✅（用户手动放一次） | ❌ |
| 乙 | `src-tauri/resources/maps/osm_grid.pmtiles` | ✅ | ✅ | ❌（除非加进 `bundle.resources`） |

方案甲的好处是**完全不动 `bundle.resources`**，只需要把 `tauri.conf.json` 里
`assetProtocol.scope` 再加一条 `"$APPDATA/maps/**"` 即可（当前是 `["$RESOURCE/maps/**"]`）。

方案乙更省事（scope 已经覆盖 `$RESOURCE/maps/**`），但 Tauri 只会把
`bundle.resources` 里列出的文件拷到 `target/debug/`，所以 dev 下要么临时列进去、
要么手动拷一份到 `target/debug/maps/`。

**两种都不进 Git**：`/data/` 与 `/src-tauri/resources/maps/*.pmtiles` 都已在 `.gitignore` 里。

---

## 六、切完之后轮到我做什么

数据一就绪，下一步（阶段28 后半）我会：

1. `MapPage.tsx` 新增 `osm-grid` 源（复用现有的 asset 协议 + Range 机制，不再读内存）；
2. 线路按 `vclass` 分级样式：`735+` 粉紫 3px / `500-734` 橙 2px / `220-499` 蓝 1.5px /
   `<220` 灰 1px（默认关闭，否则低等级线会糊满屏）；
3. 变电站青蓝圆点，半径随电压分级；
4. 图层顺序：底图 → OSM 线路 → OSM 变电站 → 电厂 → 聚合 → 高亮 → 地名标签；
5. UI 改造：新增「输电线路电压等级」复选框列表（用 `setFilter` 切换，不重建图层），
   以及「当前视野统计」面板（电厂走 SQL bbox 查询，线路/变电站走 `querySourceFeatures` ——
   这个只能统计已加载瓦片内的要素，是「本区域」的近似，性能我会实测后回报）。

在数据落地之前，**我不会先改前端**（否则没有数据可验证，也没法判断样式是否合理）。
