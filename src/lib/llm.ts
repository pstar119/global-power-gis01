/**
 * 真实大模型解析器：把自然语言问题交给大模型解析成 `ParsedQuery`。
 *
 * 设计要点（与 `nlq.ts` 的分工）：
 *   - `nlq.ts`  = 本地规则引擎，同步、零依赖、离线可用
 *   - `llm.ts`  = 大模型解析，异步、需要 API Key
 *   两者返回**同一个 `ParseResult` 契约**，所以 SQL 生成、参数绑定、执行、
 *   渲染全部复用，调用方只需在「解析」这一步分叉。
 *
 * ⚠️ 让模型只输出 `ParsedQuery`（结构化意图），而**不是让它直接写 SQL**：
 *    这样即使模型产生幻觉，也只能在受控的枚举值里出错，
 *    不可能拼出任意 SQL 语句。
 * ⚠️ 安全：不引入任何官方 SDK，只用原生 `fetch`；API Key 只从调用方传入，
 *    本模块不读取、不缓存、不打印它。
 */

import {
  EXAMPLES,
  buildSql,
  describeQuery,
  type Intent,
  type ParseResult,
} from "./nlq";

export type Provider = "deepseek" | "qwen" | "glm";

interface ProviderConfig {
  label: string;
  url: string;
  model: string;
}

/**
 * 三家都提供 **OpenAI 兼容**的 chat/completions 接口，
 * 所以请求体格式完全一致，只有 URL 与模型名不同。
 */
export const PROVIDERS: Record<Provider, ProviderConfig> = {
  deepseek: {
    label: "DeepSeek",
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
  },
  qwen: {
    label: "Qwen 阿里百炼",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
  },
  glm: {
    label: "GLM 智谱",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
  },
};

export const PROVIDER_ORDER: readonly Provider[] = ["deepseek", "qwen", "glm"];

/** 模型允许输出的燃料枚举（与 WRI 数据一致），用于**二次校验**模型输出 */
const ALLOWED_FUELS: ReadonlySet<string> = new Set([
  "Coal",
  "Gas",
  "Oil",
  "Nuclear",
  "Hydro",
  "Wind",
  "Solar",
  "Biomass",
  "Geothermal",
  "Waste",
  "Storage",
  "Cogeneration",
  "Petcoke",
  "Wave and Tidal",
  "Other",
]);

/** 模型输出里 intent 的取值 -> 内部意图名 */
const INTENT_MAP: Record<string, Intent> = {
  country: "country_stats",
  fuel: "fuel_stats",
  global: "global_stats",
  // 容错：模型偶尔会照着内部命名输出
  country_stats: "country_stats",
  fuel_stats: "fuel_stats",
  global_stats: "global_stats",
};

const SYSTEM_PROMPT = `你是一个把自然语言问题解析成结构化查询条件的解析器。你**不回答**问题本身，只输出查询条件。

只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块，不要前后缀。

字段说明：
- intent  必填，只能是 "country" | "fuel" | "global"
    country = 按国家/地区聚合（问"哪些国家""排名""中国"等）
    fuel    = 按燃料类型聚合（问"燃料构成""占比""风电总容量"等）
    global  = 全球总量概览（问"全球有多少电厂""总装机容量"等）
- fuel    可选，只能取以下之一（大小写必须完全一致）：
    Coal, Gas, Oil, Nuclear, Hydro, Wind, Solar, Biomass,
    Geothermal, Waste, Storage, Cogeneration, Petcoke, Wave and Tidal, Other
- country 可选，国家/地区的 ISO3 三字母码，例如 CHN、USA、IND、DEU
- limit   可选，整数，表示"前 N 名"里的 N

输出格式：{"ok":true,"intent":"country","fuel":"Coal","limit":5}
无法理解、或与全球电力设施数据无关时：{"ok":false,"message":"简短说明原因"}

示例：
全球煤电装机容量排名前5的国家
{"ok":true,"intent":"country","fuel":"Coal","limit":5}
中国有多少电厂
{"ok":true,"intent":"country","country":"CHN"}
全球风电总装机容量
{"ok":true,"intent":"fuel","fuel":"Wind"}
全球燃料类型占比
{"ok":true,"intent":"fuel"}
装机容量最大的5个国家
{"ok":true,"intent":"country","limit":5}
全球有多少电厂
{"ok":true,"intent":"global"}
今天天气怎么样
{"ok":false,"message":"该问题与全球电力设施数据无关"}`;

