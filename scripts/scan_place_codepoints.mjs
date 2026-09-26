#!/usr/bin/env node
/**
 * 阶段56-B（T7 前置）：**扫 6 份底图归档的 `places` 码位**，回答设计 §6.2 第 3/4 条。
 *
 * 为什么必须有这一步（而不是照设计预设结论）：
 *   · 现有字形子集是**只按中国那份底图**（`src-tauri/resources/maps/basemap.pmtiles`）
 *     的 places 码位裁的（86/101 个子集，2.1 MB）。邻国底图包的 places 里是
 *     韩文 / 日文 / 泰文 / 西里尔 / 阿拉伯文……**中国那份扫不到**。
 *   · 设计 §6.2 第 4 条明确要求「西里尔单独立项核实：先扫码位判断 Noto Sans SC
 *     是否已覆盖；缺则加一族 Noto Sans —— **不在设计里预设结论**」。
 *
 * 判据（与 `fetch_glyphs.mjs` 的 NAME_KEYS 完全一致，否则会出现
 * 「扫字形时算的是 A 字、实际渲染用的是 B 字」→ 图上缺字）：
 *   `name:zh-Hans` → `name:zh-Hant` → `name:en` → `name`
 *
 * 用法：
 *   node scripts/scan_place_codepoints.mjs                 # 全部 6 份归档
 *   node scripts/scan_place_codepoints.mjs <archive> ...   # 只扫指定归档
 *   node scripts/scan_place_codepoints.mjs --json out.json # 额外写一份机器可读结果
 *
 * ⚠️ 慢：要把归档里**每一个**瓦片都解出来（含 z0–z8 全世界）。6 份合计约 20 MB，
 *    实测每份几分钟。所以结果会缓存到 `data/_glyph_scan/<mtime>-<size>.json`，
 *    归档没变就不会重扫。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { PMTiles } from "pmtiles";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "data", "_glyph_scan");

/** 与 `fetch_glyphs.mjs` / MapPage 的 `text-field` coalesce 顺序**必须**一致 */
const NAME_KEYS = ["name:zh-Hans", "name:zh-Hant", "name:en", "name"];

/**
 * 6 份归档。核心那份（随安装包分发的 `basemap.pmtiles`）不能漏 ——
 * 它是现有 86 个子集的来源，漏了就可能在换族时把国内的覆盖弄丢。
 */
const DEFAULT_ARCHIVES = [
  "src-tauri/resources/maps/basemap.pmtiles",
  "data/packs/basemap-kp-kr.pmtiles",
  "data/packs/basemap-mn.pmtiles",
  "data/packs/basemap-sea-mainland.pmtiles",
  "data/packs/basemap-ca.pmtiles",
  "data/packs/basemap-ru-far.pmtiles",
];

// ---------------------------------------------------------------- MVT 解码
// ‼️ 这段与 `fetch_glyphs.mjs` 是**同一份实现**（那是已验证过的：它踩过的游标错位坑
//    都写在 fetch_glyphs 的注释里）。这里刻意复制而不是抽公共模块：
//    两个脚本各自独立可跑，抽出去会让「单独跑扫描」也要先加载下载侧的依赖。
function cursor(bytes) {
  let pos = 0;
  return {
    get pos() {
      return pos;
    },
    set pos(v) {
      pos = v;
    },
    eof: () => pos >= bytes.length,
    varint() {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        const b = bytes[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      return Number(result);
    },
    take(n) {
      const s = bytes.subarray(pos, pos + n);
      pos += n;
      return s;
    },
    skip(wire, isPackedTag) {
      if (wire === 0) this.varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) {
        const n = this.varint();
        const packed = isPackedTag ? bytes.subarray(pos, pos + n) : null;
        pos += n;
        return packed;
      } else if (wire === 5) pos += 4;
      else throw new Error(`不支持的 wire type: ${wire}`);
    },
  };
}

