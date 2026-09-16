# 本地测试环境搭建指南（数据包下载链路 / 离线验证）

> 阶段49。面向「**正式 .exe + 本地 HTTP 服务器**」的完整下载链路实测。
> 所有命令均在项目根目录 `D:\Projects\global-power-gis` 下执行。

---

## 🔴 先读这一节：两条会让测试白做的墙

### 墙一：对正式 `.exe` 设置 `PACKS_BASE_URL` 环境变量**完全无效**

这是**故意的安全设计**，不是 bug。阶段46 实测过一个会让分发**静默全灭**的坑：

> `vite.config.ts` 的 `envPrefix` 里有 `PACKS_`，而 Vite 会把**构建时 shell 环境**里
> 匹配前缀的变量原样内联进产物；前端覆盖值的优先级又**高于**清单。
> 于是「本地联调完、shell 里还留着 `PACKS_BASE_URL=http://127.0.0.1:8099`，直接
> `tauri build` 发版」→ **localhost 被写进安装包 → 所有用户下载 100% 失败**，
> 而且代码正常、清单正常、**完全静默**。

现在有两层防护，所以运行时覆盖在**生产构建里恒为空**：

| 层 | 位置 | 作用 |
|---|---|---|
| 1 | `vite.config.ts` 的 `resolveEnvPrefix()` | build 侧只暴露 `VITE_` 前缀 → `PACKS_BASE_URL` **连内联都进不去** |
| 2 | `src/lib/packs.ts` 的 `DEV_BASE_URL_OVERRIDE` | `if (!import.meta.env.DEV) return null` → 生产环境恒定回落到清单 |

**⇒ 在 `.exe` 上设这个环境变量，应用仍然会去读清单里烧死的地址（当前是国内加速镜像）。**

### 墙二：下载基址必须「烧进清单」，再重新打包

清单（`public/packs_manifest.json`）是**运行时唯一真相源** —— 它会被打进安装包。
所以要改下载地址，只能在**构建前**改，然后重新 `tauri build`。

---

## A. 启动本地数据包服务器

数据包在 `data/packs/`（已 gitignore）。有两个选择：

### ✅ 推荐：`scripts/serve_packs.py`（支持 Range）

```powershell
python scripts/serve_packs.py
# 默认：端口 8099，目录 data/packs，限速 4096 KB/s
```

它实现 `206 Partial Content` + `Content-Range`，**能让「取消 → 续传」这条路径被真实验证**。
限速是刻意的：163 MB 在 localhost 上一瞬间传完，进度条一闪而过，既截不到图也看不清状态机。

自检（另开一个终端）：

```powershell
curl.exe -s -o NUL -w "%{http_code} %{size_download}" -r 0-126 http://127.0.0.1:8099/osm-huadong.pmtiles
# 期望：206 127      ← 若得到 200 加一个很大的数字，说明 Range 没生效
```

### ⚠️ 备选：`python -m http.server 8080`

```powershell
cd data/packs
python -m http.server 8080 --bind 127.0.0.1
```

**实测它不支持 HTTP Range**（2026-09-16，Python 3.11.9）：

```
HEAD /osm-huadong.pmtiles   → 200，**无 Accept-Ranges 头**
Range: bytes=0-126          → **200 + 完整 30,322,201 字节**
```

后果分两种：

| 场景 | 能否测 |
|---|---|
| 全新下载 + SHA256 校验 | ✅ 能。`packs.rs` 收到 200 会判定「服务器忽略 Range」，作废 `.part` 并**从头重下**，文件最终正确 |
| 取消 → 续传 | ❌ **测不了**。每次都会重头下，续传代码路径根本走不到，真实的续传 bug 会"看起来不存在" |

---

## B. 生成指向本地服务器的清单

```powershell
# 1) 先备份（测完要逐字节还原，别靠记忆）
Copy-Item public\packs_manifest.json data\_manifest_backup.json -Force

# 2) 用本地基址重新生成清单
$env:PACKS_BASE_URL = "http://127.0.0.1:8099"
node scripts/gen_packs_manifest.mjs
```

成功时你会看到一段**醒目告警**（这是刻意设计的，看到它说明确实生效了）：

```
========================================================================
🔴 这是一份**本地测试专用**清单：下载基址指向回环地址
   http://127.0.0.1:8099
   它**绝不能**进入发布包 —— 否则所有用户都下载不到任何数据包。
========================================================================
```

**关于 `http://` 的说明**：清单生成脚本有一条 URL 形状自检，原本硬性要求 `https://`，
导致本地测试**根本无法生成清单**（实测 `exit 1`）。阶段49 已放宽为
**仅 127.0.0.1 / localhost / [::1] 可用 http**，真实域名仍然必须 https：

```powershell
$env:PACKS_BASE_URL = "http://evil.example.com/packs"
node scripts/gen_packs_manifest.mjs
# ❌ 下载地址自检失败：必须是 https（仅 127.0.0.1/localhost/[::1] 可用 http）   ← 退出码 1
```

