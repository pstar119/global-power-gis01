/**
 * 阶段38：全国分批流水线的**批次定义（单一事实来源）**
 *
 * 为什么需要这个文件：`fetch/prepare/build` 三个脚本各自只认「一个 bbox + 一个名字」，
 * 全国作业需要的是「一批一批、可独立交付」的编排。把批次定义集中在这里，
 * 驱动脚本、文档、验收脚本都引用同一份，避免三处各写一遍 bbox 后悄悄不一致。
 *
 * ⚠️ 块尺寸不是拍脑袋定的：它对齐**华东批次的实测值**——
 *    9.5° × 15.5° 切成 8×8 ⇒ 单块 1.1875° × 1.9375°，实测 50.3 秒/块、零失败。
 *    保持同样的块尺寸，才能让「每块成本可预测、超时风险一致」。
 */

import { pathToFileURL } from "node:url";

/** 华东实测值（2026-09-13，22 块 / 18.5 分钟）——全国工期的推算基准 */
export const CELL_MEASURED = { lon: 1.1875, lat: 1.9375, secPerChunk: 50.3 };

/**
 * 批次表。`bbox` 与 GeoJSON 一致：西,南,东,北。
 *
 * 为什么按**大区**分而不是均分网格：均分网格会把一个省切进两个批次，
 * 交付单位（一个批次一个可选包）和省界就对不上，跨批去重也要额外做。
 * 按大区分，每批天然是一个可独立验收、独立交付的整体。
 *
 * 顺序 = 数据密度递减。密集区先出成果；稀疏区（藏/新/青）放最后，
 * 它们的超时与稀疏风险不会阻塞主线。
 */
export const REGIONS = [
  {
    key: "huadong",
    label: "华东",
    provinces: "沪苏浙皖闽赣鲁（含粤北、湘南邻界带）",
    bbox: [113.5, 23.0, 123.0, 38.5],
    note:
      "批次1，**复用已在跑的抓取**：(123-113.5)/1.1875=8、(38.5-23)/1.9375=8 ⇒ 恰好 8x8=64 块，" +
      "与 2026-09-13 已在执行的 hd 批次逐块对齐，不重复抓。完全覆盖已交付的核心区（长三角+浙江）。",
  },
  { key: "huazhong", label: "华中", provinces: "豫鄂湘", bbox: [108.3, 24.5, 116.7, 36.4] },
  { key: "huanan", label: "华南", provinces: "粤桂琼港澳台", bbox: [104.4, 18.1, 120.0, 26.5] },
  { key: "huabei", label: "华北", provinces: "京津冀晋", bbox: [110.2, 34.5, 120.0, 42.7] },
  { key: "dongbei", label: "东北", provinces: "辽吉黑", bbox: [118.8, 38.6, 135.1, 53.6] },
  {
    key: "xinan",
    label: "西南",
    provinces: "川渝云贵藏",
    bbox: [78.4, 21.1, 110.2, 36.5],
    note: "含西藏，跨度大、大半为稀疏区",
  },
  {
    key: "xibei",
    label: "西北",
    provinces: "陕甘青宁新（含内蒙西部）",
    bbox: [73.5, 31.5, 111.3, 49.2],
    note: "块数最多；内蒙西部地广人稀，预计大量空块",
  },
];

/** 按目标块尺寸把一个批次切成 NxM（四舍五入到整数网格） */
export function gridFor(region, target = CELL_MEASURED) {
  const [w, s, e, n] = region.bbox;
  const cols = Math.max(1, Math.round((e - w) / target.lon));
  const rows = Math.max(1, Math.round((n - s) / target.lat));
  return { cols, rows };
}

/** 实际块尺寸（网格取整后会与目标略有偏差，必须报出真实值而不是目标值） */
export function cellSizeOf(region, target = CELL_MEASURED) {
  const [w, s, e, n] = region.bbox;
  const { cols, rows } = gridFor(region, target);
  return { lon: (e - w) / cols, lat: (n - s) / rows };
}

export function chunkCount(region, target = CELL_MEASURED) {
  const { cols, rows } = gridFor(region, target);
  return cols * rows;
}

