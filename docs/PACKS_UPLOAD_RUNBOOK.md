# 数据包上传手册（`v1.0-packs` Release）

> 用途：把 `data/packs/*.pmtiles` 传到 GitHub Release `v1.0-packs`，让**新装用户**能下载。
> 最后更新：阶段55（2026-09-18）
> 现状：🔴 **`gem-plants.pmtiles` 从未上传**，其余 7 个区域包在。

---

## 0. 为什么需要这份手册

阶段55 体检实测：Release `v1.0-packs`（创建于 **2026-09-14**）只有 **7 个资产**：

```
osm-dongbei.pmtiles  osm-huabei.pmtiles  osm-huadong.pmtiles  osm-huanan.pmtiles
osm-huazhong.pmtiles osm-xibei.pmtiles   osm-xinan.pmtiles
```

**没有 `gem-plants.pmtiles`。** 而 `public/packs_manifest.json` 里 `kind: "gem"` 的
`downloadUrl` 指向同一个 tag（前端在运行时**由基址重拼 URL**，见 `src/lib/packs.ts`
的 `effectiveBasesOf()` / `downloadUrlOf()`），于是：

- 新装用户点「GEM Plants」→ 404；阶段53 的多源降级只是换到同样 404 的 GitHub 直连；
- **开发机上永远复现不了** —— 本机那个文件是
  `node scripts/install_packs.mjs --user-dir` **投放**进去的，不是下载来的。

`gen_packs_manifest.mjs` 只按本地文件生成指纹，**从不检查远端是否真有这个资产**，
所以这个坑不会自己暴露。⇒ 上传后必须用 §3 的脚本复核。

---

## 1. 现查一次（先确认问题还在）

```powershell
node scripts/verify_packs.mjs --remote
```

- 期望（修好后）：8 个包**全部** ✅，退出码 0；
- 修复前：`🔴 远端缺少资产 gem-plants.pmtiles`，退出码 1。

---

## 2. 上传（四条路，任选一条）

### 路线 A（**推荐**）：`node scripts/upload_packs.mjs` —— 自带「先传后删」与自校验

```powershell
# 先看计划（只发 GET，不写任何东西）
node scripts/upload_packs.mjs --dry-run

# 真上传（8 个包：7 区域 + GEM），会问一次确认；脚本化时加 --yes
node scripts/upload_packs.mjs
```

为什么它是首选（都是踩过/推演出来的坑，不是风格偏好）：

- **替换资产必须「先删后传」**（GitHub 不允许同名覆盖）⇒ 直接删旧再传新，中间任何失败
  都会让用户拿到 **404**，比"留着旧版"糟得多。本脚本改成
  **上传为 `<name>.stage` → 校验远端 `size` + `digest`(sha256) → 删旧 → PATCH 改回正式名**，
  全程**不存在**资产缺失的窗口；中途失败时正式名资产保持原样，可原样重跑。
- **上传前先拿本地文件的 sha256 与清单比对**，不一致就拒发 —— 挡住"改完数据忘了重算清单"
  （用户侧表现为 CHECKSUM_MISMATCH，极难排查）。
- 传完自动复核远端 `size` + `digest`，不拿"网页上出现了文件名"当证据。
- token 来源：`$env:GITHUB_TOKEN`，没有就回退 `git credential fill`（本机凭据管理器里那条
  带 `repo` 权限的 classic OAuth 已验证可用）。**脚本从不打印 token。**

### 路线 A'：`gh` CLI（想手工传单个文件时）

```powershell
# 一次性：安装 + 登录（浏览器授权）
winget install --id GitHub.cli
gh auth login

# 上传（--clobber 用于「传错了要覆盖」；首次上传可省略）
gh release upload v1.0-packs "data/packs/gem-plants.pmtiles" `
  --repo pstar119/global-power-gis01
```

> ⚠️ `--clobber` 同样是"先删后传" —— 33 MB 的包传到一半断了，资产就**没了**。
> 批量替换请走路线 A。

### 路线 B：网页（不想装 CLI 时）

1. 打开 `https://github.com/pstar119/global-power-gis01/releases/edit/v1.0-packs`
2. 把 `data/packs/gem-plants.pmtiles` 拖到页面下方的 **Attach binaries** 区域
3. 等上传完成（7.07 MiB）→ **Update release**

> ⚠️ 文件名必须是 **`gem-plants.pmtiles`**：清单按 `assetNameOf(pack)` 拼 URL，
> 名字不一致等于没传。
>
> ⚠️ 走网页时**不要**在 Edit 里顺手删掉别的资产 —— 该 Release 还托管着 7 个区域包。

### 路线 C：REST API 裸命令（有 PAT 时，脚本化）

