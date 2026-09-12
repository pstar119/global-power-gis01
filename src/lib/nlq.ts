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
  const m =
    text.match(/(?:前|top|排名前|最大的?|最高的?)\s*(\d{1,2})/i) ??
    text.match(/(\d{1,2})\s*(?:个|名|位)/);
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
  const { intent, fuel, country, limit } = query;

  if (intent === "global_stats") {
    return {
      sql: `SELECT (SELECT COUNT(*)                     FROM power_plants) AS total_plants,
       (SELECT SUM(capacity_mw)             FROM power_plants) AS total_capacity_mw,
       (SELECT COUNT(DISTINCT country)      FROM power_plants) AS countries,
       (SELECT COUNT(DISTINCT primary_fuel) FROM power_plants) AS fuels`,
      params: [],
    };
  }

  if (intent === "country_stats") {
    const where: string[] = [];
    const params: unknown[] = [];

    if (fuel) {
      where.push("primary_fuel = ?");
      params.push(fuel);
    }
    if (country) {
      where.push("country = ?");
      params.push(country);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
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
    const { where, params } = buildFilter(query);
    // ⚠️ 强制带上 LIMIT。limit 缺省时用默认值，绝不生成无 LIMIT 的查询 ——
    //    那会把 34936 行明细全拉回前端并在表格里渲染。
    return {
      sql: `SELECT name,
       country,
       primary_fuel,
       capacity_mw
FROM power_plants
${where}
ORDER BY capacity_mw DESC
LIMIT ?`,
      params: [...params, plantListLimit(query)],
    };
  }

  // fuel_stats
  const where: string[] = [];
  const params: unknown[] = [];

  if (country) {
    where.push("country = ?");
    params.push(country);
  }
  if (fuel) {
    where.push("primary_fuel = ?");
    params.push(fuel);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

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

  if (query.intent === "global_stats") return "全球总量概览";

  if (query.intent === "plant_list") {
    const parts = ["按单个电厂列出（容量降序）"];
    if (fuelText) parts.push(`只统计「${fuelText}」`);
    if (countryText) parts.push(`限定国家/地区「${countryText}」`);
    parts.push(`取容量前 ${query.limit ?? DEFAULT_PLANT_LIMIT} 座`);
    return parts.join("，");
  }

  const parts: string[] = [];
  if (query.intent === "country_stats") {
    parts.push(fuelText ? `按国家聚合 · 只统计「${fuelText}」` : "按国家聚合");
    if (countryText) parts.push(`限定国家/地区「${countryText}」`);
    if (query.limit) parts.push(`取容量前 ${query.limit} 名`);
  } else {
    parts.push(countryText ? `按燃料聚合 · 只统计「${countryText}」` : "按燃料聚合");
    if (fuelText) parts.push(`限定燃料「${fuelText}」`);
  }
  return parts.join("，");
}

/** 把一句自然语言解析成结构化查询 + 可直接执行的 SQL */
export function parseNaturalQuery(input: string): ParseResult {
  const raw = input.trim();
  if (!raw) {
    return {
      ok: false,
      message: "请先输入一个问题。",
      suggestions: EXAMPLES,
    };
  }

  const text = raw.toLowerCase();
  const fuel = matchAlias(text, FUEL_ALIASES);
  const country = matchAlias(text, COUNTRY_ALIASES);
  const limit = findLimit(text);

  const intent = decideIntent(text, fuel, country);
  if (!intent) {
    return {
      ok: false,
      message:
        "没看懂这个问题。目前支持三类：按国家聚合、按燃料类型聚合、全球总量概览。",
      suggestions: EXAMPLES,
    };
  }

  const query: ParsedQuery = { intent };
  if (fuel) query.fuel = fuel;
  if (country) query.country = country;
  if (limit) query.limit = limit;

  return {
    ok: true,
    query,
    plan: buildSql(query),
    explanation: describeQuery(query),
  };
}

/**
 * 构造筛选条件（与 buildSql 保持一致）。
 * ⚠️ 值一律走参数绑定，绝不拼接用户输入。
 */
function buildFilter(query: ParsedQuery): {
  where: string;
  params: unknown[];
} {
  // 没有坐标的点无法在地图上定位，所有地图相关查询都先排除
  const conds: string[] = ["lat IS NOT NULL", "lon IS NOT NULL"];
  const params: unknown[] = [];

  if (query.fuel) {
    conds.push("primary_fuel = ?");
    params.push(query.fuel);
  }
  if (query.country) {
    conds.push("country = ?");
    params.push(query.country);
  }

  return { where: `WHERE ${conds.join(" AND ")}`, params };
}

/**
 * 求匹配结果的地理范围，供地图 fitBounds 使用。
 * bbox 完全由数据算出，不在代码里硬编码任何国家边界。
 */
export function buildBoundsSql(query: ParsedQuery): SqlPlan {
  const { where, params } = buildFilter(query);

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
  const { where, params } = buildFilter(query);

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
