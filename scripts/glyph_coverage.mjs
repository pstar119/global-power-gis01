#!/usr/bin/env node
/**
 * T7 决策脚本：把「码位 → fontsource 子集覆盖」算清楚，**用实测回答设计 §6.2**。
 *
 * 要回答的三个问题（设计里只有第 4 条明确写了"不预设结论"，前两条同样不该预设）：
 *   1. 韩 / 日 / 泰 三族到底**需不需要**？—— 取决于邻国底图归档的 `places` 里有没有谚文/假名/泰文。
 *      （设计 §6.2 第 2 条写的是"先加 KR / JP / Thai 三族"，但那是**假设**这些文字会出现。）
 *   2. `Noto Sans SC` 覆盖不覆盖西里尔？（设计 §6.2 第 4 条：缺则加一族 `Noto Sans`）
 *   3. 加完这些族之后，**还剩多少码位没人覆盖**（即图上注定缺字的那些）。
 *
 * 判据是**码位是否落在某个 @font-face 的 unicode-range 内** ——
 * 那正是浏览器渲染时的真实判据（MapLibre 把 fontstack 拼成 CSS 字体族列表，由浏览器回退）。
 *
 * 用法：
 *   node scripts/glyph_coverage.mjs                       # 读 data/_glyph_scan/merged.json
 *   node scripts/glyph_coverage.mjs --codepoints <file>   # 指定码位集合
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 候选字体族：fontsource 包名 → 显示名。key 是 npm 包名（同时也是 CDN 路径段）。 */
const CANDIDATES = [
  { pkg: "noto-sans-sc", label: "Noto Sans SC（现有族，中文）" },
  { pkg: "noto-sans-kr", label: "Noto Sans KR（设计 §6.2 第 2 条）" },
  { pkg: "noto-sans-jp", label: "Noto Sans JP（设计 §6.2 第 2 条）" },
  { pkg: "noto-sans-thai", label: "Noto Sans Thai（设计 §6.2 第 2 条）" },
  { pkg: "noto-sans", label: "Noto Sans（设计 §6.2 第 4 条：西里尔兜底候选）" },
];

const argv = process.argv.slice(2);
let cpFile = "data/_glyph_scan/merged.json";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--codepoints") cpFile = argv[++i];
}

const cpPath = resolve(ROOT, cpFile);
if (!existsSync(cpPath)) {
  console.error(
    `❌ 找不到码位集合 ${cpFile}\n   先跑：node scripts/scan_place_codepoints.mjs --json ${cpFile}`,
  );
  process.exit(1);
}
const scan = JSON.parse(readFileSync(cpPath, "utf8"));
const codePoints = scan.merged?.codePoints ?? scan.codePoints;
if (!Array.isArray(codePoints) || !codePoints.length) {
  console.error(`❌ ${cpFile} 里没有 merged.codePoints`);
  process.exit(1);
}
const cpSet = new Set(codePoints);
console.log(`码位集合：${codePoints.length} 个（来自 ${cpFile}）\n`);

function parseUnicodeRange(spec) {
  const out = [];
  for (const part of spec.split(",")) {
    const p = part.trim();
    const m = /^U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?$/.exec(p);
    if (!m) continue;
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    out.push([lo, hi]);
  }
  return out;
}

async function coverageOf(pkg) {
  const url = `https://cdn.jsdelivr.net/npm/@fontsource/${pkg}/400.css`;
  const res = await fetch(url);
  if (!res.ok) return { url, error: `HTTP ${res.status}`, covered: new Set(), subsets: [] };
  const css = await res.text();
  // 逐个 @font-face 块解析（url + unicode-range 一起抓，顺序稳定）
  const re = /@font-face\s*\{([\s\S]*?)\}/g;
  const subsets = [];
  for (const m of css.matchAll(re)) {
    const body = m[1];
    const u = /url\(([^)]+\.woff2)\)/.exec(body);
    const r = /unicode-range:\s*([^;]+);/.exec(body);
    if (!u || !r) continue;
    subsets.push({ file: u[1].split("/").pop(), ranges: parseUnicodeRange(r[1]) });
  }
  const covered = new Set();
  for (const cp of cpSet) {
    if (subsets.some((s) => s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi))) covered.add(cp);
  }
  return { url, covered, subsets };
}

const results = [];
for (const c of CANDIDATES) {
  const r = await coverageOf(c.pkg);
  results.push({ ...c, ...r });
  if (r.error) {
    console.log(`${c.label.padEnd(38)} ❌ ${r.error}`);
    continue;
  }
  console.log(
    `${c.label.padEnd(38)} 子集 ${String(r.subsets.length).padStart(3)} 个，` +
      `覆盖 ${String(r.covered.size).padStart(4)} / ${codePoints.length} 个码位`,
  );
}

/** 逐族**新增**覆盖（按上面的顺序累加），用于回答"加了它到底多覆盖了几个字" */
console.log("\n=== 逐族累加：每个族新增覆盖多少码位（这就是「加它的实际收益」）===");
const union = new Set();
for (const r of results) {
  if (r.error) continue;
  const fresh = [...r.covered].filter((cp) => !union.has(cp));
  for (const cp of r.covered) union.add(cp);
  console.log(
    `  + ${r.pkg.padEnd(18)} 新增 ${String(fresh.length).padStart(4)} 个` +
      (fresh.length
        ? `   样本：${fresh.slice(0, 24).map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`
        : ""),
  );
}

const uncovered = codePoints.filter((cp) => !union.has(cp));
console.log(
  `\n=== 全族联合后仍无覆盖：${uncovered.length} / ${codePoints.length} 个码位 ===`,
);
if (uncovered.length) {
  console.log(
    "  " + uncovered.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" "),
  );
  console.log(
    "  （这些字在任何候选族里都没有子集 —— 图上会缺字。它们同时也是 `name:en` 兜底的理由。）",
  );
}

/** 按文字系统分组看「谁缺，缺在哪一类」 */
const SCRIPT_RANGES = [
  ["CJK 汉字", 0x3400, 0x9fff],
  ["CJK 扩展A/B", 0x20000, 0x2ffff],
  ["假名（日）", 0x3040, 0x30ff],
  ["谚文（韩）", 0xac00, 0xd7af],
  ["西里尔", 0x0400, 0x052f],
  ["泰文", 0x0e00, 0x0e7f],
  ["老挝文", 0x0e80, 0x0eff],
  ["缅甸文", 0x1000, 0x109f],
  ["阿拉伯文", 0x0600, 0x06ff],
  ["拉丁扩展", 0x0100, 0x024f],
];
console.log("\n=== 未覆盖码位按文字系统分组 ===");
let assigned = 0;
for (const [name, lo, hi] of SCRIPT_RANGES) {
  const hit = uncovered.filter((cp) => cp >= lo && cp <= hi);
  if (!hit.length) continue;
  assigned += hit.length;
  console.log(`  ${name.padEnd(14)} ${hit.length}`);
}
console.log(`  ${"其它（标点等）".padEnd(12)} ${uncovered.length - assigned}`);

/** 一份可直接抄进 fetch_glyphs.mjs 的结论摘要 */
console.log("\n=== 结论摘要（按实测数字，不按设计预设） ===");
for (const r of results) {
  if (r.error) continue;
  const solo = r.covered.size;
  console.log(`  ${r.pkg.padEnd(18)} 单独覆盖 ${solo}/${codePoints.length}`);
}
