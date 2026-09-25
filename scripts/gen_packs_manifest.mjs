/**
 * 阶段39：生成区域数据包清单 `public/packs_manifest.json`。
 *
 * 为什么需要清单：前端要知道「有哪些区域包、各自的 bbox 是什么」，才能按视口决定加载谁。
 * 清单必须**进仓库**（体积只有几 KB），因为它是构建产物的一部分，而不是可选数据：
 * 用户只装了安装包时，清单依然要在，前端才知道「本机没有装区域包」而不是「这个功能不存在」。
 *
 * 产物**只描述元信息**（key / label / bbox / 文件名 / 要素数 / 体积），不描述「本机是否已安装」——
 * 那是运行时要靠 127 字节 Range 探测才能知道的事（见 MapPage 的 ensurePmtilesArchive）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REGIONS, gridFor } from "./pipeline_regions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(ROOT, "data", "packs", "pipeline_report.json");
const OUT = join(ROOT, "public", "packs_manifest.json");

/**
 * 核心区覆盖矩形（**已交付、随安装包分发**的那个归档 osm_grid.pmtiles）。
 *
 * 数值来源（实测，非估算）：data/osm/yrd_power_meta.json 的 bbox = 118,29,123,33；
 * data/osm/zhejiang_power_meta.json 的 bbox = 118,27,123,31.3；两者并集 = 118,27,123,33。
 *
 * ⚠️ 不要拿归档 header 里的 bounds 当覆盖范围：那是**数据实际几何的包围盒**
 *    （105.258,22.696 → 122.701,44.241），因为 Overpass 对跨界的 way 会返回完整几何，
 *    所以它比真实覆盖大得多。用它判断「视口是否在核心区内」会把整个华东都误判进去。
 */
const CORE_BBOX = [118.0, 27.0, 123.0, 33.0];

/**
 * 阶段46：数据包下载基址 —— **整个下载分发链路的唯一配置点**。
 *
 * ‼️ 当前值 = 国内加速镜像。原因：GitHub Release 的直连地址在国内经常极慢或不可达，
 *    而 7 个数据包合计约 163 MB，直连基本完不成。
 *    `gh-proxy.com` 的用法是「把完整 GitHub URL 当作路径拼在后面」，
 *    所以镜像形式的基址**自身就含 `https://github.com/...` 这一整段**（不是多余，别删）。
 *
 * ── 换托管的**唯一一处**就是下面这个常量，改完重跑：
 *      node scripts/gen_packs_manifest.mjs
 *    三种形态参考：
 *      ① 国内镜像（当前）: "https://gh-proxy.com/https://github.com/.../v1.0-packs"
 *      ② 直连 GitHub     : "https://github.com/pstar119/global-power-gis01/releases/download/v1.0-packs"
 *      ③ 阿里云 OSS      : "https://<bucket>.oss-cn-hangzhou.aliyuncs.com/packs"
 *    OSS 是**直连**（不是前缀代理），所以写它的 bucket/目录前缀即可，
 *    其余一切（清单字段、前端拼接、Rust 下载校验）都不用动。
 *
 * ✅ 实测（2026-09-15，拿公开的 ripgrep Release 资产验证镜像行为）：
 *    · 镜像 HEAD → **200**（可达）
 *    · 镜像 + `Range: bytes=0-126` → **206，恰好返回 127 字节**
 *      —— 这条最关键：镜像保留了 HTTP Range，我们的**断点续传/续传不会被它破坏**。
 *    · 直连 GitHub HEAD → 302（正常跳 CDN，但国内速度不可控）
 *
 * ⚠️ 代价与风险（必须知情，不能当没看见）：
 *    第三方代理是**额外的信任链一环**。这里之所以可以接受，是因为完整性**不依赖它** ——
 *    `packs.rs` 下载完会逐字节比对清单里的 SHA256，镜像若篡改内容会直接
 *    CHECKSUM_MISMATCH 失败，而不会被静默接受。但镜像随时可能失效或限速，
 *    所以下面保留了环境变量覆盖（也方便本地测试）：
 *      $env:PACKS_BASE_URL="http://127.0.0.1:8099"; node scripts/gen_packs_manifest.mjs
 *
 * ⚠️ 实测（2026-09-15）：GitHub Release 资产**不发 CORS 头**，所以下载只能由
 *    Rust 侧完成（见 src-tauri/src/packs.rs），前端 fetch 物理上读不到。
 */
