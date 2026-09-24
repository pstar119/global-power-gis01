/**
 * 阶段55：发布前红线自检（**扫 dist，而不是只扫 exe**）。
 *
 * ‼️ 为什么必须新增这个脚本 —— 因为 README 原来那条自检是**不可靠的**（阶段55 实测）：
 *
 *    原做法：把 `global-power-gis.exe` 按 latin1 读成字符串，再搜 `127.0.0.1:8099`，
 *    「未命中」就当「构建期没有 PACKS_BASE_URL 污染」。问题是：
 *
 *    Tauri 在 release 构建里把前端资源**压缩**后嵌入二进制（Brotli），所以
 *    **前端 bundle 里的任何字符串都不会以明文出现在 exe 里** —— 无论它有没有被污染。
 *    实测证据（阶段55，同一份产物）：
 *      · dist/assets/index-*.js 里**有**「最大」「localhost:11434」等字样；
 *      · 同一个 exe 里搜这些字样 **全部未命中**。
 *    ⇒ 那条检查**永远会绿**，包括真的被污染时。这正是本项目最怕的那类失败
 *      （见 packs.ts 的注释：localhost 被内联进产物 = 所有用户下载 100% 失败，且完全静默）。
 *
 *    ⚠️ 更阴的是那个检查还会给出**假阳性**：exe 里确实能搜到 `lang="en"`，
 *    但它来自 **Brotli 内置静态字典**（周围是 `that isLibraryhusbandin factaffairs…`
 *    这种词表），**不是**我们的 `index.html`。⇒ 在 exe 里搜 HTML/前端字符串，
 *    结论两个方向都不可信。
 *
 *    ⇒ 正确的作用域：**前端的东西在 dist 里查，Rust 的东西才在 exe 里查。**
 *      dist 才是「会被嵌入 exe 的那份内容」的唯一真源。
 *
 * 用法：
 *   node scripts/check_release_redlines.mjs              # 扫 dist（必须先跑过 npm run build）
 *   node scripts/check_release_redlines.mjs --with-exe   # 额外扫裸 exe（Rust 侧字符串）
 *
 * 退出码：0 = 通过；1 = 有问题（禁用串命中，或对照串缺失）；2 = 用法错误（如 dist 不存在）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const EXE = join(ROOT, "src-tauri", "target", "release", "global-power-gis.exe");
const WITH_EXE = process.argv.includes("--with-exe");

/**
 * 禁用串 —— 出现即代表产物有问题。
 *
 * ⚠️ 别把 `localhost` 一律禁掉：`localhost:11434`（Ollama）是**预期存在**的，
 *    它在下面充当对照项。只禁**具体**的污染值。
 */
const FORBIDDEN_DIST = [
  ["127.0.0.1:8099", "开发期 PACKS_BASE_URL 被内联进产物 ⇒ 所有用户下载必然失败"],
  ["PACKS_BASE_URL", "构建期环境变量名残留在产物里（说明注入路径没被剥干净）"],
  ["remote-debugging", "调试端口参数泄漏进产物"],
  ["9222", "CDP 调试端口"],
  ["api_key=", "疑似硬编码密钥"],
];

/**
 * 对照串 —— **必须命中**，否则「全都没命中」这种绿灯毫无意义。
 * 阶段55 实测：`localhost:11434` 在 dist 的 bundle 里命中 3 次。
 */
const REQUIRED_DIST = [["localhost:11434", "Ollama 默认地址（预期在产物里）"]];

/**
 * exe 侧只查**属于 Rust 的**字符串。前端字符串一律不在这里查（见头部说明）。
 * `export_csv_file` 是阶段54 新增的 Rust 命令，必须出现在二进制里 —— 它同时证明
 * 「这个 exe 确实是本仓库构建的」，避免拿错产物做自检。
 */
const FORBIDDEN_EXE = [
  ["127.0.0.1:8099", "开发期基址（Rust 侧同样不该有）"],
  ["remote-debugging", "调试参数"],
  ["api_key=", "疑似硬编码密钥"],
];
const REQUIRED_EXE = [
  ["export_csv_file", "阶段54 的 Rust 命令（对照项：证明构建来源正确）"],
  ["tauri.localhost", "生产版前端源（对照项）"],
];

const problems = [];

function scanTextFiles(dir, needles, label) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if ([".js", ".mjs", ".css", ".html", ".json", ".svg"].includes(extname(p))) files.push(p);
    }
  })(dir);
  console.log(`\n=== ${label}（${files.length} 个文本文件）===`);
  const counts = new Map();
  for (const f of files) {
    const text = readFileSync(f, "latin1");
    for (const [needle] of needles) {
      const n = text.split(needle).length - 1;
      if (n > 0) counts.set(needle, [...(counts.get(needle) ?? []), `${f.replace(ROOT + "\\", "")}(x${n})`]);
    }
  }
  return counts;
}

function reportDist() {
  if (!existsSync(DIST)) {
    console.error(`找不到 ${DIST} —— 先跑 npm run build / npm run tauri build。`);
    process.exitCode = 2;
    return;
  }
  const counts = scanTextFiles(DIST, [...FORBIDDEN_DIST, ...REQUIRED_DIST], "dist 扫描（前端真源）");
  console.log("\n· 禁用串（应全部未命中）");
  for (const [needle, why] of FORBIDDEN_DIST) {
    const hit = counts.get(needle);
    console.log(`  ${hit ? "🔴 命中" : "✅ 未命中"}  ${needle.padEnd(20)} ${why}`);
    if (hit) problems.push(`dist 命中禁用串 ${needle}：${hit.join(", ")}`);
  }
  console.log("\n· 对照串（应全部命中；全绿才有意义）");
  for (const [needle, why] of REQUIRED_DIST) {
    const hit = counts.get(needle);
    console.log(`  ${hit ? "✅ 命中" : "🔴 未命中"}  ${needle.padEnd(20)} ${why}`);
    if (!hit) problems.push(`dist 缺少对照串 ${needle}（自检无效，可能是产物不对）`);
  }
}

function reportExe() {
  if (!existsSync(EXE)) {
    console.log(`\n=== exe 扫描 ===\n  ⚠️ 找不到 ${EXE}（还没打包过 release），跳过。`);
    return;
  }
  const latin = readFileSync(EXE).toString("latin1");
  console.log(`\n=== exe 扫描（仅 Rust 侧字符串；前端内容已在 dist 查过）===`);
  for (const [needle, why] of FORBIDDEN_EXE) {
    const hit = latin.includes(needle);
    console.log(`  ${hit ? "🔴 命中" : "✅ 未命中"}  ${needle.padEnd(20)} ${why}`);
    if (hit) problems.push(`exe 命中禁用串 ${needle}`);
  }
  for (const [needle, why] of REQUIRED_EXE) {
    const hit = latin.includes(needle);
    console.log(`  ${hit ? "✅ 命中" : "🔴 未命中"}  ${needle.padEnd(20)} ${why}`);
    if (!hit) problems.push(`exe 缺少对照串 ${needle}（拿错产物了？）`);
  }
}

reportDist();
if (WITH_EXE) reportExe();

console.log("\n=== 结论 ===");
if (problems.length === 0) {
  console.log("✅ 红线自检通过。");
} else {
  for (const p of problems) console.log(`🔴 ${p}`);
  process.exitCode = 1;
}
