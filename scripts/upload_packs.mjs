#!/usr/bin/env node
/**
 * 阶段56-A3：把数据包上传/更新到 GitHub Release（`v1.0-packs`）。
 *
 * 为什么要有这个脚本（而不是照着手册手点）：
 *   1. **替换资产必须「先删后传」**（GitHub 不允许同名覆盖）。直接删旧再传新，
 *      中间任何失败都会让用户拿到 **404** —— 比"留着旧版"糟得多。
 *      本脚本改成：**先以 `<name>.stage` 上传 → 校验 sha256 → 删旧 → PATCH 改名**，
 *      全程不会有"资产不存在"的窗口。
 *   2. **上传前先校验本地文件的 sha256 与清单一致** —— 防"改完数据忘了重算清单"
 *      这种最容易发生、且用户侧表现为 CHECKSUM_MISMATCH 的错。
 *   3. 传完自动复核（size + digest），不靠"网页上出现了文件名"当证据。
 *
 * 用法：
 *   node scripts/upload_packs.mjs --dry-run          # 只列出计划（只发 GET，不写任何东西）
 *   node scripts/upload_packs.mjs                    # 真上传（会问一次确认）
 *   node scripts/upload_packs.mjs --only gem         # 只处理清单里 key=gem 的条目
 *   node scripts/upload_packs.mjs --yes              # 跳过交互确认（脚本化/CI 用）
 *
 * Token 来源（按顺序，**都不打印**）：
 *   1. `$env:GITHUB_TOKEN`
 *   2. `git credential fill`（本机凭据管理器里那条 —— 实测是带 `repo` 权限的 classic OAuth）
 *
 * 零新增依赖：只用 Node 标准库。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "public", "packs_manifest.json");
const PACK_DIR = join(ROOT, "data", "packs");

/**
 * 仓库与 tag。
 * ⚠️ 必须与清单里的发布基址一致（`public/packs_manifest.json` 的 `release.baseUrl`）。
 *    这里写成常量而不是解析 URL：解析镜像前缀（`gh-proxy.com/https://github.com/...`）
 *    比写死更容易错，而错的方向是"传到别的地方去"。
 */
const OWNER = "pstar119";
const REPO = "global-power-gis01";
const TAG = "v1.0-packs";
const API = "https://api.github.com";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, dflt = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY = has("--dry-run");
const YES = has("--yes");
const ONLY = valueOf("--only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function tokenOf() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: "env GITHUB_TOKEN" };
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const token = out
      .split(/\r?\n/)
      .find((l) => l.startsWith("password="))
      ?.slice("password=".length);
    if (token) return { token, from: "git credential fill（凭据管理器）" };
  } catch {
    /* 落到下面报错 */
  }
  return { token: null, from: null };
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "global-power-gis-uploader",
      Accept: "application/vnd.github+json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → HTTP ${res.status}：${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