function decodeValue(bytes) {
  const r = cursor(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  while (!r.eof()) {
    const key = r.varint();
    const f = key >> 3;
    const w = key & 7;
    if (f === 1 && w === 2) return Buffer.from(r.take(r.varint())).toString("utf8");
    if (f === 2 && w === 5) {
      const v = dv.getFloat32(r.pos, true);
      r.pos += 4;
      return v;
    }
    if (f === 3 && w === 1) {
      const v = dv.getFloat64(r.pos, true);
      r.pos += 8;
      return v;
    }
    if (f === 4 && w === 0) return r.varint();
    if (f === 5 && w === 0) return r.varint();
    if (f === 6 && w === 0) {
      const v = r.varint();
      return (v >> 1) ^ -(v & 1);
    }
    if (f === 7 && w === 0) return r.varint() === 1;
    r.skip(w);
  }
  return null;
}

function decodeFeatureTags(bytes) {
  const r = cursor(bytes);
  const tags = [];
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 2 && wire === 2) {
      const packed = r.skip(wire, true);
      const pr = cursor(packed);
      while (!pr.eof()) tags.push(pr.varint());
    } else r.skip(wire);
  }
  const out = new Map();
  for (let i = 0; i + 1 < tags.length; i += 2) out.set(tags[i], tags[i + 1]);
  return out;
}

/** 只解出 `places` 层（其余层直接跳过，省一半时间） */
function decodePlacesLayerTexts(buf) {
  const r = cursor(new Uint8Array(buf));
  const out = [];
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 3 && wire === 2) {
      const layerBytes = r.take(r.varint());
      const lr = cursor(layerBytes);
      let name = null;
      const keys = [];
      const values = [];
      const featureTags = [];
      while (!lr.eof()) {
        const k = lr.varint();
        const f = k >> 3;
        const w = k & 7;
        if (f === 1 && w === 2) name = Buffer.from(lr.take(lr.varint())).toString("utf8");
        else if (f === 2 && w === 2) featureTags.push(decodeFeatureTags(lr.take(lr.varint())));
        else if (f === 3 && w === 2) keys.push(Buffer.from(lr.take(lr.varint())).toString("utf8"));
        else if (f === 4 && w === 2) values.push(decodeValue(lr.take(lr.varint())));
        else lr.skip(w);
      }
      if (name !== "places") continue;
      for (const tags of featureTags) {
        for (const nk of NAME_KEYS) {
          const ki = keys.indexOf(nk);
          if (ki < 0) continue;
          const vi = tags.get(ki);
          if (vi == null) continue;
          const v = values[vi];
          if (typeof v === "string" && v.length > 0) {
            out.push(v);
            break; // coalesce：取到第一个非空就停
          }
        }
      }
    } else r.skip(wire);
  }
  return out;
}

// ---------------------------------------------------------------- 扫一份归档
async function scanArchive(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`归档不存在：${relPath}`);
  const st = statSync(abs);

  mkdirSync(CACHE_DIR, { recursive: true });
  // 缓存键 = 文件名 + mtime + size（归档是 gitignore 的构建产物，内容变了 mtime 必变）
  const cacheKey = `${basename(relPath)}.${st.mtimeMs}.${st.size}.json`;
  const cachePath = join(CACHE_DIR, cacheKey);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    console.log(`  （缓存命中：${cacheKey}）`);
    return cached;
  }

  const raw = readFileSync(abs);
  const pm = new PMTiles({
    async getBytes(offset, length) {
      return {
        data: raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + length),
      };
    },
    getKey: () => "codepoint-scan",
  });

  const header = await pm.getHeader();
  const texts = new Map();
  let tiles = 0;
  let named = 0;

  for (let z = header.minZoom; z <= header.maxZoom; z++) {
    const n = 2 ** z;
    let zTiles = 0;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const t = await pm.getZxy(z, x, y);
        if (!t) continue;
        tiles++;
        zTiles++;
        for (const s of decodePlacesLayerTexts(Buffer.from(t.data))) {
          named++;
          texts.set(s, (texts.get(s) ?? 0) + 1);
        }
      }
    }
    if (zTiles) process.stdout.write(`    z${z}: ${zTiles} 瓦片\n`);
  }

  const codePoints = new Set();
  for (const t of texts.keys()) for (const ch of t) codePoints.add(ch.codePointAt(0));
  const result = {
    archive: relPath,
    bytes: st.size,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    tiles,
    named,
    distinctNames: texts.size,
    codePoints: [...codePoints].sort((a, b) => a - b),
    /** 每份归档各自用到的**文字系统**归类结果（下面 classify 填） */
    sampleNames: [...texts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([s, n]) => [s, n]),
  };
  writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------- 文字系统归类
/**
 * 极简脚本判定：只用来**分组观察**，不作为结论。
 * 结论一律以「码位是否被某族的 fontsource 子集覆盖」为准（那才是渲染时的真实判据）。
 */
