/**
 * 国家/地区的 ISO3 码与中文名 —— **唯一数据源**。
 *
 * 统计页用它把 `CHN` 显示成「中国」；自然语言查询用它做反向解析
 * （把用户说的「中国」还原成 `CHN`）。两边共用一份，避免各写一套。
 *
 * ⚠️ 刻意只内置一张常用国家小字典，不为显示国家全名去装
 *    i18n-iso-countries 之类的包。未命中的直接显示原始 ISO3 码。
 */

export const COUNTRY_LABELS: Record<string, string> = {
  CHN: "中国",
  USA: "美国",
  IND: "印度",
  RUS: "俄罗斯",
  JPN: "日本",
  DEU: "德国",
  GBR: "英国",
  FRA: "法国",
  BRA: "巴西",
  CAN: "加拿大",
  KOR: "韩国",
  ITA: "意大利",
  ESP: "西班牙",
  AUS: "澳大利亚",
  TUR: "土耳其",
  MEX: "墨西哥",
  IDN: "印尼",
  SAU: "沙特",
  ZAF: "南非",
  VNM: "越南",
  POL: "波兰",
  THA: "泰国",
  EGY: "埃及",
  IRN: "伊朗",
  ARE: "阿联酋",
  NLD: "荷兰",
  PAK: "巴基斯坦",
  ARG: "阿根廷",
  SWE: "瑞典",
  NOR: "挪威",
};

/** 拿不到中文名时退回原始 ISO3 码，而不是显示空白 */
export function countryLabel(code: string | null | undefined): string {
  if (!code) return "未知";
  return COUNTRY_LABELS[code] ?? code;
}

/**
 * 自然语言里可能出现的国家说法 -> ISO3。
 *
 * 由 COUNTRY_LABELS **反向生成**，所以新增国家只需改上面那张表，
 * 不用在两处同步维护。除了中文名，也接受 ISO3 码本身（大小写不敏感）。
 */
export const COUNTRY_ALIASES: ReadonlyArray<readonly [string, string]> =
  Object.entries(COUNTRY_LABELS).flatMap(([code, zh]) => [
    [zh, code] as const,
    [code.toLowerCase(), code] as const,
  ]);
