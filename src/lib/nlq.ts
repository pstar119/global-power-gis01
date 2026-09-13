/**
 * 本地规则引擎：自然语言 -> 查询意图 -> SQL + 绑定参数。
 *
 * ⚠️ 这是**纯函数模块**：不碰 DOM、不碰 React、不发任何网络请求，可独立验证。
 *    下一阶段接入 Qwen / DeepSeek / GLM 时，只需让模型输出同样的 `ParsedQuery`
 *    结构（**而不是让它直接写 SQL**），后面的 SQL 生成、参数绑定、执行与渲染
 *    全部原样复用 —— 这从架构上消除了「模型乱写 SQL」的注入与幻觉风险。
 *
 * ⚠️ 安全铁律：**用户输入绝不拼接进 SQL 字符串**，只作为**绑定参数**传递；
 *    SQL 模板是本文件里的常量。即使输入 `'; DROP TABLE --`，它也只会被当成
 *    一个匹配不到的燃料 / 国家词，而不会变成 SQL 语法。
 *
 * 本版刻意把意图**收敛到 3 类**（先把通路跑通，不贪多）：
 *   1. country_stats —— 按国家聚合（可筛选燃料、可限定国家、可取前 N 名）
 *   2. fuel_stats    —— 按燃料类型聚合（可筛选国家、可限定燃料）
 *   3. global_stats  —— 全球总量概览
 */

import { COUNTRY_ALIASES, countryLabel } from "./country";
import { FUEL_LABELS } from "./fuel";

/**
 * 地图视野快照（WGS84，单位度）。
 * 由地图页在 moveend / 图层变化时写入，解析时作为「空间上下文」随问题下发。
 */
export interface ViewportBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * 解析时随问题一起下发的上下文（阶段31：空间智能）。
 *
 * ⚠️ 坐标**只由地图页写入**，模型永远不产出坐标 —— 「要不要限定在当前视野」
 *    交给模型判断（输出布尔 inViewport），「视野到底是哪块矩形」由我们填。
 *    这样提示词注入与幻觉都不可能把查询框挪到别处。
 */
export interface QueryContext {
  viewport?: ViewportBbox;
  zoom?: number;
  /**
   * 用户当前勾选的图层显示名，如 `["电厂","变电站","220-499kV"]`。
   * ⚠️ 仅供提示词描述现状，**不参与 SQL** —— 本地库里只有电厂表，
   *    线路/变电站数据在 PMTiles 瓦片里，SQL 查不到。
   */
  layers?: readonly string[];
}

/** 「当前视野」类空间指代（本地规则引擎用；云端由提示词判定） */
const VIEWPORT_WORDS: readonly string[] = [
  "当前视野",
  "视野内",
  "视野里",
  "这个区域",
  "该区域",
  "当前区域",
  "当前范围",
  "屏幕内",
  "屏幕里",
  "画面里",
  "这一片",
  "这里",
];

/** 视野是否发生了「足以让上次结果失效」的变化（约 10 米级，避免浮点抖动误清） */
export function viewportChanged(
  a: ViewportBbox,
  b: ViewportBbox,
  eps = 1e-4,
): boolean {
  return (
    Math.abs(a.minLon - b.minLon) > eps ||
    Math.abs(a.maxLon - b.maxLon) > eps ||
    Math.abs(a.minLat - b.minLat) > eps ||
    Math.abs(a.maxLat - b.maxLat) > eps
  );
}

/** 给人看的视野读数，例如 `116.4°E~122.0°E, 29.9°N~32.7°N` */
export function formatViewport(b: ViewportBbox): string {
  const lon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "E" : "W"}`;
  const lat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "N" : "S"}`;
  return `${lon(b.minLon)}~${lon(b.maxLon)}, ${lat(b.minLat)}~${lat(b.maxLat)}`;
}

/**
 * 阶段32：点击结果表格行时携带的**电厂标识**。
 *
 * 🔴 电厂名**不是唯一键**：实测 `Shanghai Lingang` 在库里对应 2 个点，
 *    WRI 里同名/近名的电站也不罕见。所以唯一标识必须是
 *    **(name, lat, lon) 三元组** —— 只用名字会出现「点了 Lingang 却飞到另一座」。
 */
