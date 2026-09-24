/**
 * 诊断：低级别瓦片里到底有多少要素？封顶前后的 vclass 分布各是什么？
 *
 * 背景：`verify_pack.mjs` 的断言失败了 —— z0 实测 735+ 只有 183 个（源数据 643 个），
 * 而 unknown 反而最多（11,666）。这与「按电压由高到低保留」的预期不符。
 *
 * **先测量再改代码**。两个候选解释：
 *   H1: geojson-vt 在低级别本来就丢弃退化要素（OSM 线路长度中位数只有 192 m，
 *       在 z0 会简化到不足一个像素）⇒ 瓦片里本来就没有全部要素，错的是我的**模型**。
 *   H2: pickForLowZoom 的排序或取值写错了 ⇒ 错的是**代码**。
 *
 * 这个脚本把两者分开：打印封顶**前**瓦片内的 vclass 分布与优先级档计数，
 * 再打印封顶**后**的，并检查「高优先级被丢、低优先级却留着」是否发生。
 *
 * 用法：node scripts/diag_lowzoom.mjs public/osm/huadong_power.geojson
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RANK = { "735+": 0, "500-734": 1, "220-499": 2, "<220": 3, unknown: 4 };
/**
 * 同档内的"点比线优先"表。
 * ⚠️ 必须与 `build_pmtiles.mjs` 的 `FTYPE_RANK` **逐字一致**：
 *    这份是**诊断**脚本（不是门禁），值不一致时它给出的"封顶是否严格按优先级"
 *    结论就是错的 —— 而那种错误看起来完全正常（数字照常打印）。
 *    阶段56-A2：补上 `converter`（与变电站同档）。
 */
const FR = { plant: 0, substation: 1, converter: 1, line: 2 };
const CAP = 20000;

function fmtHist(h) {
  return Object.entries(h)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}
function hist(features) {
  const h = {};
  for (const f of features) {
    // ⚠️ 原始 GeoJSON 的属性在 `properties`，geojson-vt 瓦片要素在 `tags`。
    //    一开始只读了 tags，导致「源 vclass」那行全部输出 (无)，是自己给自己的假信号。
    const k = (f.tags ?? f.properties ?? {}).vclass ?? "(无)";
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
}

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error("用法: node scripts/diag_lowzoom.mjs <geojson>");
    process.exitCode = 2;
    return;
  }
  const fc = JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
  const gvMod = await import("geojson-vt");
  const GeoJSONVT = gvMod.default ?? gvMod;
  const opts = { maxZoom: 12, indexMaxZoom: 5, tolerance: 3, extent: 4096, buffer: 64 };
  let index;
  try {
    index = new GeoJSONVT(fc, opts);
  } catch {
    index = GeoJSONVT(fc, opts);
  }

  console.log("=== 低级别瓦片诊断 ===");
  console.log(`源文件      : ${rel}`);
  console.log(`源要素总数  : ${fc.features.length}`);
  // 源数据自身的 vclass 分布（作为对照基线）
  console.log(`源 vclass   : ${fmtHist(hist(fc.features))}`);
  console.log(`geojson-vt  : maxZoom=${opts.maxZoom} indexMaxZoom=${opts.indexMaxZoom} tolerance=${opts.tolerance}`);

  for (const [z, x, y] of [
    [0, 0, 0],
    [4, 13, 6],
    [6, 53, 26],
  ]) {
    const tile = index.getTile(z, x, y);
    console.log(`\n=== z${z}/${x}/${y} ===`);
    if (!tile) {
      console.log("无瓦片");
      continue;
    }
    const before = tile.features.length;
    const ranked = tile.features.map((f, i) => {
      const t = f.tags ?? {};
      const vr = RANK[t.vclass] ?? 5;
      const fr = FR[t.ftype] ?? 3;
      return { f, i, key: vr * 10 + fr, vr };
    });
    const byRank = {};
    for (const r of ranked) byRank[r.vr] = (byRank[r.vr] ?? 0) + 1;

    ranked.sort((a, b) => a.key - b.key || a.i - b.i);
    const kept = ranked.slice(0, CAP);
    const afterVr = {};
    for (const r of kept) afterVr[r.vr] = (afterVr[r.vr] ?? 0) + 1;

    console.log(`瓦片要素(封顶前) : ${before}   <-- 若远小于总数，说明 geojson-vt 已丢弃大量退化要素`);
    console.log(`封顶前 vclass    : ${fmtHist(hist(tile.features))}`);
    console.log(`封顶前 优先级档  : ${JSON.stringify(byRank)}   (0=735+ 1=500-734 2=220-499 3=<220 4=unknown 5=缺vclass)`);
    console.log(`封顶后 vclass    : ${fmtHist(hist(kept.map((r) => r.f)))}`);
    console.log(`封顶后 优先级档  : ${JSON.stringify(afterVr)}`);

    // 严格性检查：若某个高优先级档未被全部保留，却在保留集里出现了更低优先级的档，则排序没生效
    let violated = false;
    for (let r = 1; r <= 5; r++) {
      const higherTotal = byRank[r - 1] ?? 0;
      const higherKept = afterVr[r - 1] ?? 0;
      if (higherTotal > higherKept && (afterVr[r] ?? 0) > 0) violated = true;
    }
    console.log(`排序是否严格执行 : ${violated ? "❌ 否（代码有问题）" : "✅ 是（错的是我对数据量的假设）"}`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
