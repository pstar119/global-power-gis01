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
  formatViewport,
  hasCoreference,
  type ConversationTurn,
  type Intent,
  type ParseResult,
  type ParsedQuery,
  type QueryContext,
} from "./nlq";

export type Provider = "deepseek" | "qwen" | "glm" | "ollama";

/** 云端厂商：URL 与默认模型固定，需要 API Key */
export type CloudProvider = Exclude<Provider, "ollama">;

interface ProviderConfig {
  label: string;
  url: string;
  model: string;
}

/**
 * 三家都提供 **OpenAI 兼容**的 chat/completions 接口，
 * 所以请求体格式完全一致，只有 URL 与模型名不同。
 */
export const PROVIDERS: Record<CloudProvider, ProviderConfig> = {
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

/** 下拉框里的全部选项（含本地）。label 单独放一份，免得 UI 为 ollama 做特判。 */
export const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: PROVIDERS.deepseek.label,
  qwen: PROVIDERS.qwen.label,
  glm: PROVIDERS.glm.label,
  ollama: "本地 Ollama（离线）",
};

export const PROVIDER_ORDER: readonly Provider[] = [
  "deepseek",
  "qwen",
  "glm",
  "ollama",
];

/** 本地 Ollama 的连接参数，由用户在设置页填写 */
export interface OllamaConfig {
  baseUrl: string;
  model: string;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

/**
 * 统一的 AI 配置。用可辨识联合表达，让「云端要 Key、本地要地址+模型」
 * 这件事在类型层面就无法写错 —— 不可能出现「本地模式却要求填 Key」。
 */
export type AiConfig =
  | { provider: CloudProvider; apiKey: string }
  | { provider: "ollama"; ollama: OllamaConfig };

/** 当前配置是否具备发起请求的条件（本地模式不看 Key） */
export function isConfigComplete(config: AiConfig): boolean {
  if (config.provider === "ollama") {
    return config.ollama.baseUrl.trim().length > 0 && config.ollama.model.trim().length > 0;
  }
  return config.apiKey.trim().length > 0;
}

/** 给用户看的一行摘要，用于状态提示与测试结果 */
export function describeConfig(config: AiConfig): string {
  return config.provider === "ollama"
    ? `本地 Ollama / ${config.ollama.model}`
    : `${PROVIDERS[config.provider].label} / ${PROVIDERS[config.provider].model}`;
}

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
  plant: "plant_list",
  // 容错：模型偶尔会照着内部命名输出
  country_stats: "country_stats",
  fuel_stats: "fuel_stats",
  global_stats: "global_stats",
  plant_list: "plant_list",
};

