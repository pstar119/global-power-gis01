#!/usr/bin/env node
/**
 * 阶段27 → 阶段56-B（T7）：为离线底图准备**多文种**字形子集。
 *
 * 用法：
 *   node scripts/fetch_glyphs.mjs --estimate-only
 *   node scripts/fetch_glyphs.mjs
 *
 * ============================================================
 * 为什么不下载整套 Noto
 * ============================================================
 * 完整 Noto Sans SC 约 10 MB。本项目只需要渲染**底图 places 图层里那几个地名**，
 * 所以这里做的是「按需取子集」：
 *
 *   1. 把切好的离线底图归档解开，解出 `places` 图层每个要素的
 *      `name:zh-Hans` / `name:zh-Hant` / `name:en` / `name`（与前端 label 的 coalesce 顺序一致）；
 *   2. 统计这些文本用到的所有 Unicode 码位（**跨多份归档取并集**，见 `DEFAULT_ARCHIVES`）；
 *   3. 拉取 fontsource 的 `400.css`，它把字体按 **unicode-range** 切成若干子集，
 *      每个子集都标注了自己覆盖的码位区间；
 *   4. **只下载与「用到的码位」相交的子集**（其余一律不取）。
 *
 * 实测（阶段27，仅中国那份底图）：101 个子集里只命中 86 个 → 2.1 MB。
 *
 * ============================================================
 * 🔴 阶段56-B（T7）：为什么是「多族」而不是「一族更大的」
 * ============================================================
 * 加了邻国之后，底图归档从 1 份变成 6 份，`places` 里出现了中国那份扫不到的文字。
 * **实测**（`scripts/scan_place_codepoints.mjs` + `scripts/glyph_coverage.mjs`，
 * 6 份归档并集 1959 个码位）：
 *
 *   | 族 | 单独覆盖 | 在上面的基础上新增 |
 *   |---|---|---|
 *   | Noto Sans SC | 1913 / 1959 | 1913 |
 *   | Noto Sans KR | 1299 / 1959 | **0** |
 *   | Noto Sans JP | 1560 / 1959 | **1**（U+59F6，一个罕见汉字） |
 *   | Noto Sans Thai | 98 / 1959 | **0** |
 *   | Noto Sans | 178 / 1959 | **9**（哈萨克/蒙古语西里尔字母） |
 *
 * ⇒ 裁定（2026-09-25，用户拍板）：
 *   · **只加 `Noto Sans`**（西里尔，设计 §6.2 第 4 条要求"扫码位判断缺则加"，实测确实缺 9 个）；
 *   · **不加 KR / JP / Thai**——实测谚文 0 个码位、假名 0 个、泰文 0 个，
 *     加了收益是 0~1 个码位、代价是 +1~3 MB 进安装包。
 *     设计 §6.2 第 2 条原来写的"先加 KR / JP / Thai 三族"是**基于假设**（以为会出现这些文字），
 *     扫描结果推翻了它。日韩的地名在这份数据里走的是 `name:en` 兜底（拉丁字母）。
 *   · 加完两族后仍**有 37 个码位无任何子集覆盖**（阿拉伯文、老挝文、缅甸文、
 *     越南语扩展区、以及 4 个罕见汉字 + 1 个私人使用区码位）⇒ 那些地名靠 `name:en` 兜底，
 *     这是数据现状，不是缺陷。
 *
 * ============================================================
 * MapLibre 侧的真实契约（决定了本脚本的输出形状）
 * ============================================================
 * `FontFaceManager.setFontFaces()`（`node_modules/maplibre-gl/src/render/font_face_manager.ts`）
 * 逐条做的是：把每个 font-face **直接 `new FontFace(...)` 交给 CSS Font Loading API**，
 * 自己另起一个内部族名（`maplibre-gl-font-face-<n>`）——**不读任何 CSS 文件、也不用文件里的字体族名**。
 * 取值时 `getFontFamily(fontStack, codePoint)` 按 `text-font` 的每个名字依次找
 * 「第一个 unicode-range 覆盖该码位的 face」。
 *
 * ⇒ 三条结论，直接决定下面的实现：
 *   1. **不需要产出 / 注入任何 CSS 文件**（阶段27 留在这里的 `@font-face` 写法是多余的，
 *      已删除）。`font-faces` 的**键**才是 `text-font` 里的名字。
 *   2. **多族 = 多键**：`font-faces` 是 `Record<族名, face[]>`，天然支持多族。
 *   3. **族之间靠 `text-font` 的先后顺序回退**：`["Noto Sans SC Offline", "Noto Sans Offline"]`
 *      ⇒ 先在 SC 里找覆盖该码位的子集，找不到才走 Noto Sans。所以 SC 必须排前面
 *      （它覆盖 1913 个，几乎全是汉字），Noto Sans 排后面兜西里尔。
 *
 * ============================================================
 * 产物
 * ============================================================
 *   public/fonts/<pkg>/*.woff2         ← 字体子集（已 gitignore，可重建）
 *   src/lib/basemapFonts.generated.ts  ← font-faces 清单 + 字体栈（进 Git）
 *
 * 清单进 Git 的好处：全新克隆不跑本脚本也能正常编译运行 —— 只是字体文件缺失时
 * MapLibre 会打一条警告并回退到 `glyphs`/系统字体，而不是直接崩。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 要扫的归档。**必须包含随安装包分发的那份核心底图**（`src-tauri/resources/maps/basemap.pmtiles`）——
 * 它是国内标签的来源，漏了就可能在换族时把国内的覆盖弄丢（那是**静默**的缺字）。
 *
 * ⚠️ 邻国那 5 份是 `data/packs/`（gitignore 的构建产物）。缺失时**不报错、只告警**：
 *    全新克隆里一个都没有，而这时应该退回「只按核心底图裁」的旧行为，而不是让脚本失败。
 */
