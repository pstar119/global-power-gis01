/**
 * 阶段55：数据包一致性校验（**本地 + 远端**）。
 *
 * 为什么需要它（这不是「有空再做的锦上添花」，阶段55 体检证明了它是防 P0 的那一环）：
 *
 *   `public/packs_manifest.json` 是**脚本生成**的，它只描述「包里应该有什么」
 *   （文件名 / 字节数 / SHA256 / 下载基址）。而**清单说得对，不等于远端真有这个文件**：
 *   清单里 `kind: "gem"` 的下载地址由 `BASE_URL + 文件名` 拼出，
 *   `gen_packs_manifest.mjs` **从不检查那个地址是否真的存在**。
 *
 *   ⇒ 实测后果（2026-09-18，阶段55 体检）：GitHub Release `v1.0-packs`
 *      （建于 2026-09-14）只有 **7 个 `osm-*.pmtiles`**，
 *      **`gem-plants.pmtiles` 从未上传**。而清单照样给它写了 downloadUrl。
 *      于是**新装用户点「GEM Plants」必然下载失败**，而开发机上永远复现不了 ——
 *      因为开发机的 `%APPDATA%\...\packs\` 里那个文件是
 *      `install_packs.mjs --user-dir` **投放**进去的，不是下载来的。
 *
 *   这类问题**没法靠看代码发现**，只能真的去问一次远端。所以本脚本把两件事都做掉：
 *     ① 本地：清单 vs 磁盘上的包（字节数 + SHA256），顺带回答「这台机器装了哪几个包」；
 *     ② 远端（`--remote`）：清单 vs Release 资产列表，**缺哪个包会直接点名**。
 *
 * ⚠️ 与 `verify_pack.mjs` 的分工（别搞混）：
 *    · `verify_pack.mjs <pack.pmtiles>` —— **单个包内部**的体检（瓦片封顶、电压分级、
 *      要素数是否符合切片参数），回答「包**切得对不对**」；
 *    · 本脚本 —— **清单/磁盘/远端三方**的一致性，回答「包**在不在、对不对得上**」。
 *
 * 零依赖：只用 `node:fs` / `node:crypto` / 全局 `fetch`（Node ≥ 18）。
 *
 * 用法：
 *   node scripts/verify_packs.mjs                 # 本地校验（含本机已装包清单）
 *   node scripts/verify_packs.mjs --remote        # 额外比对 GitHub Release 资产（需要网络）
 *   node scripts/verify_packs.mjs --dir "D:\\apps\\Global Power GIS\\packs"   # 额外查一个目录
 *   node scripts/verify_packs.mjs --quiet         # 只输出问题
 *
 * 退出码：0 = 没问题；1 = 发现问题；2 = 用法错误。
 *   ‼️ 「本地缺包」**不算问题**（用户不需要装齐 8 个包）；只有
 *      「文件在、但对不上清单」与「远端缺资产」才返回 1 —— 否则这个脚本会天天误报，
 *      而一个天天误报的检查等于没有检查。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "public", "packs_manifest.json");
const DATA_PACKS = join(ROOT, "data", "packs");

/**
 * 应用标识符 —— ⚠️ 必须与 `src-tauri/tauri.conf.json` 的 `identifier` 一致
 * （与 `install_packs.mjs` 同一个常量，两处含义相同：运行时第一顺位）。
 */
const APP_IDENTIFIER = "com.pstar119.globalpowergis";

/** 远端资产名 → 清单条目名 的唯一换算：清单里是 `packs/<name>`，资产名就是 `<name>`。 */
const assetNameOf = (pack) => basename(pack.file);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const REMOTE = flag("--remote");
const QUIET = flag("--quiet");
const extraDirs = argv.reduce((acc, a, i) => (a === "--dir" ? [...acc, argv[i + 1]] : acc), []);

const problems = [];
const notes = [];