const SYSTEM_PROMPT = `你是一个把自然语言问题解析成结构化查询条件的解析器。你**不回答**问题本身，只输出查询条件。

只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块，不要前后缀。

字段说明：
- intent  必填，只能是 "country" | "fuel" | "global" | "plant"
    country = 按国家/地区**聚合**（问"哪些国家""国家排名"）
    fuel    = 按燃料类型**聚合**（问"燃料构成""占比""风电总容量"）
    global  = 全球总量概览（问"全球有多少电厂""总装机容量"）
    plant   = 列出**具体电厂**（问"前10大电厂""最大的5个水电站"）
- fuel    可选，只能取以下之一（大小写必须完全一致）：
    Coal, Gas, Oil, Nuclear, Hydro, Wind, Solar, Biomass,
    Geothermal, Waste, Storage, Cogeneration, Petcoke, Wave and Tidal, Other
- country 可选，国家/地区的 ISO3 三字母码，例如 CHN、USA、IND、DEU
- limit   可选，整数，表示"前 N 名"里的 N

【最容易搞错的一点】看到"电厂/电站/机组"这类**个体**名词时，intent 必须是 "plant"；
看到"国家/地区"这类**聚合**名词时，intent 才是 "country"。
两者都常与"最大""前N"一起出现，必须靠名词本身区分：
  全球前5大国家      -> country（比的是国家）
  全球前10大电厂     -> plant  （比的是电厂）
  中国最大的5个水电站 -> plant  （水电站是单个电厂）

输出格式：{"ok":true,"intent":"country","fuel":"Coal","limit":5}
无法理解、或与全球电力设施数据无关时：{"ok":false,"message":"简短说明原因"}

示例：
全球煤电装机容量排名前5的国家
{"ok":true,"intent":"country","fuel":"Coal","limit":5}
装机容量最大的5个国家
{"ok":true,"intent":"country","limit":5}
全球前10大电厂
{"ok":true,"intent":"plant","limit":10}
全球最大的电厂有哪些
{"ok":true,"intent":"plant","limit":10}
中国最大的5个水电站
{"ok":true,"intent":"plant","country":"CHN","fuel":"Hydro","limit":5}
美国最大的3个天然气电厂
{"ok":true,"intent":"plant","country":"USA","fuel":"Gas","limit":3}
中国有多少电厂
{"ok":true,"intent":"country","country":"CHN"}
全球风电总装机容量
{"ok":true,"intent":"fuel","fuel":"Wind"}
全球燃料类型占比
{"ok":true,"intent":"fuel"}
全球有多少电厂
{"ok":true,"intent":"global"}
今天天气怎么样
{"ok":false,"message":"该问题与全球电力设施数据无关"}`;

/**
 * 阶段31：把「当前视野」拼成提示词的一段。
 *
 * ⚠️ 没有上下文（地图未就绪 / 未上报视野）时返回**空串** ——
 *    提示词逐字不变，既有行为零回归。
 * ⚠️ 坐标由我们注入，模型只回答「要不要限定」：
 *    即使模型被提示词注入攻击，也改不动查询框的位置。
 */
function viewportPromptBlock(ctx?: QueryContext | null): string {
  const b = ctx?.viewport;
  if (!b) return "";

  const layers = ctx?.layers?.length ? ctx.layers.join("、") : "（未上报）";
  const midLat = (b.minLat + b.maxLat) / 2;
  const widthKm = Math.round(
    (b.maxLon - b.minLon) * 111 * Math.cos((midLat * Math.PI) / 180),
  );
  const zoomText = typeof ctx?.zoom === "number" ? `z≈${ctx.zoom.toFixed(1)}` : "z未知";

  return `

【当前视野 Current Viewport】
地图现在显示：${formatViewport(b)}（${zoomText}，约 ${widthKm} km 宽）。
用户当前勾选的图层：${layers}。
（这只是显示状态，不是筛选条件。本地数据库只有一张电厂表 power_plants，
包含 name / country / primary_fuel / capacity_mw / lat / lon，
**没有线路与变电站数据 —— 不要为电压等级、线路、变电站生成任何 SQL 条件**。）

判定规则：
- 只有当问题里出现空间指代（当前视野 / 视野内 / 这个区域 / 该区域 / 当前范围 / 屏幕里 / 这里 / 这一片 / 画面里）时，
  才额外输出 "inViewport": true，表示「只在上面这块矩形内查询」。
- **不要输出任何坐标数字**。你只负责说「要不要限定在视野内」，坐标由程序填入。
- 问题没有空间指代时，不要输出 inViewport（否则「全球前10大电厂」会被错误地锁死在视野内）。
- inViewport 可以与 country / fuel / limit 同时出现。
- 若问的是线路 / 变电站 / 电压等级，返回 {"ok":false,"message":"本地数据只有电厂，暂不支持线路与变电站查询"}。

示例：
当前视野里最大的5个电厂
{"ok":true,"intent":"plant","inViewport":true,"limit":5}
这个区域有多少电厂
{"ok":true,"intent":"global","inViewport":true}
当前视野内的国家排名
{"ok":true,"intent":"country","inViewport":true}
这里的风电装机容量
{"ok":true,"intent":"fuel","fuel":"Wind","inViewport":true}`;
}

