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
 * 阶段44：数据包下载基址。
 *
 * ‼️ **可匿名读取**是该地址成立的前提。改用环境变量覆盖，
 *    这样切换到「公开数据仓库」或「对象存储 + CDN」而不需要改代码：
 *      $env:PACKS_BASE_URL="https://..."; node scripts/gen_packs_manifest.mjs
 *
 * ⚠️ 实测（2026-09-15）：`pstar119/global-power-gis01` 是**私有**仓库，
 *    未认证访问它的 Release 资产一律 404。这个默认值在仓库转公开之前**下载不到**。
 *    另外 GitHub Release 资产**不发 CORS 头**，所以只能由 Rust 侧下载（见 src-tauri/src/packs.rs）。
 */
const DEFAULT_BASE_URL =
  "https://github.com/pstar119/global-power-gis01/releases/download/v1.0-packs";
const BASE_URL = (process.env.PACKS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

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
  const packs = REGIONS.map((r) => {
    const rec = report?.regions?.[r.key];
    const { cols, rows } = gridFor(r);
    const assetName = `osm-${r.key}.pmtiles`;
    const { sha256, bytes } = fingerprint(join(ROOT, "data", "packs", assetName));
    return {
      key: r.key,
      label: r.label,
      provinces: r.provinces,
      bbox: r.bbox,
      file: `packs/${assetName}`,
      chunks: cols * rows,
      // 以下两项来自流水线报表；没有报表时为 null（前端不依赖它们，仅用于提示文案）
      features: rec?.stages?.build?.features ?? rec?.stages?.prepare?.featureCount ?? null,
      sizeMb: rec?.stages?.build?.packSizeMb ?? null,
      maxTileKb: rec?.stages?.build?.widest?.rawKb ?? null,
      // 阶段44：下载所需。本机没有该包时三项均为 null（不影响其它包）。
      downloadUrl: bytes === null ? null : `${BASE_URL}/${assetName}`,
      sha256,
      bytes,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/gen_packs_manifest.mjs",
    note:
      "区域数据包元信息清单。pack 是否已安装需在运行时用 127 字节 Range 探测判定，" +
      "本文件只描述「有哪些包、覆盖哪里」。",
    release: {
      baseUrl: BASE_URL,
      note:
        "数据包托管在 GitHub Release。⚠️ 仓库转公开前该地址匿名不可读；" +
        "改用其它托管只需重跑本脚本并设置 PACKS_BASE_URL。",
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
