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

  /* ==========================================================================
   * 项目 B（阶段56-B）：相邻带邻国 —— 5 个批次
   * ==========================================================================
   * 设计：`docs/superpowers/specs/2026-09-24-china-neighbors-design.md`（§3.1 批次表）
   * ‼️ 口径（2026-09-24 变更通告）：**只做电力**（与国内一致），不抓铁路/管道；
   *    并且要与 A2 之后的国内包**同构** ⇒ 除 `--category power` 外还要跑
   *    `--category converters`（换流站 + frequency），否则邻国包没有直流分档。
   *    一条命令：`node scripts/run_pipeline.mjs --regions kp-kr --category power,converters`
   *
   * ⚠️ 网格不在这里写死：下面的 `gridFor()` 按国内实测块尺寸（1.1875°×1.9375°）自动算，
   *    与设计文档 §3.1 表里的 6×5 / 27×6 / 15×12 / 34×11 / 55×7 一致。
   * ⚠️ bbox 是**矩形不是国界**（管线只支持 bbox）⇒ 会夹带邻国周围的国家与中国边境省，
   *    这是**设计内偏差**，已在 README / 向导文案里如实标注（设计 §3.2）。
   */
  {
    key: "kp-kr",
    label: "朝鲜半岛",
    provinces: "朝鲜 / 韩国",
    bbox: [124.3, 33.1, 131.0, 43.1],
    note: "项目 B 第 1 批（设计 §8：先打通全链路）；实测 power=line 约 KR 3,666 条",
  },
  {
    key: "mn",
    label: "蒙古",
    provinces: "蒙古",
    bbox: [87.7, 41.5, 119.9, 52.2],
    // 稀疏区：改用 ≈5°×4° 的粗块（见 gridFor 的说明；块数 162 → 18，数据不变）
    target: { lon: 5, lat: 4 },
    note: "OSM 电力覆盖稀疏（实测 power=line 约 990 条）—— 稀疏是数据现状，不是缺陷",
  },
  {
    key: "sea-mainland",
    label: "中南半岛",
    provinces: "缅 / 老 / 越 / 泰 / 柬",
    bbox: [92.2, 5.6, 109.6, 28.6],
    // 稀疏区（除越南/泰国局部）：粗块 180 → 18
    target: { lon: 5, lat: 4 },
    note: "与中国云南/广西的 bbox 有重叠（设计 §3.2 已知偏差），由区域选举与装载上限承载",
  },
  {
    key: "ca",
    label: "中亚五国",
    provinces: "哈 / 吉 / 塔 / 乌 / 土",
    bbox: [46.5, 35.1, 87.4, 55.5],
    // 稀疏区：粗块 374 → 40
    target: { lon: 5, lat: 4 },
    note: "矩形会夹带伊朗东北、阿富汗北部、巴基斯坦北部与新疆西部（设计 §3.2）",
  },
  {
    key: "ru-far",
    label: "俄相邻带",
    provinces: "俄罗斯（49°N 以南的相邻带）",
    bbox: [80.0, 49.0, 145.0, 62.0],
    // 最稀疏：粗块 385 → 39
    target: { lon: 5, lat: 4 },
    note: "只做相邻纬度带（全俄是它的 2.5 倍成本，明确不做）；贝加尔湖以西按设计缺失",
  },
];

/** 按目标块尺寸把一个批次切成 NxM（四舍五入到整数网格）
 *
 * ‼️ 阶段56-B：批次可以自带 `target`（见下面 4 个稀疏邻国批次），**优先于**调用方传的默认值。
 *    理由：默认块尺寸（1.1875°×1.9375°）是对齐**华东密集区**标定的；
 *    蒙古/中亚/西伯利亚这种 OSM 稀疏区的要素数少一到两个数量级，
 *    用小块的唯一效果是把时间花在往返上（实测单块耗时由服务端负载主导，与要素数几乎无关）。
 *    放进批次定义而不是靠 `--target-cell` 手传，是为了让断点键、清单 `chunks`、文档表三处同源。
 */
export function gridFor(region, target = CELL_MEASURED) {
  const t = region.target ?? target;
  const [w, s, e, n] = region.bbox;
  const cols = Math.max(1, Math.round((e - w) / t.lon));
  const rows = Math.max(1, Math.round((n - s) / t.lat));
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
