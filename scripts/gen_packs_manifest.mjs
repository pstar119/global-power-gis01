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
import { dirname, join, resolve } from "node:path";
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

  const packs = REGIONS.map((r) => {
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
  const sample = packs.find((p) => p.downloadUrl);
  if (sample) {
    const assetName = sample.file.split("/").pop();
    const url = sample.downloadUrl;
    const j = BASE_URL.length; // 拼接处：url[j] 必须是 /，url[j-1] 必须不是 /
    const failures = [
      [/^https:\/\//.test(url), "必须是 https"],
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
    console.log(`\n下载地址自检 : ✅ 通过\n   ${url}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/gen_packs_manifest.mjs",
    note:
      "区域数据包元信息清单。pack 是否已安装需在运行时用 127 字节 Range 探测判定，" +
      "本文件只描述「有哪些包、覆盖哪里」。",
    release: {
      baseUrl: BASE_URL,
      note:
        "数据包托管在 GitHub Release，默认经国内加速镜像（gh-proxy.com）分发。" +
        "仓库已转公开，直连地址同样可用。" +
        "⚠️ 换托管只需改 gen_packs_manifest.mjs 的 DEFAULT_BASE_URL 并重跑本脚本。",
    },
    core: {
      label: "核心区（长三角 + 浙江）",
      resource: "maps/osm_grid.pmtiles",
      bbox: CORE_BBOX,
    },
    packs,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log("=== 区域数据包清单 ===");
  console.log(`核心区覆盖 : ${CORE_BBOX.join(",")}（来自 yrd ∪ zhejiang 的实测 bbox）`);
  console.log(`区域包     : ${packs.length} 个`);
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
  const missing = packs.filter((p) => !existsSync(join(ROOT, "data", "packs", `osm-${p.key}.pmtiles`)));
  if (missing.length) {
    console.log(`\n本机 data/packs 里还没生成的包：${missing.map((p) => p.key).join("、")}`);
  }
}

main();
