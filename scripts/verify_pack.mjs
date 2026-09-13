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
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PMTiles } from "pmtiles";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYER = "grid";
const VCLASS_ORDER = ["735+", "500-734", "220-499", "<220", "unknown"];

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

  const { VectorTile } = await import("@mapbox/vector-tile");
  const pbfMod = await import("pbf");
  const Pbf = pbfMod.default ?? pbfMod;

  console.log("=== 可选包体检 ===");
  console.log(`文件        : ${rel}`);
  console.log(`体积        : ${(statSync(packPath).size / 1048576).toFixed(2)} MB`);
  console.log(
    `header      : z${header.minZoom}-${header.maxZoom} tileType=${header.tileType} ` +
      `tileCompression=${header.tileCompression} addressed=${header.numAddressedTiles.toLocaleString()}`,
  );
  console.log();

  const results = [];
  for (const z of zooms) {
    const n = 1 << z;
    let tiles = 0;
    let feats = 0;
    let maxTileFeats = 0;
    let maxTileBytes = 0;
    const hist = {};
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        let r;
        try {
          r = await pm.getZxy(z, x, y);
        } catch {
          continue;
        }
        if (!r) continue;
        tiles++;
        const bytes = r.data.byteLength ?? r.data.length;
        if (bytes > maxTileBytes) maxTileBytes = bytes;
        let vt;
        try {
          vt = new VectorTile(new Pbf(new Uint8Array(r.data)));
        } catch {
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
        }
      }
    }
    results.push({ z, tiles, feats, maxTileFeats, maxTileBytes, hist });
    const dist = VCLASS_ORDER.filter((k) => hist[k]).map((k) => `${k}=${hist[k]}`).join(" ");
    console.log(
      `z${String(z).padEnd(2)} 瓦片 ${String(tiles).padStart(6)}  要素 ${String(feats).padStart(7)}  ` +
        `最大单瓦片 ${String(maxTileFeats).padStart(6)} 要素 / ${(maxTileBytes / 1024).toFixed(1).padStart(7)} KB`,
    );
    console.log(`      ${dist || "(无)"}`);
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
    断言: "低级别瓦片确实被压到上限以内（至少一个级别触碰到 20000）",
    实测: results.map((r) => `z${r.z}:${r.maxTileFeats}`).join(" "),
    通过: results.some((r) => r.maxTileFeats >= 20000),
  });

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