const DEFAULT_ARCHIVES = [
  "src-tauri/resources/maps/basemap.pmtiles",
  "data/packs/basemap-kp-kr.pmtiles",
  "data/packs/basemap-mn.pmtiles",
  "data/packs/basemap-sea-mainland.pmtiles",
  "data/packs/basemap-ca.pmtiles",
  "data/packs/basemap-ru-far.pmtiles",
];

/**
 * 字体族配置（阶段56-B：从单一常量改为数组）。
 *
 * 每族的字段：
 *   · `pkg`      —— fontsource 的 npm 包名（同时是 CDN 路径段）
 *   · `family`   —— 写进 `font-faces` 键、并被 `text-font` 引用的名字
 *   · `outDir`   —— 字体文件输出目录（相对项目根）
 *
 * ⚠️ `family` 用 `<包名> Offline` 这种**自造名**，与 fontsource CSS 里的字体族名无关
 *    （MapLibre 不看 CSS，见文件头）。带 `Offline` 是为了在调试时一眼看出
 *    「这是本地自带的那一份」，而不是系统装的同名字体。
 * ⚠️ **顺序即回退顺序**：`text-font` 按这个顺序拼。SC 覆盖 1913/1959 个码位，
 *    必须排最前；Noto Sans 只兜它剩不下的西里尔。
 */
const FAMILIES = [
  {
    pkg: "noto-sans-sc",
    family: "Noto Sans SC Offline",
    outDir: "public/fonts/noto-sans-sc",
    note: "汉字（1913/1959 个码位）",
  },
  {
    pkg: "noto-sans",
    family: "Noto Sans Offline",
    outDir: "public/fonts/noto-sans",
    note: "西里尔补充（实测新增 9 个码位；KR/JP/Thai 实测新增 0~1 个，已裁定不加）",
  },
];

/** fontsource 的子集清单地址（按 400 字重；底图标签只用常规体） */
const cssUrlOf = (pkg) => `https://cdn.jsdelivr.net/npm/@fontsource/${pkg}/400.css`;
/** 子集文件下载基址 */
const cdnBaseOf = (pkg) => `https://cdn.jsdelivr.net/npm/@fontsource/${pkg}/files/`;

const DEFAULTS = {
  archives: DEFAULT_ARCHIVES,
  /** 生成的清单（相对项目根） */
  manifest: "src/lib/basemapFonts.generated.ts",
  estimateOnly: false,
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--archive") {
      // 允许重复传：--archive a --archive b
      if (cfg.archives === DEFAULTS.archives) cfg.archives = [];
      cfg.archives.push(next());
    } else if (a === "--archives") cfg.archives = next().split(",");
    else if (a === "--manifest") cfg.manifest = next();
    else if (a === "--estimate-only") cfg.estimateOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: node scripts/fetch_glyphs.mjs [选项]",
          "",
          "  --archive <path>    底图归档（可重复；默认扫 " + DEFAULT_ARCHIVES.length + " 份）",
          "  --archives a,b,c    同上，逗号分隔",
          "  --manifest <path>   font-faces 清单输出（默认 " + DEFAULTS.manifest + "）",
          "  --estimate-only     只统计需要哪些子集与总体积，不下载",
          "",
          "字体族定义在脚本顶部的 FAMILIES（顺序 = text-font 的回退顺序）。",
          "先跑 node scripts/scan_place_codepoints.mjs + scripts/glyph_coverage.mjs 再改它。",
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
      layers.push({ name, keys, values, featureTags });
    } else r.skip(wire);
  }
  return layers;
}