export interface PlantFocus {
  name: string;
  lat: number;
  lon: number;
  /** 高亮圆半径按容量分级，所以要带上（可为 null） */
  capacityMW: number | null;
  /** 弹窗/提示里想显示燃料时用；模型与点击路径都允许为空 */
  primaryFuel?: string | null;
}

/**
 * 从一行查询结果里提取电厂标识。
 * 聚合类行（按国家/燃料/全球总量）没有单个坐标 → 返回 null，
 * 于是那些行天然不可点击，不需要额外判断 intent。
 */
export function toPlantFocus(row: Record<string, unknown>): PlantFocus | null {
  const name = row.name;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (typeof name !== "string" || !name) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const mw = Number(row.capacity_mw);
  const fuel = row.primary_fuel;
  return {
    name,
    lat,
    lon,
    capacityMW: Number.isFinite(mw) ? mw : null,
    primaryFuel: typeof fuel === "string" ? fuel : null,
  };
}

/** 三元组相等判定（选中行高亮用）—— 同样**不能**退化成只比 name */
export function samePlant(
  a: PlantFocus | null | undefined,
  b: PlantFocus | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.name === b.name && a.lat === b.lat && a.lon === b.lon;
}

/**
 * 阶段33：一轮已完成的问答，用于追问时给模型 / 本地引擎提供上下文。
 *
 * 🔴 刻意**不保存 bbox 坐标**，只保存「上一轮是否限定当前视野」这个事实 ——
 *    坐标每次解析都从 live 视野重新注入。否则用户平移地图后追问会拿旧快照去查，
 *    正是阶段32 刚修掉的那类坑。
 */
export interface ConversationTurn {
  question: string;
  /** describeQuery() 的产物：给人看，也给模型看 */
  summary: string;
  query: ParsedQuery;
}

/** 内存里最多保留多少轮（界面默认只露 5 轮，「展开更多」可看全部） */
export const MAX_STORED_TURNS = 20;
/** 界面上默认展示的轮数 */
export const HISTORY_SHOWN_TURNS = 5;

/** 追问指代词：出现这些词、且问题本身没给新范围时，继承上一轮的约束 */
const COREFERENCE_WORDS: readonly string[] = [
  "那",
  "呢",
  "还是",
  "同样",
  "那么",
  "这个",
  "这些",
];

/** 问题是否依赖上一轮上下文（纯函数，可独立验证） */
export function hasCoreference(text: string): boolean {
  return COREFERENCE_WORDS.some((w) => text.includes(w));
}

/** 燃料别名 -> WRI 的 primary_fuel 取值 */
const FUEL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["煤电", "Coal"],
  ["煤炭", "Coal"],
  ["火电", "Coal"],
  ["燃气", "Gas"],
  ["天然气", "Gas"],
  ["气电", "Gas"],
  ["水电", "Hydro"],
  ["水力", "Hydro"],
  ["风电", "Wind"],
  ["风力", "Wind"],
  ["风能", "Wind"],
  ["光伏", "Solar"],
  ["太阳能", "Solar"],
  ["核电", "Nuclear"],
  ["核能", "Nuclear"],
  ["燃油", "Oil"],
  ["石油", "Oil"],
  ["油电", "Oil"],
  ["生物质", "Biomass"],
  ["地热", "Geothermal"],
  ["储能", "Storage"],
  ["潮汐", "Wave and Tidal"],
  ["废弃物", "Waste"],
];

export type Intent =
  | "country_stats"   // 按国家聚合
  | "fuel_stats"      // 按燃料聚合
  | "global_stats"    // 全球总量概览
  | "plant_list";     // 按单个电厂列出（阶段24：前 N 大电厂）

export interface ParsedQuery {
  intent: Intent;
  /** 燃料过滤（WRI 的 primary_fuel 取值） */
  fuel?: string;
  /** 国家过滤（ISO3 码） */
  country?: string;
  /** 取前 N 名 */
  limit?: number;
  /**
   * 只查「当前视野内」。
   *
   * ⚠️ 四个坐标是**解析那一刻的快照**，随 `MapCommand` 一起交给地图页 ——
   *    否则地图页重新生成 buildBoundsSql / buildHighlightSql 时就拿不到范围，
   *    高亮会退化成全球范围。也正因为是快照，表格里的行与地图上的金圈必然一致。
   */
  viewport?: ViewportBbox;
}

