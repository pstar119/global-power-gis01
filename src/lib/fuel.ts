/**
 * 燃料类型的配色与中文名 —— **全应用唯一数据源**。
 *
 * 地图上的点、左上角的图例、统计页的条形图都从这里取值。
 * 之前这些定义散在 MapPage 里，统计页一旦复制一份就会两处漂移，
 * 所以抽成公共模块。
 *
 * ⚠️ 刻意用**纯对象字面量**实现，绝不引入 d3-scale / chroma.js 等配色库：
 *    一张颜色映射表不值得增加任何依赖。
 *
 * key 对应 WRI 数据集的 primary_fuel 取值（实测共 15 类）。
 */

export const FUEL_COLORS: Record<string, string> = {
  Coal: "#8d8d8d", // 煤：灰
  Gas: "#ff9b52", // 气：橙
  Oil: "#b0703f", // 油：棕
  Nuclear: "#c77dff", // 核：紫
  Hydro: "#4daafc", // 水：蓝
  Wind: "#5ee39b", // 风：绿
  Solar: "#ffd24a", // 光：黄
  Biomass: "#7fc76f", // 生物质：草绿
  Geothermal: "#ff6b6b", // 地热：红
  Waste: "#b0a04a", // 废弃物：土黄
  Storage: "#4fd1c5", // 储能：青
  Cogeneration: "#c9a227", // 热电联产：金
  Petcoke: "#6b6b6b", // 石油焦：深灰
  "Wave and Tidal": "#2e9bd6", // 潮汐：海蓝
  Other: "#9aa0a6", // 其他：中性灰
};

/** 燃料类型的中文名 */
export const FUEL_LABELS: Record<string, string> = {
  Coal: "煤电",
  Gas: "燃气",
  Oil: "燃油",
  Nuclear: "核电",
  Hydro: "水电",
  Wind: "风电",
  Solar: "光伏",
  Biomass: "生物质",
  Geothermal: "地热",
  Waste: "废弃物",
  Storage: "储能",
  Cogeneration: "热电联产",
  Petcoke: "石油焦",
  "Wave and Tidal": "潮汐",
  Other: "其他",
};

/** 未知 / 缺失燃料类型时的兜底色（中性灰） */
export const FUEL_FALLBACK_COLOR = "#9aa0a6";

export function fuelColor(fuel: string | null | undefined): string {
  if (!fuel) return FUEL_FALLBACK_COLOR;
  return FUEL_COLORS[fuel] ?? FUEL_FALLBACK_COLOR;
}

/** 拿不到中文名时退回原始英文键，而不是显示空白 */
export function fuelLabel(fuel: string | null | undefined): string {
  if (!fuel) return "未知";
  return FUEL_LABELS[fuel] ?? fuel;
}

/**
 * 图例条目：燃料英文键 -> 中文标签（顺序即图例展示顺序）。
 * 色块颜色不在这里写死，而是渲染时从 FUEL_COLORS 取。
 */
export const FUEL_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Coal", "煤电"],
  ["Gas", "燃气"],
  ["Oil", "燃油"],
  ["Nuclear", "核电"],
  ["Hydro", "水电"],
  ["Wind", "风电"],
  ["Solar", "光伏"],
  ["Biomass", "生物质"],
  ["Geothermal", "地热"],
  ["Waste", "废弃物"],
  ["Storage", "储能"],
  ["Cogeneration", "热电联产"],
  ["Petcoke", "石油焦"],
  ["Wave and Tidal", "潮汐"],
  ["Other", "其他"],
];
