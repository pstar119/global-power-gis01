/**
 * 阶段38：可选包体检 —— 低级别封顶到底丢了什么？
 *
 * 封顶策略承诺「按电压由高到低保留，低级别保住电网骨架」。这个承诺是**可证伪的**：
 *
 *   华东共 735+ 643 条、500-734 7,263 条（合计 7,906 < 20,000 上限，应全部保留），
 *   再由 220-499 补足到 20,000 ⇒ **z0 的 "<220" 应当恰好为 0**。
 *
 * 如果 z0 里出现了 <220 或者 735+ 少于 643，说明排序写错了，封顶必须返工。
 *
 * ⚠️ 低级别瓦片只保留 ftype+vclass 两个属性（见 build_pmtiles.mjs 的 fullPropsFromZoom），
 *    所以这里只能按 vclass 统计，看不到 voltage_kv。
 *
 * 用法：node scripts/verify_pack.mjs data/packs/osm-huadong.pmtiles
 */
import { readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PMTiles } from "pmtiles";

import { tileX, tileY } from "./lib/pmtiles-writer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYER = "grid";
const VCLASS_ORDER = ["735+", "500-734", "220-499", "<220", "unknown"];
/**
 * 与 run_pipeline.mjs 的默认值保持一致（--max-features-per-tile 20000 / --cap-below-zoom 8）。
 *
 * ⚠️ 曾经的断言写成了「至少一个级别必须触碰到 20000」——那是错的：
 *    华南、东北的瓦片本来就没到 2 万，封顶**没触发**才是期望结果。
 *    正确的不变量是「低级别瓦片**不超过**上限」，而不是「必须用满上限」。
 */