/**
 * 阶段33：把「上一轮对话」拼成提示词的一段。
 * 没有历史时返回空串 —— 提示词逐字不变，零回归。
 */
function historyPromptBlock(history?: readonly ConversationTurn[] | null): string {
  if (!history?.length) return "";

  const lines = history.map((t, i) => {
    const parsed = JSON.stringify({
      intent: t.query.intent,
      ...(t.query.fuel ? { fuel: t.query.fuel } : {}),
      ...(t.query.country ? { country: t.query.country } : {}),
      ...(t.query.limit ? { limit: t.query.limit } : {}),
      ...(t.query.viewport ? { inViewport: true } : {}),
    });
    return `${i + 1}. 问：${t.question}\n   解析：${parsed}\n   说明：${t.summary}`;
  });

  return `

【对话上下文（最近的在最后；当前问题是最后一条的追问）】
${lines.join("\n")}

判定规则：\n- 出现「那…呢 / 还是 / 同样 / 那么」这类指代时，继承上一轮**未被改写**的约束（尤其是 inViewport 与国家/燃料），只替换用户显式改写的部分。\n- 问题自成完整语义时（例如「全球最大的5个水电站呢？」）**不要**继承。\n- 仍然不要输出坐标，inViewport 只是布尔值。\n\n示例：\n上一轮 {"intent":"plant","inViewport":true,"limit":10}\n那最大的5个水电站呢？\n{"ok":true,"intent":"plant","fuel":"Hydro","inViewport":true,"limit":5}`;
}

/** HTTP 状态码 -> 给用户看的可操作提示 */
function describeHttpError(
  status: number,
  body: string,
  label: string,
  model: string,
): string {
  const head = `${label} 返回 HTTP ${status}`;
  if (status === 401) return `${head}：API Key 无效或已过期，请检查后重填。`;
  if (status === 403) return `${head}：该 Key 无权访问 ${model} 模型。`;
  if (status === 404) return `${head}：模型 ${model} 不存在或接口地址有误。`;
  if (status === 429) return `${head}：请求过于频繁或额度已用尽，请稍后再试。`;
  if (status >= 500) return `${head}：服务端暂时不可用，请稍后重试。`;
  // 其它错误把响应体截断后带上，便于定位（内容来自服务端，不含我们的 Key）
  return `${head}：${body.slice(0, 200) || "（无响应体）"}`;
}

/**
 * Ollama 连不上时的提示。
 *
 * ⚠️ 这里**不假装能区分**「服务没启动」和「被 CSP 拦」—— 前端拿到的都是
 *    同一个 TypeError: Failed to fetch。所以如实列出两种可能并给出排查顺序。
 */
function describeOllamaUnreachable(base: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `无法连接到本地 Ollama，请确认 ollama serve 已运行。\n` +
    `  当前地址：${base}\n` +
    `  排查顺序：1) 终端执行 ollama serve；` +
    `2) 浏览器打开 ${base} 应看到 "Ollama is running"；` +
    `3) 若服务已运行仍失败，可能是应用未放行该地址（CSP）。\n` +
    `  底层错误：${detail}`
  );
}

type ChatOutcome = { ok: true; content: string } | { ok: false; message: string };

/**
 * 云端调用：OpenAI 兼容的 chat/completions。
 */
async function callOpenAiChat(
  provider: CloudProvider,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
): Promise<ChatOutcome> {
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
    return {
      ok: false,
      message: describeHttpError(res.status, text, cfg.label, cfg.model),
    };
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
 * 本地调用：Ollama **原生** `/api/chat` 协议（不是它的 OpenAI 兼容层）。
 *
 * ⚠️ 与 OpenAI 的三个关键差异，写错都不会报错、只会静默行为异常：
 *   1) `temperature` 必须放进 `options` 里。放顶层 Ollama 直接忽略，
 *      会退回默认 0.8，导致同样的输入输出不稳定、JSON 解析失败率上升。
 *   2) 限制输出长度是 `options.num_predict`，**不是** `max_tokens`。
 *   3) 必须 `stream: false`。否则返回的是 NDJSON 流，`res.json()` 会抛异常，
 *      而错误信息完全看不出真实原因。
 */