function log(...args) {
  if (!QUIET) console.log(...args);
}
function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function human(bytes) {
  if (bytes === null || bytes === undefined) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function candidateDirs() {
  const dirs = [{ dir: DATA_PACKS, label: "data/packs（构建中间产物）" }];
  if (process.env.APPDATA) {
    dirs.push({
      dir: join(process.env.APPDATA, APP_IDENTIFIER, "packs"),
      label: "%APPDATA% 用户目录（运行时第一顺位）",
    });
  }
  for (const d of extraDirs) {
    if (d) dirs.push({ dir: resolve(d), label: `--dir ${d}` });
  }
  return dirs;
}

/** ① 本地：清单里记的指纹 vs 磁盘上的文件。 */
function checkLocal(packs) {
  log("\n=== 本地校验：清单 vs 磁盘 ===");
  for (const { dir, label } of candidateDirs()) {
    log(`\n· ${label}`);
    log(`  ${dir}`);
    if (!existsSync(dir)) {
      log("  （目录不存在 —— 全新克隆时 data/packs 为空是正常的，见 .gitignore 的 /data/）");
      continue;
    }
    let present = 0;
    for (const pack of packs) {
      const name = assetNameOf(pack);
      const path = join(dir, name);
      if (!existsSync(path)) {
        log(`  ·   ${name.padEnd(24)} 未安装`);
        continue;
      }
      present++;
      const size = statSync(path).size;
      const sizeOk = pack.bytes === null || pack.bytes === undefined || size === pack.bytes;
      let shaOk = true;
      if (pack.sha256) shaOk = sha256Of(path) === pack.sha256;
      const verdict = sizeOk && shaOk ? "✅ 一致" : "🔴 不一致";
      log(
        `  ·   ${name.padEnd(24)} ${human(size).padStart(9)}  ${verdict}` +
          (sizeOk ? "" : `（清单记 ${human(pack.bytes)}）`) +
          (shaOk ? "" : "（SHA256 不符）"),
      );
      if (!sizeOk) problems.push(`${name} @ ${dir}：字节数 ${size} ≠ 清单 ${pack.bytes}`);
      if (!shaOk) problems.push(`${name} @ ${dir}：SHA256 与清单不符`);
    }
    log(`  → 已安装 ${present}/${packs.length}`);
    if (present < packs.length) {
      notes.push(
        `${label} 只有 ${present}/${packs.length} 个包 —— 属正常（按需下载），` +
          `要投满用：node scripts/install_packs.mjs --user-dir`,
      );
    }
  }
}

/** ② 远端：Release 资产列表 vs 清单。**这是本脚本存在的主要理由。** */
async function checkRemote(packs, manifest) {
  log("\n=== 远端校验：GitHub Release 资产 vs 清单 ===");
  const bases = [manifest.release?.directBaseUrl, manifest.release?.baseUrl].filter(Boolean);
  let parsed = null;
  for (const b of bases) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)/.exec(b);
    if (m) {
      parsed = { owner: m[1], repo: m[2], tag: m[3] };
      break;
    }
  }
  if (!parsed) {
    problems.push("清单的 release.baseUrl / directBaseUrl 里解析不出 GitHub owner/repo/tag");
    log("🔴 解析不出 GitHub 仓库与 tag —— 若已换托管（OSS/R2 等），请改用对应平台的资产清单核对。");
    return;
  }
  const { owner, repo, tag } = parsed;
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  log(`· 仓库 ${owner}/${repo}   tag ${tag}`);
  log(`· ${api}`);

  let json;
  try {
    const res = await fetch(api, {
      headers: {
        // GitHub API 不带 User-Agent 会直接 403，这不是可选项
        "user-agent": "global-power-gis-verify-packs",
        accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      problems.push(`查询 Release 失败：HTTP ${res.status}`);
      log(`🔴 HTTP ${res.status} —— 无法核对远端（若是 404，说明 tag 不存在或仓库未公开）`);
      return;
    }
    json = await res.json();
  } catch (e) {
    problems.push(`查询 Release 失败：${e.message}`);
    log(`🔴 网络失败：${e.message}`);
    return;
  }

  const assets = new Map((json.assets ?? []).map((a) => [a.name, a]));
  log(`· 远端资产 ${assets.size} 个：${[...assets.keys()].join(", ")}`);
  log("");

  const claimed = new Set();
  for (const pack of packs) {
    const name = assetNameOf(pack);
    claimed.add(name);
    const asset = assets.get(name);
    if (!asset) {
      problems.push(`远端缺少资产 ${name}（清单声明它可下载，实际 404）`);
      log(`  🔴 ${name.padEnd(24)} 远端**不存在** —— 清单却给了 downloadUrl，用户必然下载失败`);
      continue;
    }
    // GitHub 从 2024 起为资产算 digest（形如 "sha256:..."），有就拿来比，没有就只比体积
    const remoteSha = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : null;
    const sizeOk = pack.bytes === null || pack.bytes === undefined || asset.size === pack.bytes;
    const shaOk = !remoteSha || !pack.sha256 || remoteSha === pack.sha256;
    log(
      `  ${sizeOk && shaOk ? "✅" : "🔴"} ${name.padEnd(24)} 远端 ${human(asset.size).padStart(9)}` +
        (sizeOk ? "" : ` ≠ 清单 ${human(pack.bytes)}`) +
        (shaOk ? "" : "（SHA256 与清单不符）"),
    );
    if (!sizeOk) problems.push(`远端 ${name} 体积 ${asset.size} ≠ 清单 ${pack.bytes}`);
    if (!shaOk) problems.push(`远端 ${name} 的 SHA256 与清单不符`);
  }

  const orphans = [...assets.keys()].filter((n) => !claimed.has(n));
  if (orphans.length) notes.push(`远端有 ${orphans.length} 个清单未声明的资产：${orphans.join(", ")}`);
}

async function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`找不到清单 ${MANIFEST}`);
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const packs = manifest.packs ?? [];
  log(`清单 ${MANIFEST}`);
  log(`共 ${packs.length} 个包：${packs.map((p) => p.key).join(", ")}`);

  checkLocal(packs);
  if (REMOTE) await checkRemote(packs, manifest);

  log("\n=== 结论 ===");
  if (problems.length === 0) {
    log("✅ 未发现问题。");
  } else {
    for (const p of problems) console.log(`🔴 ${p}`);
    console.log(
      `\n共 ${problems.length} 项问题。` +
        (problems.some((p) => p.includes("远端缺少资产"))
          ? "\n   远端缺资产的处理方式见 docs/PACKS_UPLOAD_RUNBOOK.md。"
          : ""),
    );
  }
  if (notes.length && !QUIET) {
    console.log("");
    for (const n of notes) console.log(`ℹ️  ${n}`);
  }
  if (problems.length) process.exitCode = 1;
}

await main();