const DEFAULT_BASE_URL =
  "https://gh-proxy.com/https://github.com/pstar119/global-power-gis01/releases/download/v1.0-packs";
const BASE_URL = (process.env.PACKS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

/**
 * 阶段48：**预留字段**。目前**没有任何代码读取它**（用户拍板的 YAGNI 决定：
 * “自动降级逻辑先不做，只预留 directBaseUrl 字段”）。
 *
 * 写进清单的意义是把「镜像挂了该退到哪」这个**事实**固化成数据，
 * 而不是逼后来的实现者去猜或重查一遍。真要做降级时，
 * `packs.rs` 只需在镜像失败后用这个基址重试一次，清单无需再改。
 *
 * 注意它恒为 GitHub 直连地址，**不受 PACKS_BASE_URL 影响** ——
 * 否则本地联调会把预留值也写成 127.0.0.1，预留就失去意义了。
 */
const DIRECT_BASE_URL =
  "https://github.com/pstar119/global-power-gis01/releases/download/v1.0-packs";

/**
 * 上一个清单里已经记过的**无法从本地重算**的字段。
 *
 * ‼️ 为什么必须有兜底（真实风险，不是假想）：
 *    `data/packs/` 被 .gitignore 忽略（.gitignore:39 `/data/`），所以
 *    **全新克隆的仓库里一个包都没有**。而 `fingerprint()` 在文件缺失时返回 null，
 *    于是一个 `sha256` 与 `downloadUrl` 都会被写成 null ——
 *    前端拿不到校验和就**无法下载任何包**，而这一步**不会报错**，只会静默生成一份废清单。
 *    而「改托管地址」恰恰是最常见的一次重新生成（改一行 + 重跑）。
 *    ⇒ 缺包时沿用旧值并**大声警告**，让「改地址」不会顺手把指纹抹掉。
 *
 * ⚠️ 沿用旧值的代价：若包真的被重新生成过，指纹会**过时**。
 *    所以只要沿用了一次就一定会打印警告，提醒核对。
 */

/** 本地包的 sha256 与字节数。清单里必须带上 —— 下载完成后要拿它校验。 */
function fingerprint(filePath) {
  if (!existsSync(filePath)) return { sha256: null, bytes: null };
  const buf = readFileSync(filePath);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const report = readJson(REPORT);
  /** 上一次生成的清单（用于本机缺包时沿用指纹，见 CARRY_FIELDS 的说明） */
  const previous = readJson(OUT);
  /** 沿用了旧指纹的包，用于最后统一告警 */
  const carried = [];

  /**
   * ---- 区域包（kind="region"）----
   * ‼️ 阶段50-B：这里只装**区域包**。thematic / global overlay（GEM）走下面的
   *    独立分支，绝不混进本数组 —— 两类包的挂载生命周期不同（见 MapPage 的
   *    `isThematicOverlay`），混在一起会让下游分不清该用哪套逻辑。
   */
  const regionPacks = REGIONS.map((r) => {
    const rec = report?.regions?.[r.key];
    const { cols, rows } = gridFor(r);
    const assetName = `osm-${r.key}.pmtiles`;
    const local = fingerprint(join(ROOT, "data", "packs", assetName));

    // 本机没有这个包（全新克隆必然如此）→ 沿用上一次清单里的值，而不是写 null
    const old = previous?.packs?.find((p) => p.key === r.key);
    const reuse = local.bytes === null && old?.sha256 ? old : null;
    if (reuse) carried.push(r.key);

    const sha256 = reuse ? reuse.sha256 : local.sha256;
    const bytes = reuse ? reuse.bytes : local.bytes;

    return {
      key: r.key,
      // 阶段50-B：显式写出品类，让清单自描述。缺省也能被下游当作 region 处理，
      // 但显式写出来才能让人一眼看出这两类包是同级的、不是“一个特例”。
      kind: "region",
      label: r.label,
      provinces: r.provinces,
      bbox: r.bbox,
      file: `packs/${assetName}`,
      chunks: cols * rows,
      // 以下三项来自流水线报表；没有报表时沿用旧值，再没有才是 null
      // （前端不依赖它们，仅用于提示文案）
      features:
        rec?.stages?.build?.features ??
        rec?.stages?.prepare?.featureCount ??
        reuse?.features ??
        null,
      sizeMb: rec?.stages?.build?.packSizeMb ?? reuse?.sizeMb ?? null,
      maxTileKb: rec?.stages?.build?.widest?.rawKb ?? reuse?.maxTileKb ?? null,
      // 阶段46：下载所需。本机没有该包**且清单里也从没记过**时为 null（不影响其它包）。
      downloadUrl: bytes === null ? null : `${BASE_URL}/${assetName}`,
      sha256,
      bytes,
    };
  });

  /**
   * 拼接结果自检。
   * ‼️ 「基址 + / + 文件名」这种拼接很容易错（多斜杠、少斜杠、镜像前缀把路径吃掉），
   *    而且**错的时候不会报错**，只会生成一堆 404 链接 —— 用户要点下载才发现。
   *    所以这里在生成阶段就对形状做一次硬校验，不过就直接退出、不写文件。
   *
   * ⚠️ 校验要精确到「拼接处」那一个字符，不能用“URL 里不能出现 //”这种糙判据：
   *    镜像形式的基址**本身就含** `https://`（即 `//`），那样会误报。
   */
  const sample = regionPacks.find((p) => p.downloadUrl);
  if (sample) {
    const assetName = sample.file.split("/").pop();
    const url = sample.downloadUrl;
    const j = BASE_URL.length; // 拼接处：url[j] 必须是 /，url[j-1] 必须不是 /

    /**
     * 阶段49：**仅允许回环地址使用 http**，用于「正式 .exe + 本地服务器」的下载链路实测。
     *
     * ⚠️ 为什么必须开这个口子：本地跑 `scripts/serve_packs.py` 只能提供 http，
     *    而原来这条自检硬要求 https，导致本地测试**根本无法生成清单**（实测 exit 1）。
     *    （注意：它拦的其实只是**协议**不是 localhost —— `https://localhost` 照样能过，
     *      所以这条放宽并没有削弱它原本的防护意义。）
     * 🔴 但仍然只认 127.0.0.1 / localhost / [::1]，**任何真实域名都必须 https**。
     */
    const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url);

    const failures = [
      [/^https:\/\//.test(url) || isLoopback, "必须是 https（仅 127.0.0.1/localhost/[::1] 可用 http）"],
      [url[j] === "/", "拼接处应有且仅有一个斜杠"],
      [url[j - 1] !== "/", "基址不应以斜杠结尾（否则拼出双斜杠）"],
      [url.endsWith(`/${assetName}`), `应以 /${assetName} 结尾`],
      [!/\s/.test(url), "不应含空白字符"],
      [url.split("/").pop() === assetName, "文件名不应被截断或编码"],
    ]
      .filter(([ok]) => !ok)
      .map(([, label]) => label);

    if (failures.length) {
      console.error(`\n❌ 下载地址自检失败：${failures.join("；")}\n   ${url}`);
      process.exit(1);
    }

    if (isLoopback) {
      console.warn(
        "\n" +
          "=".repeat(72) +
          "\n🔴 这是一份**本地测试专用**清单：下载基址指向回环地址\n" +
          `   ${BASE_URL}\n` +
          "   它**绝不能**进入发布包 —— 否则所有用户都下载不到任何数据包。\n" +
          "   测完请立刻还原：\n" +
          "     git checkout -- public/packs_manifest.json\n" +
          "     （或 Copy-Item data\\_manifest_backup.json public\\packs_manifest.json -Force）\n" +
          "=".repeat(72) +
          "\n",
      );
    }
    console.log(`\n下载地址自检 : ✅ 通过\n   ${url}`);
  }

  /**
   * ---- thematic / global overlay（kind="gem"）----
   *
   * ‼️ 与上面的 `regionPacks` **不是同一类东西**：
   *    · `kind: "region"` —— 某区域的电网线/面要素，**按视口 bbox 选举**挂载
   *    · `kind: "gem"`    —— 全球电厂点要素，由图层开关控制，
   *                          **不参与视口选举**（见 MapPage 的 isThematicOverlay）
   *    两者归档内的 MVT 图层名也不同（`grid` 对 `gem`），混用会取到不存在的 source-layer，
   *    而那个失败是**静默的**（MapLibre 只是什么都不画）。
   *
   * ‼️ `file` **必须带 `packs/` 前缀**。这不是命名风格问题：
   *    MapPage 的 `candidatePaths()` 只在 `resource.startsWith("packs/")` 时才把
   *    **用户下载目录**（`%APPDATA%\...\packs\`）放进候选列表。
   *    漏掉前缀 ⇒ 下载完成后永远探测不到，症状是「设置页显示已下载、地图上什么都没有」。
   *    前缀同时也是「扫描 `$RESOURCE/packs/`」的开关 —— 正式资源路径就落在这里。
   *
   * ‼️ `key` 用 `"gem"`，**不从文件名推**。文件名是 `gem-plants.pmtiles`，
   *    而 `packKeyFromFile()` 只能推出 `"gem-plants"` —— 两者对不上。
   *    所以约定：**GEM 一律以清单的 `entry.key` 为准**，事件里的 basename
   *    只用来反查是哪一个条目（见 MapPage 的 onPackInstalled）。
   *
   * ⚠️ `features` 留 null：数字来自舞台外的抓取步骤，写死会漂移，而它只用于一句提示文案。
   * ⚠️ 包不存在时**不写这条**并大声告警，而不是写一条 sha256=null 的废条目
   *    （那种条目前端拿不到校验和，用户下载必然失败且看不出原因）。
   */
  const thematicPacks = [];
  /**
   * ---- 阶段56-B：**底图包**（第三类 `kind: "basemap"`）----
   *
   * 与区域包**同 bbox、成对出现**，靠 `forRegion` 字段关联（**不做 key 前缀解析** ——
   * `basemap-kp-kr` 这种字符串猜归属在改名/换命名规则时会**静默失效**：
   * 底图不挂载，地图上什么都不缺，只是没底图）。
   *
   * ‼️ `features` 恒为 `null`：底图不是要素数据，**不要造假数字**。
   * ‼️ 包不存在时**不写这条**并告警（与区域包同一约定），
   *    否则会写出一条 `bytes: null` 的废条目 —— 前端拿不到校验和，下载必然失败且看不出原因。
   * ⚠️ 顺序：`regionPacks` 之后、GEM 之前（消费方按这个顺序展示）。
   */
  const basemapPacks = [];
  for (const r of REGIONS) {
    const f = join(ROOT, "data", "packs", `basemap-${r.key}.pmtiles`);
    if (!existsSync(f)) {
      console.warn(`⚠️ 未找到 basemap-${r.key}.pmtiles —— 该区域的底图包不进清单（生成：见 README_OSM 的阶段56-B）`);
      continue;
    }
    const buf = readFileSync(f);
    basemapPacks.push({
      key: `basemap-${r.key}`,
      kind: "basemap",
      forRegion: r.key,
      label: `${r.label} · 底图`,
      provinces: r.provinces,
      file: `packs/basemap-${r.key}.pmtiles`,
      bbox: r.bbox,
      features: null,
      sizeMb: Number((buf.length / 1024 / 1024).toFixed(2)),
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
      downloadUrl: `${BASE_URL}/basemap-${r.key}.pmtiles`,
    });
  }
  if (basemapPacks.length) {
    console.log(`\n底图包（kind=basemap，按 forRegion 与区域包成对）：${basemapPacks.length} 个`);
    for (const b of basemapPacks) {
      console.log(`  ${b.key.padEnd(22)} forRegion=${b.forRegion.padEnd(14)} ${b.sizeMb} MB`);
    }
  }
  /**
   * 阶段50-B.1：GEM 是 **downloadable thematic pack**，**不进安装包**。
   * 所以它的正式产物与区域包**同目录**：`data/packs/gem-plants.pmtiles`。
   *
   * ‼️ 这里曾经优先去读 `src-tauri/resources/packs/` —— 那是在 GEM 还打算
   *    随安装包分发时的写法。现在那样做反而是错的：
   *    · 安装包 46.5 → ~52 MB，超预算（这就是改回可下载的原因）
   *    · 两份同时存在时，指纹会取自其中一份，而实际分发的是另一份 ⇒
   *      SHA256 对不上，用户下载必然 CHECKSUM_MISMATCH 且不明所以
   *    ⇒ 只认一个路径，从源头上消除“两份产物不一致”的可能。
   */
  const gemFile = join(ROOT, "data", "packs", "gem-plants.pmtiles");
  if (existsSync(gemFile)) {
    const buf = readFileSync(gemFile);
    thematicPacks.push({
      key: "gem",
      kind: "gem",
      label: "GEM Plants",
      provinces: "全球",
      file: "packs/gem-plants.pmtiles",
      bbox: [-180, -85, 180, 85],
      features: null,
      sizeMb: Number((buf.length / 1024 / 1024).toFixed(2)),
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
      downloadUrl: `${BASE_URL}/gem-plants.pmtiles`,
    });
    console.log(
      `\nthematic 包 : key=gem  kind=gem  label="GEM Plants"  ` +
        `${(buf.length / 1024 / 1024).toFixed(2)} MB\n` +
        `              file=packs/gem-plants.pmtiles（可下载，不进安装包，不参与视口选举）\n` +
        `              指纹取自 ${relative(ROOT, gemFile)}`,
    );
  } else {
    console.warn("\n⚠️ 未找到 gem-plants.pmtiles —— GEM 条目不会出现在清单里。已查路径：");
    console.warn(`     ${relative(ROOT, gemFile)}`);
    console.warn(`   生成：${GEM_GEOJSON_HINT} --out data/packs/gem-plants.pmtiles`);
  }

  /** 两类包合并写入清单。顺序：区域包在前（已有的消费方按这个顺序展示）。 */
  const packs = [...regionPacks, ...basemapPacks, ...thematicPacks];

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/gen_packs_manifest.mjs",
    note:
      "区域数据包元信息清单。pack 是否已安装需在运行时用 127 字节 Range 探测判定，" +
      "本文件只描述「有哪些包、覆盖哪里」。",
    release: {
      baseUrl: BASE_URL,
      directBaseUrl: DIRECT_BASE_URL,
      note:
        "数据包托管在 GitHub Release，默认经国内加速镜像（gh-proxy.com）分发。" +
        "仓库已转公开，直连地址同样可用。" +
        "⚠️ 换托管只需改 gen_packs_manifest.mjs 的 DEFAULT_BASE_URL 并重跑本脚本。" +
        "directBaseUrl 是阶段48 的预留字段（当前无代码读取）：镜像失效时可作为降级重试的备用基址。",
    },
    core: {
      label: "核心区（长三角 + 浙江）",
      resource: "maps/osm_grid.pmtiles",
      bbox: CORE_BBOX,
    },
    packs,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log("=== 数据包清单 ===");
  console.log(`核心区覆盖 : ${CORE_BBOX.join(",")}（来自 yrd ∪ zhejiang 的实测 bbox）`);
  // ⚠️ 两类包要分开计数。写成一个“区域包 N 个”会把 GEM 也算进去，
  //    看日志的人会以为 GEM 是第 8 个区域 —— 它们的生命周期完全不同。
  console.log(
    `数据包     : ${packs.length} 个` +
      `（区域包 ${regionPacks.length} + thematic ${thematicPacks.length}）`,
  );
  for (const p of packs) {
    console.log(
      `  ${p.label.padEnd(4)} ${p.key.padEnd(9)} bbox=${p.bbox.join(",").padEnd(24)} ` +
        `${p.file.padEnd(30)} 要素=${p.features ?? "?"} ${p.sizeMb ?? "?"} MB ` +
        `sha256=${p.sha256 ? p.sha256.slice(0, 12) + "…" : "（本机无此包）"}`,
    );
  }
  console.log(`\n下载基址  : ${BASE_URL}`);
  if (carried.length) {
    console.warn(
      `\n⚠️ 本机缺 ${carried.length} 个包（${carried.join("、")}），已沿用上一次清单里的 sha256 / sizeMb。\n` +
        "   这通常就是你想要的（比如只改了托管地址）。\n" +
        "   ⚠️ 但若这些包其实被**重新生成过**，沿用下来的指纹就是错的 —— 请核对后再发布。",
    );
  }
  console.log(`\n→ ${OUT}（${(readFileSync(OUT).length / 1024).toFixed(1)} KB）`);
  if (!report) {
    console.warn(
      `\n⚠️ 未找到 ${REPORT}，features/sizeMb 记为 null。` +
        "清单仍可用（前端只依赖 key/label/bbox/file），但提示文案会缺数字。",
    );
  }
  // ⚠️ 阶段50-B：这里必须只看**区域包**。原先用 `osm-${p.key}.pmtiles` 拼路径，
  //    对 GEM（key="gem"）会去查一个根本不存在的 `osm-gem.pmtiles`，
  //    于是每次生成都会把 GEM 误报成「本机还没生成的包」。
  const missing = regionPacks.filter(
    (p) => !existsSync(join(ROOT, "data", "packs", `osm-${p.key}.pmtiles`)),
  );
  if (missing.length) {
    console.log(`\n本机 data/packs 里还没生成的区域包：${missing.map((p) => p.key).join("、")}`);
  }
}

main();