export interface SqlPlan {
  sql: string;
  params: unknown[];
}

/**
 * 跨页面向地图下达的指令。
 *
 * 放在这里是因为它直接复用 `ParsedQuery` 的字段（意图 + 筛选条件），
 * 不需要再定义一套平行的结构。
 */
export interface MapCommand extends ParsedQuery {
  /** 自增 id：MapPage 用它去重，避免同一个命令被重复执行 */
  id: number;
  /**
   * 为 true 时**只清空高亮**，不飞行、不改视角。
   * 用途：用户发起新查询的瞬间，把上一次的金色圈先抹掉 ——
   * 否则在解析的几秒里，表格已经空了而地图还挂着旧结果，比表格残留更误导。
   */
  clearOnly?: boolean;
  /**
   * 阶段32：聚焦到**单个**电厂（点击结果表格行触发）。
   *
   * 有它时**不重跑 SQL**、不动旧结果，只是飞过去 + 把高亮换成这一个点 ——
   * 「定位」与「查询」是两件事，混在一起会让用户困惑（点一行就把整张表换了）。
   */
  focus?: PlantFocus;
}

/**
 * 高亮点数的上限。
 * 超过这个数量就只飞行、不高亮 —— 例如「中国全部电厂」有 4235 个，
 * 全量高亮既无意义又卡顿。
 */
export const MAX_HIGHLIGHT_POINTS = 3000;

export type ParseResult =
  | { ok: true; query: ParsedQuery; plan: SqlPlan; explanation: string }
  | { ok: false; message: string; suggestions: readonly string[] };

/** 界面上提供的示例问法 */
export const EXAMPLES: readonly string[] = [
  "当前视野里最大的5个电厂",
  "这个区域有多少电厂",
  "全球煤电装机容量排名前5的国家",
  "全球前10大电厂",
  "中国最大的5个水电站",
  "中国有多少电厂",
  "全球燃料类型占比",
];

/**
 * plant_list 不指定 limit 时的默认条数。
 * 必须有一个默认值 —— 否则「列出电厂」这类问法会生成潜 LIMIT 的 SQL，
 * 把 3.5 万行全拉回前端。
 */
export const DEFAULT_PLANT_LIMIT = 10;

/** 长别名优先，避免短词先命中导致语义跑偏 */
function matchAlias(
  text: string,
  aliases: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  const sorted = [...aliases].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, value] of sorted) {
    if (text.includes(alias.toLowerCase())) return value;
  }
  return undefined;
}