/** 扫描抽样：单块尺寸与真抓**完全一致**（保证每块查询成本可预测），
 *  但只取每 step 列/行交叉处的格子。
 *
 *  ⚠️ 为什么不用「把块放大 N 倍」来减少查询次数：块越大越容易撞上 Overpass 的 180s 超时，
 *     而超时会被记成失败 —— 那等于拿一把不可靠的尺子量尺寸，量出来的数是错的。
 *     保持同尺寸、只减少**数量**，才是可控的抽样。
 */
export function scanSample(region, step = 3, target = CELL_MEASURED) {
  const { cols, rows } = gridFor(region, target);
  const sCols = Math.max(1, Math.ceil(cols / step));
  const sRows = Math.max(1, Math.ceil(rows / step));
  return { step, cols, rows, sCols, sRows, cells: sCols * sRows };
}

/** 保留每 step 列/行交叉处的格子（与 Python 端 --sample-step 同一规则） */
export function sampleChunks(chunks, cols, rows, step) {
  if (step <= 1) return chunks.slice();
  const out = [];
  let idx = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (i % step === 0 && j % step === 0) out.push(chunks[idx]);
      idx++;
    }
  }
  return out;
}

// 直接运行时打印批次表（纯本地计算，不发网络请求）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = summaryRows();
  console.log("=== 阶段38 全国分批流水线 · 批次表 ===");
  console.table(rows);
  const chunks = rows.reduce((a, r) => a + r.块数, 0);
  const minutes = rows.reduce((a, r) => a + r.预计分钟, 0);
  console.log(`合计块数：${chunks}`);
  console.log(`串行预计：${(minutes / 60).toFixed(1)} 小时（按 50.3 秒/块）`);
  console.log("⚠️ 这只是**估算**，不要写成「上界」。");
  console.log("   实测（阶段38，238 块）已推翻「稀疏区每块更快」这个直觉：");
  console.log("   东北 267 要素/块却 54.8 秒/块（最慢），华北 1963 要素/块 49.6 秒/块。");
  console.log("   单块耗时由**服务端负载**主导，与数据量几乎无关 —— 别再拿密度推测工期。");
  console.log("\n扫描抽样（step=3，单块尺寸与真抓一致）：");
  console.table(
    REGIONS.map((r) => {
      const s = scanSample(r, 3);
      return { 批次: r.label, 真抓块数: s.cols * s.rows, 扫描块数: s.cells, 网格: `${s.sCols}x${s.sRows}` };
    }),
  );
}

export function findRegion(key) {
  return REGIONS.find((r) => r.key === key) ?? null;
}


export function summaryRows(target = CELL_MEASURED) {
  return REGIONS.map((r) => {
    const { cols, rows } = gridFor(r, target);
    const cell = cellSizeOf(r, target);
    const chunks = cols * rows;
    return {
      批次: r.label,
      key: r.key,
      范围: r.provinces,
      bbox: r.bbox.join(","),
      网格: `${cols}x${rows}`,
      块尺寸: `${cell.lon.toFixed(2)}°x${cell.lat.toFixed(2)}°`,
      块数: chunks,
      预计分钟: Math.round((chunks * target.secPerChunk) / 60),
    };
  });
}

// 直接运行时打印批次表（占位）

// 直接运行时打印批次表（纯本地计算，不发网络请求）
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const rows = summaryRows();
  console.log("=== 阶段38 全国分批流水线 · 批次表 ===");
  console.table(rows);
  const chunks = rows.reduce((a, r) => a + r.块数, 0);
  const minutes = rows.reduce((a, r) => a + r.预计分钟, 0);
  console.log(`合计块数：${chunks}`);
  console.log(`串行预计：${(minutes / 60).toFixed(1)} 小时（按华东实测 ${CELL_MEASURED.secPerChunk} 秒/块）`);
  console.log("⚠️ 这是**上界**：稀疏区（藏/新/青）每块远快于密集区。");
  console.log("   真实工期用 --count-only 粗扫后按实测密度修正，别拿这个数当承诺。");
}