const LOWZOOM_CAP = 20000;
const LOWZOOM_CAP_FROM = 8;

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error("用法: node scripts/verify_pack.mjs <pack.pmtiles> [--zoom 0,4,6,12]");
    process.exitCode = 2;
    return;
  }
  const packPath = resolve(ROOT, rel);
  const zoomArg = process.argv.includes("--zoom")
    ? process.argv[process.argv.indexOf("--zoom") + 1]
    : "0,4,6,12";
  const zooms = zoomArg.split(",").map(Number);

  const raw = readFileSync(packPath);
  const pm = new PMTiles({
    getBytes(offset, length) {
      return Promise.resolve({
        data: raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + length),
      });
    },
    getKey: () => packPath,
  });
  const header = await pm.getHeader();

  /**
   * ‼️ 阶段42 修复：原先写的是 `const { VectorTile } = await import("@mapbox/vector-tile")`
   *    与 `const Pbf = pbfMod.default ?? pbfMod`。
   *
   *    但本项目装的 `pbf` 是**新版**：导出 `{ PbfReader, PbfWriter }`
   *    —— **既没有 default 导出，也没有名为 `Pbf` 的类**。
   *    于是 `new Pbf(buf)` 必抛 "Pbf is not a constructor"，
   *    而这个异常被下面那句 `catch { continue; }` **静默吞掉**，
   *    结果每一张瓦片都“解码失败”并跳过 ⇒ 要素计数恒为 0 ⇒
   *    「不丢数据」断言变成 0 >= 93559 的空断言。
   *    换句话说：**这个校验脚本自己失去了校验能力，而且不报错。**
   *
   *    另外瓦片是 **gzip 压缩** 的（header.tileCompression=2），
   *    必须先解压再交给 MVT 解码器。
   */
  const vtMod = await import("@mapbox/vector-tile");
  const VectorTile = vtMod.VectorTile ?? vtMod.default?.VectorTile ?? vtMod.default ?? vtMod;
  const pbfMod = await import("pbf");
  const PbfReader = pbfMod.PbfReader ?? pbfMod.default?.PbfReader ?? pbfMod.default ?? pbfMod;
  if (typeof VectorTile !== "function" || typeof PbfReader !== "function") {
    console.error(
      `无法解析 MVT 解码器：VectorTile=${typeof VectorTile} PbfReader=${typeof PbfReader}` +
        `（pbf 导出：${Object.keys(pbfMod).join(",")}）`,
    );
    process.exit(1);
  }

  console.log("=== 可选包体检 ===");
  console.log(`文件        : ${rel}`);
  console.log(`体积        : ${(statSync(packPath).size / 1048576).toFixed(2)} MB`);
  console.log(
    `header      : z${header.minZoom}-${header.maxZoom} tileType=${header.tileType} ` +
      `tileCompression=${header.tileCompression} addressed=${header.numAddressedTiles.toLocaleString()}`,
  );
  console.log();

  const results = [];
  /** 每个 ftype 实际出现过的属性键（用于校验属性白名单没漏字段） */
  const keysByType = { line: new Set(), substation: new Set(), plant: new Set() };
  /** ‼️ 解码失败必须计数而不能静默跳过 —— 阶段42 的「假断言」就是静默跳过造成的 */
  let decodeFailed = 0;
  let decodeErrMsg = null;
  for (const z of zooms) {
    const n = 1 << z;
    /**
     * ⚠️ 只遍历归档 bbox 覆盖到的瓦片，**不要**全量遍历 4^z。
     *    全量在 z12 就是 1670 万次查询 —— 我当时真这么写过一版，慢得没法用。
     *    header 里带了 bounds，直接拿它算 x/y 范围即可。
     */
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));
    const hasBounds = [header.minLon, header.minLat, header.maxLon, header.maxLat].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    );
    const xFrom = hasBounds ? clamp(tileX(header.minLon, z)) : 0;
    const xTo = hasBounds ? clamp(tileX(header.maxLon, z)) : n - 1;
    const yFrom = hasBounds ? clamp(tileY(header.maxLat, z)) : 0;
    const yTo = hasBounds ? clamp(tileY(header.minLat, z)) : n - 1;

    let tiles = 0;
    let feats = 0;
    let maxTileFeats = 0;
    let maxTileBytes = 0;
    let maxAt = "-";
    const hist = {};
    for (let x = xFrom; x <= xTo; x++) {
      for (let y = yFrom; y <= yTo; y++) {
        let r;
        try {
          r = await pm.getZxy(z, x, y);
        } catch {
          continue;
        }
        if (!r) continue;
        tiles++;
        const bytes = r.data.byteLength ?? r.data.length;
        if (bytes > maxTileBytes) {
          maxTileBytes = bytes;
          maxAt = `${x}/${y}`;
        }
        let vt;
        try {
          // ‼️ 先 gunzip：瓦片是 gzip 压缩的（header.tileCompression=2）
          let bytes = new Uint8Array(r.data);
          if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            bytes = gunzipSync(bytes);
          }
          vt = new VectorTile(new PbfReader(bytes));
        } catch (e) {
          // ‼️ 不再静默 continue：解码失败就直接让整个脚本失败。
          //    否则脚本会“全部通过”而实际什么都没检查到。
          decodeFailed++;
          if (!decodeErrMsg) decodeErrMsg = e && e.message ? e.message : String(e);
          continue;
        }
        const layer = vt.layers[LAYER];
        if (!layer) continue;
        feats += layer.length;
        if (layer.length > maxTileFeats) maxTileFeats = layer.length;
        for (let i = 0; i < layer.length; i++) {
          const p = layer.feature(i).properties ?? {};
          const k = p.vclass ?? "?";
          hist[k] = (hist[k] ?? 0) + 1;
          const t = p.ftype;
          if (keysByType[t]) for (const key of Object.keys(p)) keysByType[t].add(key);
        }
      }
    }
    results.push({ z, tiles, feats, maxTileFeats, maxTileBytes, maxAt, hist });
    const span = `${xFrom}..${xTo} x ${yFrom}..${yTo}`;
    const dist = VCLASS_ORDER.filter((k) => hist[k]).map((k) => `${k}=${hist[k]}`).join(" ");
    console.log(
      `z${String(z).padEnd(2)} 瓦片 ${String(tiles).padStart(6)}  要素 ${String(feats).padStart(7)}  ` +
        `最大单瓦片 ${String(maxTileFeats).padStart(6)} 要素 / ${(maxTileBytes / 1024).toFixed(1).padStart(7)} KB ` +
        `@ ${z}/${maxAt}`,
    );
    console.log(`      范围 ${span}   ${dist || "(无)"}`);
  }

  // ---- 断言 ----
  // ⚠️ 这里只断言「从归档本身能验证」的不变量。
  //    曾经写过「z0 的 735+ 应该全部保留（=643）」—— 那是错的：
  //    geojson-vt 在 z0 就已经丢弃了 77.6% 的要素（OSM 线路中位数只有 192 m，
  //    低级别简化后退化），z0 瓦片里本来就只有 20,960 个要素而不是 93,559 个。
  //    「封顶是否严格按电压优先」那个不变量需要封顶前的分布才能验，
  //    所以它在 scripts/diag_lowzoom.mjs 里验，不在这里。
  const deepest = results.reduce((a, b) => (b.z > a.z ? b : a), results[0]);

  // 源要素数：从 prepare 产出的 meta 读（可选包名 osm-<region>.pmtiles 对应 <region>_power_meta.json）
  const base = basename(packPath).replace(/^osm-/, "").replace(/\.pmtiles$/, "");
  let srcCount = null;
  try {
    srcCount = JSON.parse(
      readFileSync(resolve(ROOT, "public", "osm", `${base}_power_meta.json`), "utf8"),
    ).featureCount;
  } catch {
    srcCount = null;
  }

  console.log("\n=== 断言 ===");
  let ok = true;
  const checks = [];

  const biggest = results.reduce((a, b) => (b.maxTileBytes > a.maxTileBytes ? b : a), results[0]);
  if (biggest) {
    checks.push({
      断言: "抽样级别最大单瓦片 < 500 KB（MapLibre 经验上限）",
      实测: `${(biggest.maxTileBytes / 1024).toFixed(1)} KB @ z${biggest.z}`,
      通过: biggest.maxTileBytes < 500 * 1024,
    });
  }

  // 数据没在归档里丢：最深一级的总要素数应 >= 源要素数（要素跨瓦片会被复制，所以用 >=
  if (deepest && srcCount != null) {
    checks.push({
      断言: `最深级别 z${deepest.z} 的总要素数 >= 源要素数 ${srcCount}（归档里没有丢数据）`,
      实测: `${deepest.feats}`,
      通过: deepest.feats >= srcCount,
    });
  } else {
    console.log(`ℹ️ 未能读到源要素数（public/osm/${base}_power_meta.json），跳过「不丢数据」断言`);
  }

  checks.push({
    断言: `抽样级别 z<${LOWZOOM_CAP_FROM} 的瓦片没有超过封顶上限 ${LOWZOOM_CAP.toLocaleString()} 要素`,
    实测: results
      .filter((r) => r.z < LOWZOOM_CAP_FROM)
      .map((r) => `z${r.z}:${r.maxTileFeats}`)
      .join(" "),
    通过: results.filter((r) => r.z < LOWZOOM_CAP_FROM).every((r) => r.maxTileFeats <= LOWZOOM_CAP),
  });

  // ---- 阶段42 新增的两条断言 ----
  // ① 解码失败必须响亮失败：原先 catch 里静默 continue，
  //    结果「什么都读不出来」也能一路走到「全部通过」。
  checks.push({
    断言: "所有抽样瓦片都能解码（不允许静默跳过）",
    实测: `${decodeFailed} 张解码失败${decodeErrMsg ? `；首个错误：${decodeErrMsg}` : ""}`,
    通过: decodeFailed === 0,
  });

  // ② 属性白名单：z>=8 的瓦片应保留各 ftype 的专属属性。
  //    ‼️ 这条专为防止阶段42 那类 bug 复现 ——
  //    `build_pmtiles.mjs` 的 keepProps 漏字段时**不会报错、不会崩溃**，
  //    只表现为前端的某个字段永远不出现（plant_source 就是这样丢了很久）。
  //    光看「构建 exit=0」永远发现不了，必须在这里把期望的属性钉死。
  const expectProp = { line: "line_kind", substation: "substation_kind", plant: "plant_source" };
  if (results.some((r) => r.z >= 8)) {
    const missing = [];
    for (const [ftype, key] of Object.entries(expectProp)) {
      const seen = keysByType[ftype];
      if (seen.size === 0) continue; // 该 ftype 没抽样到，不做判断，避免误报
      if (!seen.has(key)) missing.push(`${ftype}.${key}`);
    }
    checks.push({
      断言: "z>=8 的瓦片保留了各 ftype 的专属属性（line_kind / substation_kind / plant_source）",
      实测: Object.entries(expectProp)
        .map(([t, k]) =>
          keysByType[t].size === 0 ? `${t}:未抽样到` : `${t}:${keysByType[t].has(k) ? "有" : "缺"}${k}`,
        )
        .join("  "),
      通过: missing.length === 0,
    });
  }

  for (const c of checks) {
    console.log(`${c.通过 ? "✅" : "❌"} ${c.断言} — 实测 ${c.实测}`);
    if (!c.通过) ok = false;
  }
  console.log(
    ok
      ? "\n全部通过。（注意：本脚本验证的是「体积与不丢数据」；\n" +
          "「封顶是否严格按电压由高到低」请跑 node scripts/diag_lowzoom.mjs）"
      : "\n有断言未通过，需返工。",
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