---

## C. 构建并**核验**安装包

```powershell
Remove-Item Env:\PACKS_BASE_URL -ErrorAction SilentlyContinue   # 别让它影响构建期
npm run tauri build
```

### 🔴 核验一：清单里烧的确实是本地地址

```powershell
(Get-Content dist\packs_manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).release.baseUrl
# 期望：http://127.0.0.1:8099
```

### 🔴 核验二：产物里没有调试钩子，且没有意外的 localhost

```powershell
$enc = [System.Text.Encoding]::GetEncoding(28591)   # Latin1；PS 5.1 没有 ::Latin1
$exe = "src-tauri\target\release\global-power-gis.exe"
$t = [System.IO.File]::ReadAllText((Resolve-Path $exe).Path, $enc)
"文件大小 $([math]::Round($t.Length/1MB,2)) MB"       # 必须非 0，否则下面的 0 次不可信
foreach ($k in @("PACKS_BASE_URL","remote-debugging","9222","--remote-debugging-port")) {
  $n = 0; $i = 0
  while (($i = $t.IndexOf($k, $i, [System.StringComparison]::Ordinal)) -ge 0) { $n++; $i += $k.Length }
  "{0,-24} : {1}" -f $k, $n
}
```

⚠️ **务必配合阳性对照**，否则"0 次"可能是"根本没扫"：

```powershell
# gh-proxy.com 在清单里必然存在，用来证明扫描方法真的能发现匹配
$m = [System.IO.File]::ReadAllText("dist\packs_manifest.json", $enc)
($m.Length, ($m.Split("gh-proxy.com").Count - 1))   # 第二项应 > 0
```

> 这个坑我实际踩过：`[System.Text.Encoding]::Latin1` 在 PowerShell 5.1 上不存在，
> `ReadAllText` 抛异常后文本为 null，`IndexOf` 一路报错但计数器停在 0 ——
> **看起来像"0 次命中"，其实根本没扫描**。

---

## D. 安装并测试

1. 卸载旧版：设置 → 应用 → 卸载 `Global Power GIS`
2. 安装：`src-tauri\target\release\bundle\nsis\Global Power GIS_0.1.0_x64-setup.exe`
3. 确认服务器在跑（步骤 A）
4. 启动应用 → 应弹出**首次启动向导**（因为数据包目录为空）
5. 勾选「华东」→ 开始下载 → 观察进度

### 独立核验 SHA256（不要只信界面说"已下载"）

```powershell
$dir = "$env:APPDATA\com.pstar119.globalpowergis\packs"
Get-ChildItem $dir -File | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,2)}}
(Get-FileHash "$dir\osm-huadong.pmtiles" -Algorithm SHA256).Hash
```

把得到的哈希与清单里同名包的 `sha256` 比对（大小写不敏感）：

```powershell
(Get-Content dist\packs_manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).packs |
  Where-Object { $_.file -like "*huadong*" } | Select-Object file, sha256
```

一致 = 下载完整且未被篡改（Rust 侧下载完也会自己校验一次，这里是**独立复核**）。

### 验证数据包真的加载到地图上

- 左侧「图层控制」→ 勾选对应的区域包后，地图上应出现**彩色的输电线路与变电站**
  （下载完成的事件会自动挂载图层，不需要重启）
- 「当前视野」面板会随视野变化刷新线路段 / 变电站计数
- 若地图仍是空的：先看设置页「数据包管理」是否显示「已下载」，
  再确认文件确实落在上面那个 `packs` 目录里

---

## E. 离线验证（拔网线）

1. 确认下载已完成、校验已通过、地图已能渲染
2. **拔网线 / 关 Wi-Fi**
3. 逐项检查：
   - 地图底图仍可平移缩放（底图是安装目录里的本地 PMTiles）
   - 中文地名仍正常（字形是本地打包的，不走网络）
   - 区域包的电网图层仍可开关、仍能渲染
   - AI 查询：若用本机 **Ollama** 应正常；若用云端大模型（DeepSeek/Qwen/GLM）**会失败 —— 那是预期的**
4. 反向验证：**此时点下载应该报错**（而不是假装成功）—— 失败必须是**响亮的**

---

## F. 🔴 测完必须还原（最容易忘、后果最严重的一步）

```powershell
Copy-Item data\_manifest_backup.json public\packs_manifest.json -Force
(Get-FileHash public\packs_manifest.json -Algorithm SHA256).Hash
# 应与你备份时一致；也可直接：git checkout -- public/packs_manifest.json
git status --porcelain    # 应为空
```

然后**重新跑一次 `npm run tauri build`** 生成正式安装包 —— 否则你手上那个 .exe 里
烧的是 `127.0.0.1`，发给任何人都是 100% 下载失败。

**判断发布包是否干净的最终依据**（不是靠记忆）：

```powershell
(Get-Content dist\packs_manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).release.baseUrl
# 必须是 https://gh-proxy.com/https://github.com/... —— 不能出现 127.0.0.1
```
