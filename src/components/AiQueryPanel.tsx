import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { countryLabel } from "../lib/country";
import { fuelLabel } from "../lib/fuel";
import {
  PROVIDERS,
  PROVIDER_ORDER,
  parseQuery,
  testConnection,
  type Provider,
} from "../lib/llm";
import { EXAMPLES, parseNaturalQuery, type ParseResult, type ParsedQuery } from "../lib/nlq";
import styles from "./AiQueryPanel.module.css";

/** 必须与 src-tauri/src/lib.rs 里的 DB_URL 一致 */
const DB_URL = "sqlite:global_power_gis.db";

/**
 * AI 配置存在 localStorage。
 * ⚠️ 刻意**不用 SQLite**：那要放开 capabilities 里的 `sql:allow-execute`，
 *    会毁掉「前端只能读库」这条防线，代价远大于收益。
 * ⚠️ 均为**明文**存储，界面上会明确提醒用户。
 */
const LS_KEYS = {
  enabled: "gpg.ai.enabled",
  provider: "gpg.ai.provider",
  apiKey: "gpg.ai.apiKey",
} as const;

/** 结果列名 -> 中文表头 */
const COLUMN_LABELS: Record<string, string> = {
  country: "国家/地区",
  primary_fuel: "燃料类型",
  plants: "电厂数量",
  capacity_mw: "装机容量",
  total_plants: "电厂总数",
  total_capacity_mw: "总装机容量",
  countries: "覆盖国家/地区",
  fuels: "燃料类型数",
};

type Row = Record<string, unknown>;

type QueryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "rejected"; message: string; suggestions: readonly string[] }
  | {
      status: "done";
      result: Extract<ParseResult, { ok: true }>;
      rows: Row[];
    }
  | { status: "error"; message: string };

/** 单元格按列做人类可读的格式化 */
function formatCell(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";

  if (key === "country") return countryLabel(String(value));
  if (key === "primary_fuel") return fuelLabel(String(value));

  if (key === "capacity_mw" || key === "total_capacity_mw") {
    const mw = Number(value);
    if (!Number.isFinite(mw)) return String(value);
    // 超过 1000 MW 用 GW 显示，否则原始数字太长不好读
    return mw >= 1000
      ? `${(mw / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GW`
      : `${mw.toLocaleString("zh-CN")} MW`;
  }

  if (typeof value === "number") return value.toLocaleString("zh-CN");
  return String(value);
}

/**
 * AI 查询测试面板。
 *
 * ⚠️ 本阶段**不接任何真实大模型 API**：解析由 `src/lib/nlq.ts` 的本地规则引擎完成。
 *    目的是先把「自然语言 -> SQL -> 本地数据」这条通路验证通。
 * ⚠️ 只读：这里永远只执行 SELECT（且 SQL 模板在 nlq.ts 里是常量，
 *    用户输入只作为绑定参数），`capabilities` 里也没有 `sql:allow-execute`。
 */
interface AiQueryPanelProps {
  /** 由父级注入：把查询意图交给地图页看（带 id 的指令由 AppLayout 生成） */
  onViewOnMap?: (query: ParsedQuery) => void;
}

