#!/usr/bin/env node
/**
 * 阶段27：为离线底图准备中文字形。
 *
 * 用法：
 *   node scripts/fetch_glyphs.mjs --estimate-only
 *   node scripts/fetch_glyphs.mjs
 *
 * ============================================================
 * 为什么不是「下载一整个 Noto Sans SC」
 * ============================================================
 * 完整 Noto Sans SC 约 10 MB。本项目只需要渲染**底图 places 图层里那几个地名**，
 * 所以这里做的是「按需取子集」：
 *
 *   1. 把切好的离线底图归档解开，解出 `places` 图层每个要素的
 *      `name:zh-Hans` / `name:zh-Hant` / `name`（与前端 label 的 coalesce 顺序一致）；
 *   2. 统计这些文本用到的所有 Unicode 码位；
 *   3. 拉取 fontsource 的 `400.css`，它把 Noto Sans SC 按 **unicode-range**
 *      切成了 101 个子集，每个子集都标注了自己覆盖的码位区间；
 *   4. **只下载与「用到的码位」相交的子集**（其余一律不取）。
 *
 * 实测：全部 101 个子集约 4 MB，而实际命中的只有个位数，体积小一个数量级。
 *
 * ============================================================
 * 产物
 * ============================================================
 *   public/fonts/noto-sans-sc/*.woff2            ← 字体子集（已 gitignore，可重建）
 *   src/lib/basemapFonts.generated.ts            ← 生成的 `font-faces` 清单（进 Git）
 *
 * 清单进 Git 的好处：全新克隆不跑本脚本也能正常编译运行 —— 只是字体文件缺失时
 * MapLibre 会打一条警告并回退到 `glyphs`/系统字体，而不是直接崩。
 *
 * ============================================================
 * 为什么不直接用一个 CDN 的 glyphs URL
 * ============================================================
 * Protomaps 的 `basemaps-assets` 只提供 Noto Sans Regular/Medium/Italic / Devanagari，
 * **没有 CJK 字体栈**（实测取 CJK 码位区间返回 29 字节的空字形）。
 * 而 MapLibre v6 的 `font-faces` 样式属性会把字体文件交给浏览器的 CSS Font Loading API，
 * 本地渲染、完全离线，比走字形服务器更合适。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  archive: "src-tauri/resources/maps/basemap.pmtiles",
  /** fontsource 的 CSS 是按字重分的；底图标签只用常规体 */
  css: "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/400.css",
  cdnBase: "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/files/",
  /** 字体文件放 public 下：Vite dev 与打包后的 tauri.localhost 都能直接取到 */
  outDir: "public/fonts/noto-sans-sc",
  /** 生成的 font-faces 清单（相对项目根） */
  manifest: "src/lib/basemapFonts.generated.ts",
  /** 样式里的字体栈名，前端 `text-font` 必须与它一致 */
  family: "Noto Sans SC Offline",
  estimateOnly: false,
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--archive") cfg.archive = next();
    else if (a === "--out-dir") cfg.outDir = next();
    else if (a === "--manifest") cfg.manifest = next();
    else if (a === "--estimate-only") cfg.estimateOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: node scripts/fetch_glyphs.mjs [选项]",
          "",
          "  --archive <path>   底图归档（默认 " + DEFAULTS.archive + "）",
          "  --out-dir <path>   字体输出目录（默认 " + DEFAULTS.outDir + "）",
          "  --manifest <path>  font-faces 清单输出（默认 " + DEFAULTS.manifest + "）",
          "  --estimate-only    只统计需要哪些子集与总体积，不下载",
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));

// ============================================================
// 1. MVT 解码（这次必须真解 tags）
// ============================================================

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
        // ⚠️ 独立两条语句：`pos += this.varint()` 是错的（复合赋值先读 pos 旧值，
        //    而 varint 自身也会推进游标 → 长度字段本身占的字节被吞掉、静默错位）
        const n = this.varint();
        const packed = isPackedTag ? bytes.subarray(pos, pos + n) : null;
        pos += n; // ⚠️ 必须真的推进游标，否则后续字段全部错位
        return packed;
      } else if (wire === 5) pos += 4;
      else throw new Error(`不支持的 wire type: ${wire}`);
    },
  };
}

/** MVT 的 Value 是 protobuf oneof：1=string 2=float 3=double 4=int 5=uint 6=sint 7=bool */
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