async function callOllamaChat(
  cfg: OllamaConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
): Promise<ChatOutcome> {
  // 容忍用户把地址写成 http://localhost:11434/
  const base = cfg.baseUrl.trim().replace(/\/+$/, "");
  const model = cfg.model.trim();

  if (!base) return { ok: false, message: "请先填写 Ollama 服务地址。" };
  if (!model) return { ok: false, message: "请先填写 Ollama 模型名称。" };

  const options: Record<string, unknown> = { temperature: 0 };
  if (maxTokens) options.num_predict = maxTokens;

  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: "POST",
      // 本地推理不需要也不应该带 Authorization
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, options }),
    });
  } catch (err) {
    return { ok: false, message: describeOllamaUnreachable(base, err) };
  }

  if (!res.ok) {
    if (res.status === 404) {
      return {
        ok: false,
        message:
          `Ollama 中没有模型「${model}」。\n` +
          `  请先在终端执行：ollama pull ${model}`,
      };
    }
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: describeHttpError(res.status, text, "本地 Ollama", model),
    };
  }

  try {
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, message: "Ollama 返回了空内容。" };
    }
    return { ok: true, content };
  } catch {
    return {
      ok: false,
      message:
        "Ollama 返回的响应不是合法 JSON。" +
        "（若服务端开启了流式输出，会出现这种症状）",
    };
  }
}

/** 按 provider 分派到对应的协议实现 */
async function callChatApi(
  config: AiConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
): Promise<ChatOutcome> {
  return config.provider === "ollama"
    ? callOllamaChat(config.ollama, messages, maxTokens)
    : callOpenAiChat(config.provider, config.apiKey, messages, maxTokens);
}

/**
 * 测试连接。
 *
 * 云端：发一个极小请求（max_tokens=1）验证 Key 是否有效。
 * 本地：改为查 `/api/tags` 列出模型 —— 比发聊天请求快得多，
 *       而且能顺便告诉用户「服务在，但你要的模型没拉」，这是最常见的失败原因。
 */