/** 抽取「前 5 / top5 / 最大的 3 个」里的数字 */
function findLimit(text: string): number | undefined {
  // ⚠️ 允许 3 位数字：用户说「当前视野最大的100个电厂」时，
  //    原来的 `\d{1,2}` 会把 100 当成 10，静默返回 10 行（实测踩到）。
  //    上限仍由 plantListLimit 封在 50。
  const m =
    text.match(/(?:前|top|排名前|最大的?|最高的?)\s*(\d{1,3})/i) ??
    text.match(/(\d{1,3})\s*(?:个|名|位)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  // 上限 50：防止用户输入夸张数字导致界面被撑爆
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : undefined;
}

function decideIntent(
  text: string,
  fuel: string | undefined,
  country: string | undefined,
): Intent | null {
  // ⚠️ 「个体词 + 要列表」优先，且必须放在国家维度判断**之前**。
  //    否则「全球前10大电厂」里的「前10」「最大」会命中下面的
  //    wantsCountryDim 正则，被误判成按国家聚合 —— 结果完全不对。
  //
  // ⚠️ 两个条件必须同时成立：「中国有多少电厂」虽然有个体词，
  //    但问的是数量，应该继续走聚合；只有「前 N / 最大 / 哪些」
  //    这类要具体名单的问法才走明细列表。
  const individual = /电厂|电站|发电厂|发电站|机组/.test(text);
  const wantsList =
    /哪些|列出|列表|最大的?|最高的?|前\s*\d|top\s*\d|排名前/i.test(text);
  if (individual && wantsList) return "plant_list";

  // ⚠️ 用「国家」而不是「国」，否则「中国」「美国」里的单字会误判
  const wantsCountryDim = /国家|地区|排名|排行|榜单|最多|最大|前\d|top\d/i.test(
    text,
  );
  const wantsFuelDim = /燃料|能源|类型|结构|占比|构成|种类/.test(text);
  const wantsGlobal = /全球|世界|总共|一共|总计|合计|总数|总量|多少/.test(
    text,
  );

  // 明确点出「国家维度」的说法优先按国家聚合
  if (wantsCountryDim) return "country_stats";
  // 有具体国家名（「中国有多少电厂」）
  if (country && !fuel) return "country_stats";
  // 有具体燃料名但没有国家（「全球风电总装机容量」）
  if (fuel && !country) return "fuel_stats";
  // 国家与燃料同时出现时，按国家维度更符合直觉（「中国的煤电」）
  if (country && fuel) return "country_stats";
  if (wantsFuelDim) return "fuel_stats";
  if (wantsGlobal) return "global_stats";

  // 什么都没识别出来 —— 交给界面给出示例引导，而不是硬猜
  return null;
}

/**
 * 由结构化意图生成 SQL 与绑定参数。
 * 导出它是为了下一阶段接大模型时能单独复用（模型只输出 ParsedQuery）。
 */
export function buildSql(query: ParsedQuery): SqlPlan {
  // ⚠️ 阶段31 重构：fuel / country / viewport 的判定全部下沉到 buildWhere，
  //    四个 intent 共用它。之前只有 plant_list 用它，另外三条各写各的 ——
  //    那种写法下加「当前视野」极容易只改一处、其余三处静默失效。
  const { intent, limit } = query;

  if (intent === "global_stats") {
    // ⚠️ 四个子查询**各自**都要带 WHERE（params 也要重复四份），漏一个就会
    //    「电厂数按视野算、装机容量却按全球算」，数字自相矛盾。
    const { where, params } = buildWhere(query);
    return {
      sql: `SELECT (SELECT COUNT(*)                          FROM power_plants ${where}) AS total_plants,
       (SELECT COALESCE(SUM(capacity_mw), 0)     FROM power_plants ${where}) AS total_capacity_mw,
       (SELECT COUNT(DISTINCT country)           FROM power_plants ${where}) AS countries,
       (SELECT COUNT(DISTINCT primary_fuel)      FROM power_plants ${where}) AS fuels`,
      params: [...params, ...params, ...params, ...params],
    };
  }

  if (intent === "country_stats") {
    const { where, params } = buildWhere(query);
    const whereSql = where;
    const limitSql = limit ? " LIMIT ?" : "";
    if (limit) params.push(limit);

    return {
      sql: `SELECT country,
       COUNT(*)         AS plants,
       SUM(capacity_mw) AS capacity_mw
FROM power_plants
${whereSql}
GROUP BY country
ORDER BY capacity_mw DESC${limitSql}`,
      params,
    };
  }

  // plant_list：按单个电厂列出，容量降序
  if (intent === "plant_list") {
    const { where, params } = buildWhere(query, { requireCoords: true });
    // ⚠️ 强制带上 LIMIT。limit 缺省时用默认值，绝不生成无 LIMIT 的查询 ——
    //    那会把 34936 行明细全拉回前端并在表格里渲染。
    // ‼️ 阶段32：必须带 lat / lon —— 点击表格行要能飞到那座电厂。
    //    地图页的小表格会把这两列隐藏，设置页的完整表格则显示为「纬度 / 经度」。
    return {
      sql: `SELECT name,
       country,
       primary_fuel,
       capacity_mw,
       lat,
       lon
FROM power_plants
${where}
ORDER BY capacity_mw DESC
LIMIT ?`,
      params: [...params, plantListLimit(query)],
    };
  }

  // fuel_stats
  const { where, params } = buildWhere(query);
  const whereSql = where;

  return {
    sql: `SELECT primary_fuel,
       COUNT(*)         AS plants,
       SUM(capacity_mw) AS capacity_mw
FROM power_plants
${whereSql}
GROUP BY primary_fuel
ORDER BY capacity_mw DESC`,
    params,
  };
}

/** 生成给人看的「我理解成了什么」，界面会原样展示 */
export function describeQuery(query: ParsedQuery): string {
  const fuelText = query.fuel ? (FUEL_LABELS[query.fuel] ?? query.fuel) : null;
  const countryText = query.country ? countryLabel(query.country) : null;
  // 阶段31：视野限定要**如实说出来** —— 否则用户看到 3 座电厂会以为是数据错误
  const scope = query.viewport ? "当前视野内" : null;

  if (query.intent === "global_stats") {
    return scope ? "当前视野总量概览" : "全球总量概览";
  }

  if (query.intent === "plant_list") {
    const parts = ["按单个电厂列出（容量降序）"];
    if (scope) parts.push(`限定「${scope}」`);
    if (fuelText) parts.push(`只统计「${fuelText}」`);
    if (countryText) parts.push(`限定国家/地区「${countryText}」`);
    parts.push(`取容量前 ${query.limit ?? DEFAULT_PLANT_LIMIT} 座`);
    return parts.join("，");
  }

  const parts: string[] = [];
  if (query.intent === "country_stats") {
    parts.push(fuelText ? `按国家聚合 · 只统计「${fuelText}」` : "按国家聚合");
    if (countryText) parts.push(`限定国家/地区「${countryText}」`);
    if (scope) parts.push(`限定「${scope}」`);
    if (query.limit) parts.push(`取容量前 ${query.limit} 名`);
  } else {
    parts.push(countryText ? `按燃料聚合 · 只统计「${countryText}」` : "按燃料聚合");
    if (fuelText) parts.push(`限定燃料「${fuelText}」`);
    if (scope) parts.push(`限定「${scope}」`);
  }
  return parts.join("，");
}

/** 把一句自然语言解析成结构化查询 + 可直接执行的 SQL */
export function parseNaturalQuery(
  input: string,
  ctx?: QueryContext | null,
  history?: readonly ConversationTurn[] | null,
): ParseResult {
  const raw = input.trim();
  if (!raw) {
    return {
      ok: false,
      message: "请先输入一个问题。",
      suggestions: EXAMPLES,
    };
  }

  const text = raw.toLowerCase();

  // 阶段31：先判空间指代。命中但拿不到视野时必须**如实拒绝** ——
  // 静默按全球查是最误导的失败方式（用户会以为「这个区域」生效了）。
  const wantsViewport = VIEWPORT_WORDS.some((w) => text.includes(w));

  // 阶段33：追问。「那…呢」这类指代、且问题本身没给新范围时，继承上一轮的约束 ——
  // 否则「那最大的5个水电站呢？」会退化成全球查询，用户会以为 AI「忘了」刚才的视野。
  const prev = history?.length ? history[history.length - 1] : undefined;
  const followUp = !!prev && hasCoreference(text);
  const inheritViewport = wantsViewport || (followUp && !!prev?.query.viewport);

  if (inheritViewport && !ctx?.viewport) {
    return {
      ok: false,
      message:
        "这个问题需要「当前视野」，但地图还没上报视野（或地图尚未就绪）。请先切到地图页稍等片刻再试。",
      suggestions: EXAMPLES,
    };
  }

  const fuel = matchAlias(text, FUEL_ALIASES);
  const country = matchAlias(text, COUNTRY_ALIASES);
  const limit = findLimit(text);

  // ⚠️ 继承必须在 decideIntent **之前**算好：意图判定要看得到生效后的国家/燃料。
  const effFuel = fuel ?? (followUp ? prev?.query.fuel : undefined);
  const effCountry = country ?? (followUp ? prev?.query.country : undefined);

  const intent = decideIntent(text, effFuel, effCountry);
  if (!intent) {
    return {
      ok: false,
      message:
        "没看懂这个问题。目前支持三类：按国家聚合、按燃料类型聚合、全球总量概览。",
      suggestions: EXAMPLES,
    };
  }

  const query: ParsedQuery = { intent };
  if (effFuel) query.fuel = effFuel;
  if (effCountry) query.country = effCountry;
  // 追问时若没说「前几名」，沿用上一轮的条数（更贴合「记住了」的直觉）
  const effLimit = limit ?? (followUp ? prev?.query.limit : undefined);
  if (effLimit) query.limit = effLimit;
  if (inheritViewport && ctx?.viewport) query.viewport = ctx.viewport;

  return {
    ok: true,
    query,
    plan: buildSql(query),
    explanation: describeQuery(query),
  };
}

/**
 * 单一来源的 WHERE 构造（阶段31：四个 intent 全部改用它）。
 *
 * ⚠️ `requireCoords` 默认 false 是**故意的**：实测 34,936 行里约 1,012 行没有坐标，
 *    给 country/fuel/global 补上 `lat IS NOT NULL` 会让用户看到的全球电厂总数
 *    凭空少一千，看起来就像回归 bug。
 *    而带 viewport 时必然要求有坐标 —— 由 BETWEEN 隐含，不需重复判断。
 *
 * ⚠️ 值一律走参数绑定，绝不拼接用户输入。
 */
function buildWhere(
  query: ParsedQuery,
  opts?: { requireCoords?: boolean },
): {
  where: string;
  params: unknown[];
} {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (opts?.requireCoords) {
    // 没有坐标的点无法在地图上定位，所有地图相关查询都先排除
    conds.push("lat IS NOT NULL", "lon IS NOT NULL");
  }

  if (query.viewport) {
    const v = query.viewport;
    conds.push("lon BETWEEN ? AND ?", "lat BETWEEN ? AND ?");
    params.push(v.minLon, v.maxLon, v.minLat, v.maxLat);
  }

  if (query.fuel) {
    conds.push("primary_fuel = ?");
    params.push(query.fuel);
  }
  if (query.country) {
    conds.push("country = ?");
    params.push(query.country);
  }

  return {
    where: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}

/**
 * 求匹配结果的地理范围，供地图 fitBounds 使用。
 * bbox 完全由数据算出，不在代码里硬编码任何国家边界。
 */
export function buildBoundsSql(query: ParsedQuery): SqlPlan {
  const { where, params } = buildWhere(query, { requireCoords: true });

  // ⚠️ plant_list 是「取前 N 座」，bbox 必须只覆盖这 N 座。
  //    否则「全球前 10 大电厂」会去算全部 34936 个电厂的 bbox（≈ 整个地球），
  //    飞过去之后就是全球视野，根本看不到那 10 个点。
  if (query.intent === "plant_list") {
    return {
      sql: `SELECT MIN(lon) AS min_lon, MIN(lat) AS min_lat,
       MAX(lon) AS max_lon, MAX(lat) AS max_lat
FROM (SELECT lon, lat
      FROM power_plants
      ${where}
      ORDER BY capacity_mw DESC
      LIMIT ?)`,
      params: [...params, plantListLimit(query)],
    };
  }

  return {
    sql: `SELECT MIN(lon) AS min_lon, MIN(lat) AS min_lat,
       MAX(lon) AS max_lon, MAX(lat) AS max_lat
FROM power_plants
${where}`,
    params,
  };
}

/** plant_list 的条数：缺省用默认值，上限 50，避免拉回全部明细 */
function plantListLimit(query: ParsedQuery): number {
  return query.limit && query.limit > 0
    ? Math.min(query.limit, 50)
    : DEFAULT_PLANT_LIMIT;
}

/**
 * 求匹配的明细点，供地图高亮图层使用。
 * 多取一个（LIMIT +1）以便调用方判断是否超过了高亮上限。
 *
 * ⚠️ 阶段24 起带出 capacity_mw：高亮圆的半径也要按容量分级，
 *    否则「全球前10大电厂」高亮出来的点全是一样大的圈，
 *    反而看不出谁更大。
 */
export function buildHighlightSql(query: ParsedQuery): SqlPlan {
  const { where, params } = buildWhere(query, { requireCoords: true });

  // ⚠️ 同理：plant_list 的高亮只能是前 N 座，并且必须按容量降序取。
  //    不做这个限制的话，「全球前10大电厂」会去拉全部 34936 个点，
  //    直接被 MAX_HIGHLIGHT_POINTS 上限保护挡掉，结果是「只飞行、未高亮」。
  if (query.intent === "plant_list") {
    return {
      sql: `SELECT name, lat, lon, primary_fuel, capacity_mw
FROM power_plants
${where}
ORDER BY capacity_mw DESC
LIMIT ?`,
      params: [...params, plantListLimit(query)],
    };
  }

  return {
    sql: `SELECT name, lat, lon, primary_fuel, capacity_mw
FROM power_plants
${where}
LIMIT ${MAX_HIGHLIGHT_POINTS + 1}`,
    params,
  };
}
