/**
 * AI 查询的**共用执行器**（阶段31）。
 *
 * 为什么单独抽一层：地图页的浮动查询框与设置页的 AI 面板必须走**同一套**
 * 「解析 → SQL → 取数」逻辑。否则两边很容易在「视野上下文怎么传」「什么时候
 * 回退到本地引擎」这类分叉点上悄悄产生不一致 —— 那是很难查的 bug。
 *
 * ⚠️ 只读：永远只执行 SELECT（SQL 模板在 `nlq.ts` 里是常量，用户输入只作为绑定参数）。
 *    `capabilities` 里也没有 `sql:allow-execute`。
 * ⚠️ 不引入任何新依赖：只用已有的 tauri-plugin-sql 与本地模块。
 */

import Database from "@tauri-apps/plugin-sql";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  PROVIDER_LABELS,
  isConfigComplete,
  parseQuery,
  type AiConfig,
  type Provider,
} from "./llm";
import {
  parseNaturalQuery,
  type ParseResult,
  type QueryContext,
} from "./nlq";

/** 必须与 src-tauri/src/lib.rs 里的 DB_URL 一致 */
const DB_URL = "sqlite:global_power_gis.db";

/** 结果列名 -> 中文表头。地图页查询框与设置页面板共用同一份，不各写一套。 */
export const COLUMN_LABELS: Record<string, string> = {
  name: "电厂名称",
  country: "国家/地区",
  primary_fuel: "燃料类型",
  plants: "电厂数量",
  capacity_mw: "装机容量",
  total_plants: "电厂总数",
  total_capacity_mw: "总装机容量",
  countries: "覆盖国家/地区",
  fuels: "燃料类型数",
};

export type Row = Record<string, unknown>;

export type QueryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "rejected"; message: string; suggestions: readonly string[] }
  | {
      status: "done";
      result: Extract<ParseResult, { ok: true }>;
      rows: Row[];
    }
  | { status: "error"; message: string };

/**
 * AI 配置存在 localStorage。
 * ⚠️ 刻意**不用 SQLite**：那要放开 capabilities 里的 `sql:allow-execute`，
 *    会毁掉「前端只能读库」这条防线，代价远大于收益。
 * ⚠️ 均为**明文**存储，设置页会明确提醒用户。
 * ⚠️ 这是**唯一**一份键名定义：设置页与地图页查询框共用，改一处两边同时生效。
 */
export const LS_KEYS = {
  enabled: "gpg.ai.enabled",
  provider: "gpg.ai.provider",
  apiKey: "gpg.ai.apiKey",
  // 本地 Ollama 的配置用**独立** key，与云端互不干扰：
  // 从 Ollama 切回 DeepSeek 时 API Key 依然在，反之亦然。
  ollamaUrl: "gpg.ai.ollamaUrl",
  ollamaModel: "gpg.ai.ollamaModel",
} as const;

/**
 * 读取设置页保存的 AI 配置。
 *
 * 地图页查询框**没有**配置界面，它在每次提问时现读 localStorage ——
 * 这样用户在设置页改了开关或模型，地图页立刻生效（三个页面是常驻挂载的，
 * 若用 useState 缓存，改完配置不重挂载就永远读不到新值）。
 */
export function readStoredAiConfig(): { config: AiConfig; enabled: boolean } {
  const saved = localStorage.getItem(LS_KEYS.provider);
  const provider: Provider =
    saved && saved in PROVIDER_LABELS ? (saved as Provider) : "deepseek";

  const config: AiConfig =
    provider === "ollama"
      ? {
          provider: "ollama",
          ollama: {
            baseUrl:
              localStorage.getItem(LS_KEYS.ollamaUrl) ?? DEFAULT_OLLAMA_BASE_URL,
            model:
              localStorage.getItem(LS_KEYS.ollamaModel) ?? DEFAULT_OLLAMA_MODEL,
          },
        }
      : { provider, apiKey: localStorage.getItem(LS_KEYS.apiKey) ?? "" };

  const on = localStorage.getItem(LS_KEYS.enabled) === "1";
  return { config, enabled: on && isConfigComplete(config) };
}

export interface RunAiQueryOptions {
  /**
   * 空间上下文（阶段31）：地图视野 + 已选图层。
   * 不传 / 传 null 时行为与阶段30 之前完全一致（不限视野）。
   */
  context?: QueryContext | null;
  /**
   * 传 `null` 表示**强制走本地规则引擎**（离线可用、确定性）；
   * 不传则等价于「没有可用配置」，同样回退本地。
   */
  config?: AiConfig | null;
}

/**
 * 执行一次自然语言查询。
 *
 * 返回值直接就是界面要的 `QueryState`，两个调用点各自 `setState(...)` 即可，
 * 不再需要各自复刻一遍错误分支。
 */
export async function runAiQuery(
  question: string,
  opts: RunAiQueryOptions = {},
): Promise<QueryState> {
  const parsed = opts.config
    ? await parseQuery(question, opts.config, opts.context)
    : parseNaturalQuery(question, opts.context);

  if (!parsed.ok) {
    return {
      status: "rejected",
      message: parsed.message,
      suggestions: parsed.suggestions,
    };
  }

  // 把真正执行的 SQL 打出来：验证「当前视野」有没有进 SQL 全靠它，
  // 排查「为什么结果不对」时也是第一现场。
  console.debug(
    "[aiQuery] SQL:",
    parsed.plan.sql.replace(/\s+/g, " ").trim(),
    "params:",
    parsed.plan.params,
  );

  try {
    const db = await Database.load(DB_URL);
    const rows = (await db.select(
      parsed.plan.sql,
      parsed.plan.params,
    )) as Row[];
    return { status: "done", result: parsed, rows };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