const SCRIPT_RANGES = [
  ["CJK 汉字", 0x3400, 0x9fff],
  ["CJK 扩展A/B", 0x20000, 0x2ffff],
  ["假名（日）", 0x3040, 0x30ff],
  ["谚文（韩）", 0xac00, 0xd7af],
  ["谚文音节（韩）", 0x1100, 0x11ff],
  ["西里尔（俄/蒙）", 0x0400, 0x04ff],
  ["西里尔补充", 0x0500, 0x052f],
  ["泰文", 0x0e00, 0x0e7f],
  ["老挝文", 0x0e80, 0x0eff],
  ["高棉文", 0x1780, 0x17ff],
  ["缅甸文", 0x1000, 0x109f],
  ["阿拉伯文", 0x0600, 0x06ff],
  ["拉丁（基本）", 0x0020, 0x007f],
  ["拉丁扩展", 0x00a0, 0x024f],
  ["标点/符号", 0x2000, 0x206f],
];

function classify(cps) {
  const buckets = new Map();
  const rest = [];
  for (const cp of cps) {
    const hit = SCRIPT_RANGES.find(([, lo, hi]) => cp >= lo && cp <= hi);
    if (hit) buckets.set(hit[0], (buckets.get(hit[0]) ?? 0) + 1);
    else rest.push(cp);
  }
  return { buckets, rest };
}

// ---------------------------------------------------------------- 主流程
const argv = process.argv.slice(2);
let jsonOut = null;
const archives = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") jsonOut = argv[++i];
  else archives.push(argv[i]);
}
const targets = archives.length ? archives : DEFAULT_ARCHIVES;

console.log("=== 阶段56-B：扫底图归档 places 码位（T7 前置）===\n");
const results = [];
for (const a of targets) {
  console.log(`▶ ${a}`);
  const r = await scanArchive(a);
  results.push(r);
  console.log(
    `  瓦片 ${r.tiles}，带名要素 ${r.named}，去重地名 ${r.distinctNames}，码位 ${r.codePoints.length}\n`,
  );
}

// ---- 合并（并集：字形子集要覆盖**所有**归档里会出现的地名）----
const all = new Set();
for (const r of results) for (const cp of r.codePoints) all.add(cp);
const merged = [...all].sort((a, b) => a - b);
const { buckets, rest } = classify(merged);

console.log("=== 六份归档的**并集** ===");
console.log(`码位合计 ${merged.length} 个\n`);
console.log("按文字系统分组（仅用于观察，不是结论）：");
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${v}`);
}
console.log(`  ${"未归类".padEnd(18)} ${rest.length}`);
if (rest.length) {
  console.log(
    `    未归类样本：${rest.slice(0, 30).map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`,
  );
}

console.log("\n每份归档各用什么文字（看「哪份贡献了哪种文字」）：");
for (const r of results) {
  const c = classify(r.codePoints);
  const top = [...c.buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  console.log(`  ${r.archive.padEnd(44)} ${top}`);
}

// ---- 关键一问：谚文 / 假名 / 泰文 / 西里尔 的实际码位数 ----
const KEY_SCRIPTS = ["谚文（韩）", "假名（日）", "泰文", "西里尔（俄/蒙）", "西里尔补充"];
console.log("\n=== 设计 §6.2 关心的四类文字（决定要不要加族）===");
for (const s of KEY_SCRIPTS) {
  console.log(`  ${s.padEnd(18)} ${buckets.get(s) ?? 0} 个码位`);
}

if (jsonOut) {
  const outPath = resolve(ROOT, jsonOut);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedBy: "scripts/scan_place_codepoints.mjs",
        nameKeys: NAME_KEYS,
        archives: results.map((r) => ({
          archive: r.archive,
          bytes: r.bytes,
          tiles: r.tiles,
          named: r.named,
          distinctNames: r.distinctNames,
          codePointCount: r.codePoints.length,
          buckets: Object.fromEntries(classify(r.codePoints).buckets),
        })),
        merged: { codePointCount: merged.length, buckets: Object.fromEntries(buckets), codePoints: merged },
      },
      null,
      2,
    ),
  );
  console.log(`\n机器可读结果 → ${jsonOut}`);
}

// 给下游（fetch_glyphs.mjs）一个稳定的哈希，便于判断「码位集合是否变过」
console.log(
  `\n码位集合指纹：${createHash("sha256").update(merged.join(",")).digest("hex").slice(0, 16)}`,
);