function decodeLayer(bytes) {
  const r = cursor(bytes);
  const keys = [];
  const values = [];
  const featureTags = [];
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) r.take(r.varint()); // layer name
    else if (field === 2 && wire === 2) featureTags.push(decodeFeatureTags(r.take(r.varint())));
    else if (field === 3 && wire === 2) keys.push(Buffer.from(r.take(r.varint())).toString("utf8"));
    else if (field === 4 && wire === 2) values.push(decodeValue(r.take(r.varint())));
    else r.skip(wire);
  }
  return { keys, values, featureTags };
}

/** Feature 的 tags 是 packed uint32，两两一组 = (keyIndex, valueIndex) */
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

function decodeMvtLayers(buf) {
  const r = cursor(new Uint8Array(buf));
  const layers = [];
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 3 && wire === 2) layers.push(decodeLayer(r.take(r.varint())));
    else r.skip(wire);
  }
  return layers;
}

// ============================================================
// 2. 扫归档，收集会被渲染的文本
// ============================================================

/**
 * 与前端 label 的 coalesce 顺序必须一致。
 * `name:en` 是必要的兜底：实测有 175 个码位（加拿大原住民音节文字等）
 * 没有任何 fontsource 子集覆盖，没有英文兜底时那些地名会是空白。
 */
const NAME_KEYS = ["name:zh-Hans", "name:zh-Hant", "name:en", "name"];

async function collectUsedText(archivePath) {
  const raw = readFileSync(archivePath);
  const pm = new PMTiles({
    async getBytes(offset, length) {
      return { data: raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + length) };
    },
    getKey: () => "glyph-scan",
  });

  const header = await pm.getHeader();

  const texts = new Map(); // text -> 出现次数
  let tiles = 0;
  let features = 0;
  let withName = 0;

  for (let z = header.minZoom; z <= header.maxZoom; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const t = await pm.getZxy(z, x, y);
        if (!t) continue;
        tiles++;
        for (const layer of decodeMvtLayers(Buffer.from(t.data))) {
          // layer 名在 keys 之前就解出来了，但这里只需要 places
          for (const tags of layer.featureTags) {
            features++;
            let chosen = null;
            for (const k of NAME_KEYS) {
              const ki = layer.keys.indexOf(k);
              if (ki < 0) continue;
              const vi = tags.get(ki);
              if (vi == null) continue;
              const v = layer.values[vi];
              if (typeof v === "string" && v.length > 0) {
                chosen = v;
                break;
              }
            }
            if (chosen) {
              withName++;
              texts.set(chosen, (texts.get(chosen) ?? 0) + 1);
            }
          }
        }
      }
    }
  }

  return { texts, tiles, features, withName, header };
}

// ============================================================
// 3. 解析 fontsource 的 CSS，得到「子集 → unicode-range」
// ============================================================

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