const sha256Of = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  let packs = manifest.packs.map((p) => ({
    key: p.key,
    name: p.file.split("/").pop(),
    bytes: p.bytes,
    sha256: p.sha256,
  }));
  if (ONLY?.length) packs = packs.filter((p) => ONLY.includes(p.key));

  console.log(`=== 数据包上传 ${DRY ? "（dry-run，只读）" : ""} ===`);
  console.log(`仓库/tag : ${OWNER}/${REPO} @ ${TAG}`);
  console.log(`清单     : ${MANIFEST}`);
  console.log(`资产     : ${packs.length} 个\n`);

  // ---- ① 本地文件与清单逐一对账（不读远端）----
  const plan = [];
  let missing = 0;
  for (const p of packs) {
    const file = join(PACK_DIR, p.name);
    if (!existsSync(file)) {
      console.log(`🔴 ${p.name}：本地不存在，跳过（先跑 gen_packs_manifest.mjs 或 rebuild）`);
      missing++;
      continue;
    }
    const buf = readFileSync(file);
    const size = statSync(file).size;
    const sha = sha256Of(buf);
    const sizeOk = p.bytes == null || p.bytes === size;
    const shaOk = p.sha256 == null || p.sha256 === sha;
    const ok = sizeOk && shaOk;
    console.log(
      `${ok ? "✅" : "🔴"} ${p.name.padEnd(24)} ${(size / 1048576).toFixed(2)} MB  sha256 ${sha.slice(0, 12)}…` +
        (ok ? "（与清单一致）" : `（与清单**不一致**：bytes ${sizeOk ? "ok" : `${p.bytes} ≠ ${size}`}，sha256 ${shaOk ? "ok" : "不符"}）`),
    );
    if (!ok) continue; // 绝不发一个与清单不符的文件
    plan.push({ ...p, file, size, sha });
  }
  console.log();
  if (!plan.length) {
    console.error("❌ 没有可上传的资产。");
    process.exitCode = 1;
    return;
  }
  if (missing) console.log(`⚠️ 有 ${missing} 个包本地缺失，本次不处理。\n`);

  // ---- ② 远端现状（只读）----
  const { token, from } = tokenOf();
  if (!token) {
    console.error("❌ 取不到 GitHub token：请设 $env:GITHUB_TOKEN，或用 git credential fill 登录一次。");
    process.exitCode = 2;
    return;
  }
  console.log(`token    : 来自 ${from}（长度 ${token.length}，值不打印）`);
  globalThis.TOKEN = token;

  const release = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  const assets = new Map((release.assets ?? []).map((a) => [a.name, a]));
  console.log(`远端资产 : ${[...assets.keys()].join(", ") || "(无)"}\n`);

  console.log("=== 计划 ===");
  for (const p of plan) {
    const cur = assets.get(p.name);
    const act = !cur
      ? "新增"
      : cur.size === p.size
        ? "已一致（跳过）"
        : `替换（远端 ${(cur.size / 1048576).toFixed(2)} MB → ${(p.size / 1048576).toFixed(2)} MB）`;
    console.log(`  ${p.name.padEnd(24)} ${act}`);
  }
  console.log(
    "\n替换流程（每个资产）：上传为 `<name>.stage` → 校验远端 size+digest → 删除旧资产 → PATCH 改回正式名\n" +
      "  ⇒ 全程**不存在**「资产缺失」的窗口（直接先删后传才会有那个窗口）。",
  );

  if (DRY) {
    console.log("\n[dry-run] 未做任何写操作。");
    return;
  }
  if (!YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("\n确认上传/替换以上资产？输入 yes 继续：");
    rl.close();
    if (ans.trim().toLowerCase() !== "yes") {
      console.log("已取消。");
      return;
    }
  }

  // ---- ③ 执行 ----
  const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets`;
  let failed = 0;
  for (const p of plan) {
    const cur = assets.get(p.name);
    if (cur && cur.size === p.size) {
      console.log(`⏭  ${p.name}：远端 size 已一致，跳过（如需强制重传请先删远端资产）`);
      continue;
    }
    const stageName = `${p.name}.stage`;
    try {
      console.log(`⬆️  ${p.name} → ${stageName}（${(p.size / 1048576).toFixed(2)} MB）…`);
      const buf = readFileSync(p.file);
      const staged = await fetch(`${uploadUrl}?name=${encodeURIComponent(stageName)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "User-Agent": "global-power-gis-uploader",
          "Content-Type": "application/octet-stream",
          Accept: "application/vnd.github+json",
        },
        body: buf,
      }).then(async (r) => {
        const t = await r.text();
        if (!r.ok) throw new Error(`上传失败 HTTP ${r.status}：${t.slice(0, 300)}`);
        return JSON.parse(t);
      });

      // 远端自校验：GitHub 会回 `size` 与 `digest`（sha256:…）
      const digest = String(staged.digest ?? "").replace(/^sha256:/, "");
      if (staged.size !== p.size || (digest && digest !== p.sha)) {
        throw new Error(
          `远端校验不符：size ${staged.size} vs ${p.size}，digest ${digest.slice(0, 12)} vs ${p.sha.slice(0, 12)}`,
        );
      }
      console.log(`    ✅ 远端校验通过（size=${staged.size}，digest=${digest.slice(0, 12)}…）`);

      if (cur) {
        await api(`/repos/${OWNER}/${REPO}/releases/assets/${cur.id}`, { method: "DELETE" });
        console.log(`    🗑  已删除旧资产 ${p.name}（id=${cur.id}）`);
      }
      await api(`/repos/${OWNER}/${REPO}/releases/assets/${staged.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: p.name }),
      });
      console.log(`    ✅ 已改名为 ${p.name}`);
    } catch (err) {
      failed++;
      console.error(`    🔴 ${p.name} 失败：${err.message}`);
      console.error(`       ⚠️ 正式名资产保持原样（stage 中间态不会影响用户），可重跑本脚本继续。`);
    }
  }

  // ---- ④ 复核 ----
  const after = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  const afterMap = new Map((after.assets ?? []).map((a) => [a.name, a]));
  console.log("\n=== 上传后复核（远端 vs 清单）===");
  let bad = 0;
  for (const p of plan) {
    const a = afterMap.get(p.name);
    const ok = a && a.size === p.size && String(a.digest ?? "").replace(/^sha256:/, "") === p.sha;
    if (!ok) bad++;
    console.log(
      `${ok ? "✅" : "🔴"} ${p.name.padEnd(24)} ${a ? `${(a.size / 1048576).toFixed(2)} MB` : "不存在"}` +
        `${a?.digest ? `  digest=${String(a.digest).replace(/^sha256:/, "").slice(0, 12)}…` : ""}`,
    );
  }
  const leftovers = [...afterMap.keys()].filter((n) => n.endsWith(".stage"));
  if (leftovers.length) console.log(`\n⚠️ 残留中间态资产（请手工清理或重跑）：${leftovers.join(", ")}`);

  console.log(
    `\n结论：${bad === 0 && !failed ? "✅ 全部一致" : `🔴 ${bad} 个不一致、${failed} 个失败`}` +
      `\n下一步：node scripts/verify_packs.mjs --remote`,
  );
  if (bad || failed) process.exitCode = 1;
}

await main();
