#!/usr/bin/env node
/**
 * ============================================================================
 *  ⚠️ 这是 Mock 服务，不是真实 Ollama ⚠️
 *
 *  用途：在**没有安装 Ollama** 的机器上验证前端接入链路是否通：
 *        · 应用 CSP 是否放行 http://localhost:11434
 *        · 前端发出的请求体是否符合 Ollama /api/chat 规范
 *          （stream:false、temperature 在 options 内、不带 Authorization）
 *        · 响应解析与表格渲染是否正确
 *
 *  真实环境需自行安装 Ollama：https://ollama.com/download
 *        ollama serve
 *        ollama pull qwen2.5:7b
 *
 *  零依赖：只用 Node 内置 http 模块。
 *
 *  用法：
 *    node scripts/mock_ollama.mjs                  # 正常模式
 *    node scripts/mock_ollama.mjs --no-cors        # 故意不发 CORS 头，用于复现跨域失败
 *    node scripts/mock_ollama.mjs --missing-model  # /api/chat 一律返回 404，复现「模型不存在」
 *    node scripts/mock_ollama.mjs --offline        # 启动后立即退出，复现「服务未运行」
 * ============================================================================
 */
import http from "node:http";

const PORT = 11434;
const args = new Set(process.argv.slice(2));
const SEND_CORS = !args.has("--no-cors");
const ALWAYS_404 = args.has("--missing-model");

/** Mock 里「已安装」的模型，用于让 /api/tags 的校验逻辑有东西可比对 */
const MODELS = ["qwen2.5:7b", "deepseek-r1:7b", "llama3.2:3b"];

const banner = (text) => console.log(`\n${"=".repeat(66)}\n${text}\n${"=".repeat(66)}`);

banner(
  "⚠️  Mock Ollama（模拟环境）\n" +
    "   本服务不是真实 Ollama，仅用于验证前端接入链路。\n" +
    "   真实环境请自行安装：https://ollama.com/download",
);
console.log(`  监听端口 : ${PORT}`);
console.log(`  CORS     : ${SEND_CORS ? "开启（模拟真实 Ollama）" : "关闭（用于复现跨域失败）"}`);
console.log(`  模型列表 : ${MODELS.join("、")}`);
if (ALWAYS_404) console.log("  模式     : /api/chat 一律返回 404");

/** 把自然语言问题映射成应用期望的 ParsedQuery JSON —— 模拟模型的输出 */
function decideIntent(text) {
  const t = text.trim();
  if (/煤/.test(t) && /(前\s*\d|排名|top)/i.test(t)) {
    return { ok: true, intent: "country", fuel: "Coal", limit: 5 };
  }
  if (/气/.test(t) && /(前\s*\d|排名|top)/i.test(t)) {
    return { ok: true, intent: "country", fuel: "Gas", limit: 5 };
  }
  if (/中国|CHN/i.test(t)) return { ok: true, intent: "country", country: "CHN" };
  if (/美国|USA/i.test(t)) return { ok: true, intent: "country", country: "USA" };
  if (/风电|风能/.test(t)) return { ok: true, intent: "fuel", fuel: "Wind" };
  if (/光伏|太阳能/.test(t)) return { ok: true, intent: "fuel", fuel: "Solar" };
  if (/水电/.test(t)) return { ok: true, intent: "fuel", fuel: "Hydro" };
  if (/核电/.test(t)) return { ok: true, intent: "fuel", fuel: "Nuclear" };
  if (/燃料.*(占比|比例|分布)|按燃料/.test(t)) return { ok: true, intent: "fuel" };
  if (/(多少|总数|总量)/.test(t)) return { ok: true, intent: "global" };
  return { ok: false, message: "（Mock）该问题与全球电力设施数据无关" };
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  const cors = SEND_CORS
    ? {
        // 真实 Ollama 会回 Allow-Origin；这里按请求的 Origin 回显，等价于放宽到任意来源
        "Access-Control-Allow-Origin": req.headers.origin ?? "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    : {};

  console.log(`\n[${new Date().toLocaleTimeString()}] ${req.method} ${url}`);
  if (req.headers.origin) console.log(`  Origin : ${req.headers.origin}`);
  // 关键证据：必须看不到 Authorization（本地推理不应该带 Key）
  console.log(`  Authorization: ${req.headers.authorization ?? "（无，符合预期）"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // 根路径给出与真实 Ollama 一致的自述文案
  if (url === "/" && req.method === "GET") {
    res.writeHead(200, { ...cors, "Content-Type": "text/plain" });
    res.end("Ollama is running（Mock）");
    return;
  }

  if (url === "/api/tags" && req.method === "GET") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: MODELS.map((name) => ({ name })) }));
    return;
  }

  if (url === "/api/chat" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 交给下面的字段检查兜底 */
      }

      // 逐项打印请求体，供人工对照 Ollama 规范
      console.log(`  model        : ${body.model}`);
      console.log(`  stream       : ${body.stream}   ${body.stream === false ? "✓" : "✗ 必须为 false"}`);
      console.log(
        `  options      : ${JSON.stringify(body.options ?? null)}` +
          (body.options && "temperature" in body.options
            ? "   ✓ temperature 在 options 内"
            : "   ✗ 缺少 options.temperature（会被 Ollama 忽略）"),
      );
      if ("temperature" in body) console.log("  ⚠️ 顶层出现了 temperature，Ollama 会忽略它");
      if ("max_tokens" in body) console.log("  ⚠️ 出现了 max_tokens，Ollama 不认这个字段（应为 options.num_predict）");

      if (ALWAYS_404) {
        res.writeHead(404, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model not found" }));
        return;
      }

      const userMsg = (body.messages ?? [])
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join(" ");
      const intent = decideIntent(userMsg);
      console.log(`  用户问题     : ${userMsg}`);
      console.log(`  -> 返回意图  : ${JSON.stringify(intent)}`);

      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      // 严格按 Ollama /api/chat 的响应结构：内容在 message.content
      res.end(
        JSON.stringify({
          model: body.model ?? "mock",
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: JSON.stringify(intent) },
          done: true,
          done_reason: "stop",
          // 这行是为了让人一眼看出响应来自 mock
          mock: true,
        }),
      );
    });
    return;
  }

  res.writeHead(404, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

if (args.has("--offline")) {
  banner("已按 --offline 启动并立即退出，用于复现「服务未运行」");
  process.exit(0);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n✅ Mock Ollama 已启动: http://localhost:${PORT}`);
  console.log("   在应用中把「服务地址」填 http://localhost:11434 即可联调。");
  console.log("   Ctrl+C 退出。\n");
});