function AiQueryPanel({ onViewOnMap }: AiQueryPanelProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<QueryState>({ status: "idle" });

  // ---- AI 配置（懒初始化自 localStorage，避免每帧都读） ----
  const [useAi, setUseAi] = useState(
    () => localStorage.getItem(LS_KEYS.enabled) === "1",
  );
  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(LS_KEYS.provider);
    return saved && saved in PROVIDERS ? (saved as Provider) : "deepseek";
  });
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(LS_KEYS.apiKey) ?? "",
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.enabled, useAi ? "1" : "0");
  }, [useAi]);
  useEffect(() => {
    localStorage.setItem(LS_KEYS.provider, provider);
  }, [provider]);
  useEffect(() => {
    localStorage.setItem(LS_KEYS.apiKey, apiKey);
  }, [apiKey]);

  /** 开关开启且 Key 非空，才走真实大模型 */
  const aiReady = useAi && apiKey.trim().length > 0;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testConnection({ provider, apiKey }));
    setTesting(false);
  };

  const run = async (question: string) => {
    setInput(question);

    setState({ status: "running" });

    // 唯一的分叉点：开关开启且填了 Key 就走真实大模型，否则回退到本地规则引擎
    const parsed = aiReady
      ? await parseQuery(question, { provider, apiKey })
      : parseNaturalQuery(question);

    if (!parsed.ok) {
      setState({
        status: "rejected",
        message: parsed.message,
        suggestions: parsed.suggestions,
      });
      return;
    }

    try {
      const db = await Database.load(DB_URL);
      // 值走参数绑定，绝不拼接进 SQL 字符串
      const rows = (await db.select(
        parsed.plan.sql,
        parsed.plan.params,
      )) as Row[];
      setState({ status: "done", result: parsed, rows });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const columns =
    state.status === "done" && state.rows.length > 0
      ? Object.keys(state.rows[0])
      : [];

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>AI 查询测试面板</h2>
      <p className={styles.hint}>
        用一句话查询本地数据库。支持三类问法：按国家聚合、按燃料类型聚合、
        全球总量概览。默认由**本地规则引擎**解析（
        <code>src/lib/nlq.ts</code>，离线可用）；开启下方开关后可改用
        **真实大模型**解析。
      </p>

      {/* ---------- 查询方式配置 ---------- */}
      <div className={styles.config}>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={useAi}
            onChange={(event) => setUseAi(event.target.checked)}
          />
          <span>使用真实 AI 解析（需自备 API Key）</span>
        </label>

        {useAi && (
          <div className={styles.configBody}>
            <div className={styles.configRow}>
              <label className={styles.configLabel} htmlFor="ai-provider">
                模型
              </label>
              <select
                id="ai-provider"
                className={styles.configSelect}
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as Provider)
                }
              >
                {PROVIDER_ORDER.map((key) => (
                  <option key={key} value={key}>
                    {PROVIDERS[key].label} · {PROVIDERS[key].model}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.configRow}>
              <label className={styles.configLabel} htmlFor="ai-key">
                API Key
              </label>
              <input
                id="ai-key"
                className={styles.configInput}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                aria-label="API Key"
              />
              <button
                type="button"
                className={styles.configBtn}
                onClick={() => {
                  setApiKey("");
                  setTestResult(null);
                }}
                disabled={!apiKey}
              >
                清除
              </button>
              <button
                type="button"
                className={styles.configBtn}
                onClick={() => void runTest()}
                disabled={testing || !apiKey.trim()}
              >
                {testing ? "测试中…" : "测试连接"}
              </button>
            </div>

            {testResult && (
              <p
                className={styles.testResult}
                data-state={testResult.ok ? "ok" : "error"}
              >
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </p>
            )}

            <p className={styles.warn}>
              ⚠️ API Key 以**明文**形式存储在本地（localStorage），
              请勿在公用电脑上使用。
            </p>
          </div>
        )}
      </div>

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void run(input);
        }}
      >
        <input
          className={styles.input}
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="例如：全球煤电装机容量排名前5的国家"
          aria-label="自然语言查询输入"
        />
        <button
          className={styles.submit}
          type="submit"
          disabled={state.status === "running" || !input.trim()}
        >
          {state.status === "running" ? "查询中…" : "查询"}
        </button>
      </form>

      <ul className={styles.examples}>
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              className={styles.exampleBtn}
              onClick={() => void run(example)}
            >
              {example}
            </button>
          </li>
        ))}
      </ul>

      {state.status === "running" && (
        <p className={styles.status} data-state="running">
          正在解析并查询…
        </p>
      )}

      {state.status === "rejected" && (
        <p className={styles.status} data-state="rejected">
          {state.message}
          {aiReady && (
            <>
              <br />
              若为 AI 调用失败，可关闭上方开关回退到本地规则引擎。
            </>
          )}
          <br />
          试试这些问法：{state.suggestions.join(" / ")}
        </p>
      )}

      {state.status === "error" && (
        <p className={styles.status} data-state="error">
          查询失败：{state.message}
        </p>
      )}

      {state.status === "done" && (
        <>
          <p className={styles.parsed}>
            识别结果：{state.result.explanation}
            {state.rows.length === 0 && "（没有匹配到任何数据）"}
          </p>

          {onViewOnMap && (
            <button
              type="button"
              className={styles.mapBtn}
              onClick={() => onViewOnMap(state.result.query)}
            >
              在地图上查看 →
            </button>
          )}

          {state.rows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th key={col}>{COLUMN_LABELS[col] ?? col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row, index) => (
                    <tr key={index}>
                      {columns.map((col) => (
                        <td key={col}>{formatCell(col, row[col])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 调试信息：本阶段验证「通路正确性」的核心证据 */}
          <div className={styles.debug}>
            <span className={styles.debugLabel}>
              SQL（仅供调试，值一律走参数绑定，未拼接用户输入）
            </span>
            <code>{state.result.plan.sql}</code>
            <span className={styles.debugLabel} style={{ marginTop: 6 }}>
              绑定参数
            </span>
            <code>{JSON.stringify(state.result.plan.params)}</code>
          </div>
        </>
      )}
    </section>
  );
}

export default AiQueryPanel;