async function loadSubsets(cssUrl) {
  const res = await fetch(cssUrl);
  if (!res.ok) throw new Error(`拉取字体 CSS 失败：HTTP ${res.status} ${cssUrl}`);
  const css = await res.text();
  const re = /url\(\.\/files\/([^)]+\.woff2)\)[\s\S]*?unicode-range:\s*([^;]+);/g;
  const subsets = [];
  for (const m of css.matchAll(re)) {
    subsets.push({ file: m[1], ranges: parseUnicodeRange(m[2]) });
  }
  if (subsets.length === 0) throw new Error("CSS 里没有解析到任何 woff2 子集，格式可能变了");
  return subsets;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("=== 阶段27：准备离线中文字形 ===");
  console.log(`归档      : ${cfg.archive}`);

  const archivePath = resolve(ROOT, cfg.archive);
  statSync(archivePath); // 不存在就直接抛错，别等半天

  console.log("\n扫描 places 图层，收集实际会被渲染的地名…");
  const { texts, tiles, features, withName, header } = await collectUsedText(archivePath);
  console.log(`  瓦片 ${tiles} 个，要素 ${features} 个，其中带名字的 ${withName} 个`);
  console.log(`  去重后不同地名 ${texts.size} 个`);

  const codePoints = new Set();
  for (const t of texts.keys()) for (const ch of t) codePoints.add(ch.codePointAt(0));
  console.log(`  用到的不同码位 ${codePoints.size} 个`);

  console.log("\n拉取 fontsource 子集清单…");
  const subsets = await loadSubsets(cfg.css);
  console.log(`  共 ${subsets.length} 个子集`);

  const hits = [];
  for (const s of subsets) {
    const used = [...codePoints].filter((cp) => s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi));
    if (used.length > 0) hits.push({ ...s, used });
  }
  const covered = new Set(hits.flatMap((h) => h.used));
  const uncovered = [...codePoints].filter((cp) => !covered.has(cp));

  console.log("\n命中的子集：");
  for (const h of hits) {
    console.log(`  ${h.file.padEnd(38)} 用到 ${String(h.used.length).padStart(4)} 个码位`);
  }
  console.log(
    `\n命中 ${hits.length} / ${subsets.length} 个子集；覆盖 ${covered.size} / ${codePoints.size} 个码位`,
  );
  if (uncovered.length > 0) {
    const sample = uncovered.slice(0, 20).map((cp) => `U+${cp.toString(16).toUpperCase()}`);
    console.log(
      `⚠️ 有 ${uncovered.length} 个码位没有任何子集覆盖（多半是罕见字/emoji），` +
        `如 ${sample.join(" ")} —— 这些字在图上会缺字。`,
    );
  }

  // ---- 体积试算 ----
  let total = 0;
  for (const h of hits) {
    const res = await fetch(cfg.cdnBase + h.file, { method: "HEAD" });
    const len = Number(res.headers.get("content-length") ?? 0);
    h.bytes = len;
    total += len;
  }
  console.log(`\n字体合计 : ${(total / 1024).toFixed(1)} KB`);
  if (cfg.estimateOnly) {
    console.log("[试算模式] 未下载任何文件。\n");
    return;
  }

  // ---- 下载 ----
  const outDir = resolve(ROOT, cfg.outDir);
  mkdirSync(outDir, { recursive: true });
  console.log("\n下载中…");
  for (const h of hits) {
    const res = await fetch(cfg.cdnBase + h.file);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${h.file}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(outDir, h.file), buf);
    console.log(`  ${h.file.padEnd(38)} ${(buf.length / 1024).toFixed(1)} KB`);
  }

  // ---- 生成 font-faces 清单 ----
  //
  // 🔴 `unicode-range` 数组里**每一项只能写一段范围**。
  // 样式规范的校验正则（style-spec 的 validate_font_faces）是：
  //     /^u\+(?:([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?|([0-9a-f]{0,5}\?{1,6}))$/i
  // 也就是说只接受 `U+26` / `U+0-10FFFF` / `U+4??` 这三种形态。
  // 而 fontsource 的 CSS 里是**逗号分隔的一长串**（一个子集动辄几百段），
  // 直接整体塞进一个数组元素会被判为非法 —— 而且不是「跳过这一条」，
  // 是**整份 font-faces 校验失败**，表现是地图上一个地名都不显示、
  // 控制台刷满 "invalid unicode range"。必须逐段拆开。
  const toSpec = ([lo, hi]) =>
    lo === hi ? `U+${lo.toString(16)}` : `U+${lo.toString(16)}-${hi.toString(16)}`;

  const faces = hits.map((h) => ({
    url: `/${cfg.outDir.replace(/^public\//, "")}/${h.file}`,
    "unicode-range": h.ranges.map(toSpec),
  }));

  const manifestPath = resolve(ROOT, cfg.manifest);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    [
      "// ⚠️ 本文件由 `node scripts/fetch_glyphs.mjs` 自动生成，请勿手改。",
      "//",
      "// 内容是 MapLibre 样式根属性 `font-faces` 的取值：把「离线中文字形」按",
      "// unicode-range 分片交给浏览器的 CSS Font Loading API 本地渲染。",
      "// 字体文件本身（public/fonts/…）已被 .gitignore 忽略，可随时用脚本重建；",
      "// 但清单本身进 Git —— 缺字体时 MapLibre 只会告警并回退，不会崩。",
      "",
      `export const BASEMAP_FONT_FAMILY = ${JSON.stringify(cfg.family)};`,
      "",
      "/** font-faces 的键必须与 symbol 图层的 text-font 完全一致 */",
      "export const BASEMAP_FONT_FACES: Record<string, Array<{ url: string; \"unicode-range\": string[] }>> = {",
      `  [BASEMAP_FONT_FAMILY]: ${JSON.stringify(faces, null, 2).replace(/\n/g, "\n  ").replace(/^ {2}/, "")},`,
      "};",
      "",
      `/** 生成的字体文件相对 public/ 的路径，供校验用 */`,
      "export const BASEMAP_FONT_FILES: string[] = [",
      ...hits.map((h) => `  ${JSON.stringify(`/fonts/noto-sans-sc/${h.file}`)},`),
      "];",
      "",
    ].join("\n"),
  );

  console.log(`\n清单已写出 : ${cfg.manifest}（${faces.length} 条 font-face）`);
  console.log(`字体目录   : ${cfg.outDir}（合计 ${(total / 1024).toFixed(1)} KB）`);
  console.log(`\n✅ 完成。\n`);
}

if (!cfg) {
  // --help
} else {
  main().catch((err) => {
    console.error(`\n❌ ${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
}