// ============================================================
// 2. 扫归档，收集会被渲染的文本
// ============================================================

/**
 * 与前端 label 的 coalesce 顺序必须一致。
 * `name:en` 是必要的兜底：实测有若干码位（阿拉伯文 / 老挝文 / 缅甸文等）
 * 没有任何候选族的子集覆盖，没有英文兜底时那些地名会是空白。
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
          if (layer.name !== "places") continue; // 只有这一层会被渲染成文字
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

async function loadSubsets(pkg) {
  const cssUrl = cssUrlOf(pkg);
  const res = await fetch(cssUrl);
  if (!res.ok) throw new Error(`拉取字体 CSS 失败：HTTP ${res.status} ${cssUrl}`);
  const css = await res.text();
  const re = /url\(\.\/files\/([^)]+\.woff2)\)[\s\S]*?unicode-range:\s*([^;]+);/g;
  const subsets = [];
  for (const m of css.matchAll(re)) {
    subsets.push({ file: m[1], ranges: parseUnicodeRange(m[2]) });
  }
  if (subsets.length === 0) throw new Error(`CSS 里没有解析到任何 woff2 子集，格式可能变了：${cssUrl}`);
  return subsets;
}

/** fontsource 的子集文件名自带文字系统，如 `noto-sans-cyrillic-400-normal.woff2` */
function subsetScriptLabel(file) {
  const m = /^noto-sans(?:-sc)?-([a-z0-9-]+?)-\d+-normal\.woff2$/.exec(file);
  return m ? m[1] : file;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("=== 阶段56-B（T7）：准备离线底图的多文种字形 ===");
  console.log(`字体族    : ${FAMILIES.map((f) => `${f.family}（${f.pkg}，${f.note}）`).join(" + ")}`);
  console.log(`扫描归档  : ${cfg.archives.length} 份`);

  // ---- 扫全部归档，取**并集**：字形子集要覆盖所有会出现的地名 ----
  const allTexts = new Map();
  let totalTiles = 0;
  let totalFeatures = 0;
  const missing = [];
  for (const a of cfg.archives) {
    const abs = resolve(ROOT, a);
    if (!existsSync(abs)) {
      missing.push(a);
      console.log(`  ⚠️ 跳过（不存在）：${a}`);
      continue;
    }
    const { texts, tiles, features, withName } = await collectUsedText(abs);
    totalTiles += tiles;
    totalFeatures += features;
    for (const [t, n] of texts) allTexts.set(t, (allTexts.get(t) ?? 0) + n);
    console.log(
      `  ✔ ${a}\n      瓦片 ${tiles}，要素 ${features}（带名 ${withName}），去重地名 ${texts.size}`,
    );
  }
  if (!allTexts.size) {
    throw new Error("一份归档都没扫到（都用 --archive 指定了吗？）");
  }
  if (missing.length) {
    console.log(
      `\n⚠️ 有 ${missing.length} 份归档不存在，本次**只按剩下的 ${cfg.archives.length - missing.length} 份**裁字形。\n` +
        "   邻国底图包是 gitignore 的构建产物（全新克隆里没有）—— 那是正常的；\n" +
        "   但若你刚跑完 T8 却看到这条告警，说明清单/路径对不上，请核对。",
    );
  }

  const codePoints = new Set();
  for (const t of allTexts.keys()) for (const ch of t) codePoints.add(ch.codePointAt(0));
  console.log(
    `\n合计：瓦片 ${totalTiles}，要素 ${totalFeatures}，` +
      `去重地名 ${allTexts.size}，**用到的不同码位 ${codePoints.size} 个**`,
  );

  // ---- 逐族裁子集 ----
  console.log("\n按族裁子集：");
  const perFamily = [];
  for (const fam of FAMILIES) {
    const subsets = await loadSubsets(fam.pkg);
    const hits = [];
    for (const s of subsets) {
      const used = [...codePoints].filter((cp) => s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi));
      if (used.length > 0) hits.push({ ...s, used });
    }
    const covered = new Set(hits.flatMap((h) => h.used));
    perFamily.push({ ...fam, subsets, hits, covered });
    console.log(
      `  ${fam.family.padEnd(24)} 命中 ${String(hits.length).padStart(3)} / ${subsets.length} 个子集，` +
        `覆盖 ${covered.size} / ${codePoints.size} 个码位`,
    );
    for (const h of hits) {
      console.log(
        `      ${h.file.padEnd(46)} ${subsetScriptLabel(h.file).padEnd(14)} 用到 ${String(h.used.length).padStart(4)} 个码位`,
      );
    }
  }

  // ---- 逐族**新增**覆盖：这就是「留着这一族到底值不值」的实测答案 ----
  console.log("\n逐族新增覆盖（按 FAMILIES 的顺序累加 —— 顺序就是 text-font 的回退顺序）：");
  const union = new Set();
  for (const f of perFamily) {
    const fresh = [...f.covered].filter((cp) => !union.has(cp));
    for (const cp of f.covered) union.add(cp);
    console.log(
      `  + ${f.family.padEnd(24)} 新增 ${String(fresh.length).padStart(4)} 个码位` +
        (fresh.length && fresh.length <= 24
          ? `   样本：${fresh.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`
          : ""),
    );
  }

  const uncovered = [...codePoints].filter((cp) => !union.has(cp));
  console.log(
    `\n覆盖合计：${union.size} / ${codePoints.size} 个码位；` +
      `**无任何族覆盖 ${uncovered.length} 个**`,
  );
  if (uncovered.length) {
    console.log(
      `  ${uncovered.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}\n` +
        "  ⇒ 这些地名在图上会缺字。它们正是 `name:en` 兜底存在的原因（不是缺陷，是数据现状）。",
    );
  }

  // ---- 体积试算 ----
  //
  // ‼️ 用 **GET 读长度**，不要用 HEAD + `content-length`：实测 jsDelivr 对 fontsource 的
  //    woff2 返回的 HEAD **不带** content-length（长度恒为 0），于是试算会打印
  //    「字体合计 0.0 KB」这种会让人误判红线的数字 —— 而它**不报错**。
  //    代价是多下一次 2.3 MB 的正文；相比「体积报错导致误判 50 MB 红线」，这个代价划算。
  const allHits = perFamily.flatMap((f) => f.hits.map((h) => ({ ...h, family: f.family, pkg: f.pkg })));
  /** 「包名 + 文件名」→ 已下载正文。⚠️ 写盘时要用它，不能用 `f.hits[i].buf`：
   *  `allHits` 是另一个对象的数组，给它赋值不会回写 `f.hits`（实测踩到 ERR_INVALID_ARG_TYPE）。 */
  const byFile = new Map();
  let total = 0;
  for (const h of allHits) {
    const res = await fetch(cdnBaseOf(h.pkg) + h.file);
    if (!res.ok) throw new Error(`试算时下载失败：HTTP ${res.status} ${h.file}`);
    const buf = Buffer.from(await res.arrayBuffer());
    h.bytes = buf.length;
    byFile.set(`${h.pkg}/${h.file}`, buf);
    total += buf.length;
  }
  console.log(
    `\n字体合计 : ${(total / 1024).toFixed(1)} KB = **${(total / 1048576).toFixed(2)} MB**` +
      `（${allHits.length} 个文件）`,
  );
  for (const f of perFamily) {
    const sub = f.hits.reduce(
      (s, h) => s + (byFile.get(`${f.pkg}/${h.file}`)?.length ?? 0),
      0,
    );
    console.log(`  ${f.family.padEnd(24)} ${(sub / 1024).toFixed(1)} KB（${f.hits.length} 个文件）`);
  }
  if (cfg.estimateOnly) {
    console.log("\n[试算模式] 未写盘（上面的字节数是真实 GET 读到的，可以直接拿来对红线）。\n");
    return;
  }

  // ---- 写盘 ----
  console.log("\n写盘中…");
  for (const f of perFamily) {
    const outDir = resolve(ROOT, f.outDir);
    mkdirSync(outDir, { recursive: true });
    for (const h of f.hits) {
      const buf = byFile.get(`${f.pkg}/${h.file}`);
      if (!buf) throw new Error(`内部错误：${f.pkg}/${h.file} 没有下载正文`);
      writeFileSync(join(outDir, h.file), buf);
      console.log(`  ${h.file.padEnd(46)} ${(buf.length / 1024).toFixed(1)} KB`);
    }
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

  const familyEntries = perFamily.map((f) => [
    f.family,
    f.hits.map((h) => ({
      url: `/${f.outDir.replace(/^public\//, "")}/${h.file}`,
      "unicode-range": h.ranges.map(toSpec),
    })),
  ]);
  const familyFiles = perFamily.map((f) => [
    f.family,
    f.hits.map((h) => `/${f.outDir.replace(/^public\//, "")}/${h.file}`),
  ]);

  const manifestPath = resolve(ROOT, cfg.manifest);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    [
      "// ⚠️ 本文件由 `node scripts/fetch_glyphs.mjs` 自动生成，请勿手改。",
      "//",
      "// 内容是 MapLibre 样式根属性 `font-faces` 的取值（**多族**）：MapLibre 会把每个 face",
      "// 直接交给浏览器的 CSS Font Loading API 本地渲染（它自己另起内部族名，**不读 CSS 文件**），",
      "// 取值时按 `text-font` 里的名字依次找「第一个 unicode-range 覆盖该码位的 face」——",
      "// 所以族之间的回退顺序就是 BASEMAP_TEXT_FONT 的数组顺序。",
      "//",
      "// 字体文件本身（public/fonts/…）已被 .gitignore 忽略，可随时用脚本重建；",
      "// 但清单本身进 Git —— 缺字体时 MapLibre 只会告警并回退，不会崩。",
      "",
      "/** 主族（汉字）：`text-font` 的第一项，也是 `font-faces` 的第一个键 */",
      `export const BASEMAP_FONT_FAMILY = ${JSON.stringify(perFamily[0].family)};`,
      "",
      "/**",
      " * 「文字栈」—— `text-font` 直接用它。",
      " * ⚠️ 顺序 = 回退顺序（MapLibre 按顺序找第一个覆盖该码位的族）。",
      " * ⚠️ 这份清单由 `FAMILIES` 的顺序决定；阶段56-B 实测裁掉了 KR / JP / Thai",
      " *    （谚文/假名/泰文在 6 份底图归档里各 0 个码位，加了净收益 0~1 个）。",
      " */",
      `export const BASEMAP_TEXT_FONT: string[] = ${JSON.stringify(perFamily.map((f) => f.family))};`,
      "",
      "/** font-faces 的**键**必须与 `text-font`（BASEMAP_TEXT_FONT）里的名字完全一致 */",
      "export const BASEMAP_FONT_FACES: Record<string, Array<{ url: string; \"unicode-range\": string[] }>> = {",
      ...familyEntries.map(
        ([fam, faces]) =>
          `  ${JSON.stringify(fam)}: ${JSON.stringify(faces, null, 2).replace(/\n/g, "\n  ").replace(/^ {2}/, "")},`,
      ),
      "};",
      "",
      "/** 生成的字体文件相对 public/ 的路径，按族分组，供校验用 */",
      "export const BASEMAP_FONT_FILES: Record<string, string[]> = {",
      ...familyFiles.map(([fam, files]) => `  ${JSON.stringify(fam)}: ${JSON.stringify(files)},`),
      "};",
      "",
    ].join("\n"),
  );

  console.log(`\n清单已写出 : ${cfg.manifest}（${familyEntries.length} 族 / ${allHits.length} 条 font-face）`);
  console.log(`字体目录   : ${perFamily.map((f) => f.outDir).join("  ")}（合计 ${(total / 1024).toFixed(1)} KB）`);

  // ---- 清理孤儿文件 ----
  //
  // ‼️ 为什么必须清：`.woff2` 被 gitignore 忽略，所以**没人会发现**上一次下载留下的文件。
  //    而码位集合一变（加了邻国底图、或换底图源），命中的子集就会变 ——
  //    旧的子集文件会静默留在 public/ 并被打进安装包（本阶段的红线正是安装包 ≤ 50 MB）。
  //    实测踩到过一次：`noto-sans-sc-28-400-normal.woff2` 在换成 6 份归档的并集后不再命中，
  //    却还留在目录里。
  const liveFiles = new Set(allHits.map((h) => `${h.pkg}/${h.file}`));
  let removed = 0;
  for (const f of perFamily) {
    const outDir = resolve(ROOT, f.outDir);
    for (const entry of readdirSync(outDir)) {
      if (!entry.endsWith(".woff2")) continue;
      if (liveFiles.has(`${f.pkg}/${entry}`)) continue;
      rmSync(join(outDir, entry));
      removed++;
      console.log(`  （清理孤儿子集）${entry}`);
    }
  }
  if (removed) console.log(`cleanup    : 删掉 ${removed} 个不再命中的子集文件`);

  console.log("\n✅ 完成。\n");
}

if (!cfg) {
  // --help
} else {
  main().catch((err) => {
    console.error(`\n❌ ${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
}