export async function testConnection(
  config: AiConfig,
): Promise<{ ok: boolean; message: string }> {
  if (config.provider === "ollama") {
    const base = config.ollama.baseUrl.trim().replace(/\/+$/, "");
    const model = config.ollama.model.trim();
    if (!base) return { ok: false, message: "请先填写 Ollama 服务地址。" };

    let res: Response;
    try {
      res = await fetch(`${base}/api/tags`);
    } catch (err) {
      return { ok: false, message: describeOllamaUnreachable(base, err) };
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Ollama 返回 HTTP ${res.status}，服务可能未正常启动。`,
      };
    }

    try {
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (data?.models ?? [])
        .map((m) => m.name ?? "")
        .filter(Boolean);
      if (!model) {
        return {
          ok: true,
          message: `已连接本地 Ollama（共 ${names.length} 个模型）。${
            names.length ? "可用：" + names.join("、") : "尚未拉取任何模型。"
          }`,
        };
      }
      // Ollama 的 name 可能带 :latest 后缀，做一次宽松匹配
      const hit = names.some(
        (n) => n === model || n.startsWith(`${model}:`) || model.startsWith(`${n}:`),
      );
      return hit
        ? { ok: true, message: `连接成功：本地 Ollama 中已存在模型 ${model}。` }
        : {
            ok: false,
            message:
              `已连接本地 Ollama，但其中没有模型「${model}」。\n` +
              `  请执行：ollama pull ${model}` +
              (names.length ? `\n  现有模型：${names.join("、")}` : ""),
          };
    } catch {
      return { ok: false, message: "Ollama 返回的响应不是合法 JSON。" };
    }
  }

  if (!config.apiKey.trim()) {
    return { ok: false, message: "请先填写 API Key。" };
  }

  const r = await callChatApi(config, [{ role: "user", content: "ping" }], 1);
  if (!r.ok) return { ok: false, message: r.message };

  return { ok: true, message: `连接成功：${describeConfig(config)} 可用。` };
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
function toParseResult(
  payload: unknown,
  ctx?: QueryContext | null,
  text?: string,
  history?: readonly ConversationTurn[] | null,
): ParseResult {
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

  const query: ParsedQuery = { intent };

  // ⚠️ 白名单校验：模型幻觉出的燃料名一律丢弃，绝不能进 SQL
  const fuel = String(obj.fuel ?? "");
  if (fuel && ALLOWED_FUELS.has(fuel)) query.fuel = fuel;

  const country = String(obj.country ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(country)) query.country = country;

  const limit = Number(obj.limit);
  if (Number.isFinite(limit) && limit >= 1 && limit <= 50) {
    query.limit = Math.round(limit);
  }

  // 阶段31：视野限定。
  // ⚠️ 模型只输出**布尔** inViewport，坐标一律取自调用方传入的地图快照 ——
  //    模型碰不到坐标，因此幻觉与提示词注入都不可能把查询框挪到别处。
  // ⚠️ 没有上下文时静默忽略：降级为不限视野的正常查询，绝不报错。
  if (obj.inViewport === true && ctx?.viewport) {
    query.viewport = ctx.viewport;
  }

  // 阶段33：追问的指代继承（确定性兜底）。
  // ‼️ 实测本地 qwen2.5:7b 在追问时**经常不输出** inViewport ——
  //    一旦漏掉，「那最大的5个水电站呢？」就会静默退回全球查询，
  //    把上一轮的地理框架丢掉（这恰恰是本阶段要保证的能力）。
  //    因此这里按与本地引擎 parseNaturalQuery 相同的判定补一条硬规则：
  //    出现指代词 + 上一轮带视野 + 本轮没换国家 + 模型没有已给出视野 → 继承上一轮视野。
  //    模型答极端情况（比如用户其实想换国家）由 |query.country| 拦住，不会误继承。
  if (!query.viewport && !query.country && ctx?.viewport && text && history?.length) {
    const prev = history[history.length - 1];
    if (prev?.query?.viewport && hasCoreference(text)) {
      query.viewport = prev.query.viewport;
    }
  }

  // 复用本地引擎的 SQL 生成与说明文案，保证两条路径行为完全一致
  return {
    ok: true,
    query,
    plan: buildSql(query),
    explanation: "由 AI 解析：" + describeQuery(query),
  };
}

/**
 * 与本地引擎同签名的解析入口（异步版）。
 *
 * `context` 为阶段31 新增的**可选**参数：不传时行为与之前逐字一致（向后兼容）。
 */
export async function parseQuery(
  userInput: string,
  config: AiConfig,
  context?: QueryContext | null,
  history?: readonly ConversationTurn[] | null,
): Promise<ParseResult> {
  const input = userInput.trim();
  if (!input) {
    return { ok: false, message: "请先输入一个问题。", suggestions: EXAMPLES };
  }
  if (!isConfigComplete(config)) {
    return {
      ok: false,
      message:
        config.provider === "ollama"
          ? "请先填写 Ollama 服务地址与模型名称。"
          : "请先填写 API Key。",
      suggestions: EXAMPLES,
    };
  }

  const r = await callChatApi(config, [
    {
      role: "system",
      content: SYSTEM_PROMPT + viewportPromptBlock(context) + historyPromptBlock(history),
    },
    { role: "user", content: input },
  ]);
  if (!r.ok) return { ok: false, message: r.message, suggestions: EXAMPLES };

  return toParseResult(extractJson(r.content), context, input, history);
}