```powershell
# 需要 upload 权限的 token（classic PAT 勾 repo，或 fine-grained 勾 Contents: Read and write）
$env:GITHUB_TOKEN = "<你的 PAT>"   # 不要写进任何仓库文件
$repo = "pstar119/global-power-gis01"

# 取 release id
$rel = Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN"; "User-Agent" = "gpgis" } `
  "https://api.github.com/repos/$repo/releases/tags/v1.0-packs"

# 上传（upload_url 里的 {?name,label} 要去掉）
$url = $rel.upload_url -replace '\{\?name,label\}', '?name=gem-plants.pmtiles'
Invoke-RestMethod -Method Post -Uri $url `
  -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN"; "User-Agent" = "gpgis"; "Content-Type" = "application/octet-stream" } `
  -InFile "data/packs/gem-plants.pmtiles"
```

> ⚠️ 裸命令只能**新增**；要**替换**同名资产必须先 `DELETE .../releases/assets/<id>`，
> 于是又落回"先删后传"的窗口问题 —— 替换场景请走路线 A。

### 阶段56-A3 的实测记录（2026-09-24）

用路线 A 一次性完成 **7 个区域包替换 + GEM 首传**（共 162 MB）：

- 每个资产：`.stage` 上传 → 远端 `size` 与 `digest` 与清单 sha256 逐位吻合 → 删旧 → 改名；
- 传后复核：**8/8 全部 ✅**，无 `.stage` 残留；
- `node scripts/verify_packs.mjs --remote`：**远端段 8/8 全绿**（GEM 从"不存在"变为一致）；
- **用户实际下载路径也复核过**（镜像 `gh-proxy.com`，8/8）：HEAD 200 且 `Content-Length` 等于清单
  `bytes`；`Range: bytes=0-126` → **206 + 恰好 127 字节 + `PMTiles` 魔数**
  ⇒ 断点续传在镜像上依旧可用（这是阶段46 结论在本次重传后的复验）。
- ⚠️ 该命令的**退出码仍可能非 0**，因为它同时校验**本机用户目录**里的旧包 ——
  实测本机 `%APPDATA%\...\packs\` 里 7 个区域包仍是上一版（这正是设计 §5.4 / G8 要标
  「需更新」的场景）。本机要与远端一致，用应用内的「设置 → 数据包管理 → 更新」，
  或 `node scripts/install_packs.mjs`（本地投放脚本）。

---

## 3. 上传后复核（**必做**，别只看网页上出现了文件名）

```powershell
node scripts/verify_packs.mjs --remote
```

脚本会把远端资产的**体积与 GitHub 计算的 SHA256 digest** 与清单逐项比对，
所以它同时能抓到「传错文件」和「传到一半」这两种情况。

期望值（清单里已记的指纹，阶段55 实测与本地文件一致）：

| 项 | 值 |
|---|---|
| 文件 | `gem-plants.pmtiles` |
| 字节数 | `7,414,329`（7.07 MiB） |
| SHA256 | `6dfca250fa6958aede2930162eb0483d2e44779d718b65d633068aee99b99d6` |

> ✅ 上传成功后**不需要**重新生成清单：`sha256` / `bytes` 早在生成时就写好了，
> 清单只等远端把文件补上。若指纹与本地不一致，要改的是**上传的文件**，不是清单。

---

## 4. 顺带说明：为什么清单不能自动发现这件事

`gen_packs_manifest.mjs` 的输入只有**本地文件**（`data/packs/`），它没有网络访问，
也不该有 —— 让构建依赖网络会引入新的失败面。所以「远端是否真有资产」只能靠
**独立的校验脚本**（本手册 §1/§3）或发布流程里的一次人工核对。

⇒ 这一步已经自动化到 `scripts/verify_packs.mjs --remote`。
**以后每次「改了包 / 换了托管 / 发版前」都跑一次它**，成本一次 API 调用（匿名限流 60 次/小时）。

---

## 5. 与「换托管」的关系（别混淆）

| | 现状 | 说明 |
|---|---|---|
| 多源**降级** | ✅ 已实现（阶段53） | 镜像失败自动切 `directBaseUrl` 重试一次 |
| **换托管** | ❌ 未做（阶段55+） | 从 GitHub Release 换到 R2 / OSS / COS 等更可控的源 |

两者独立：降级是「镜像挂了切直连」，而**直连这一端同样依赖 GitHub 上有这个文件**。
⇒ 无论是否换托管，`gem-plants.pmtiles` 都得有一个真实可下载的地址。
换托管的唯一配置点是 `gen_packs_manifest.mjs` 的 `DEFAULT_BASE_URL`（见该文件注释）。