/** HTTP 状态码 -> 给用户看的可操作提示 */
function describeHttpError(
  status: number,
  body: string,
  provider: ProviderConfig,
): string {
  const head = `${provider.label} 返回 HTTP ${status}`;
  if (status === 401) return `${head}：API Key 无效或已过期，请检查后重填。`;
  if (status === 403) return `${head}：该 Key 无权访问 ${provider.model} 模型。`;
  if (status === 404) return `${head}：模型 ${provider.model} 不存在或接口地址有误。`;
  if (status === 429) return `${head}：请求过于频繁或额度已用尽，请稍后再试。`;
  if (status >= 500) return `${head}：服务端暂时不可用，请稍后重试。`;
  // 其它错误把响应体截断后带上，便于定位（内容来自服务端，不含我们的 Key）
  return `${head}：${body.slice(0, 200) || "（无响应体）"}`;
}

/**
 * 从模型返回的文本里抠出 JSON。
 * 即便提示词禁止了 markdown，实际仍可能被包在 ```json 里，所以要兜住。
 */
function extractJson(raw: string): unknown {
  let text = raw.trim();

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // 再退一步：截取第一个 { 到最后一个 } 之间的内容
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 把模型输出转成内部的 ParseResult，并对所有值做白名单校验 */
function toParseResult(payload: unknown): ParseResult {
  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      message: "AI 返回的内容不是合法 JSON，无法解析。",
      suggestions: EXAMPLES,
    };
  }

  const obj = payload as Record<string, unknown>;

  if (obj.ok === false) {
    return {
      ok: false,
      message:
        typeof obj.message === "string" && obj.message
          ? obj.message
          : "AI 认为这个问题无法映射成对本地电力数据的查询。",
      suggestions: EXAMPLES,
    };
  }

  const intent = INTENT_MAP[String(obj.intent ?? "")];
  if (!intent) {
    return {
      ok: false,
      message: `AI 返回了无法识别的查询意图：${String(obj.intent ?? "(空)")}`,
      suggestions: EXAMPLES,
    };
  }

  const query: { intent: Intent; fuel?: string; country?: string; limit?: number } =
    { intent };

  // ⚠️ 白名单校验：模型幻觉出的燃料名一律丢弃，绝不能进 SQL
  const fuel = String(obj.fuel ?? "");
  if (fuel && ALLOWED_FUELS.has(fuel)) query.fuel = fuel;

  const country = String(obj.country ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(country)) query.country = country;

  const limit = Number(obj.limit);
  if (Number.isFinite(limit) && limit >= 1 && limit <= 50) {
    query.limit = Math.round(limit);
  }

  // 复用本地引擎的 SQL 生成与说明文案，保证两条路径行为完全一致
  return {
    ok: true,
    query,
    plan: buildSql(query),
    explanation: "由 AI 解析：" + describeQuery(query),
  };
}

async function callChatApi(
  provider: Provider,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { ok: false, message: `不支持的模型：${provider}` };

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0,
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 走到这里通常是网络层问题（断网、DNS、被 CSP/CORS 拦）
    return {
      ok: false,
      message: `请求发不出去：${
        err instanceof Error ? err.message : String(err)
      }（请检查网络连接）`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: describeHttpError(res.status, text, cfg) };
  }

  try {
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, message: "AI 返回了空内容。" };
    }
    return { ok: true, content };
  } catch {
    return { ok: false, message: "AI 返回的响应不是合法 JSON。" };
  }
}

/**
 * 测试连接：发一个极小请求（max_tokens=1）只为验证 Key 是否有效，
 * 比拿真实查询去撞库友好得多。
 */
export async function testConnection(options: {
  provider: Provider;
  apiKey: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!options.apiKey.trim()) {
    return { ok: false, message: "请先填写 API Key。" };
  }

  const r = await callChatApi(
    options.provider,
    options.apiKey.trim(),
    [{ role: "user", content: "ping" }],
    1,
  );
  if (!r.ok) return { ok: false, message: r.message };

  return {
    ok: true,
    message: `连接成功：${PROVIDERS[options.provider].label} / ${PROVIDERS[options.provider].model} 可用。`,
  };
}

/** 与本地引擎同签名的解析入口（异步版） */
export async function parseQuery(
  userInput: string,
  options: { provider: Provider; apiKey: string },
): Promise<ParseResult> {
  const input = userInput.trim();
  if (!input) {
    return { ok: false, message: "请先输入一个问题。", suggestions: EXAMPLES };
  }
  if (!options.apiKey.trim()) {
    return { ok: false, message: "请先填写 API Key。", suggestions: EXAMPLES };
  }

  const r = await callChatApi(options.provider, options.apiKey.trim(), [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input },
  ]);
  if (!r.ok) return { ok: false, message: r.message, suggestions: EXAMPLES };

  return toParseResult(extractJson(r.content));
}
