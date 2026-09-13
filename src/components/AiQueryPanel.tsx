import { useEffect, useState, type RefObject } from "react";
import { countryLabel } from "../lib/country";
import { fuelLabel } from "../lib/fuel";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  isConfigComplete,
  testConnection,
  type AiConfig,
  type Provider,
} from "../lib/llm";
import {
  EXAMPLES,
  formatViewport,
  samePlant,
  toPlantFocus,
  type ConversationTurn,
  type ParsedQuery,
  type PlantFocus,
  type QueryContext,
} from "../lib/nlq";
// 阶段31：解析 / SQL / 取数与地图页浮动查询框**完全共用**，避免两份实现分道扬镳
import {
  COLUMN_LABELS,
  LS_KEYS,
  runAiQuery,
  type QueryState,
} from "../lib/aiQuery";
import styles from "./AiQueryPanel.module.css";

type Row = Record<string, unknown>;

/**
 * CSV 单元格转义（RFC 4180）。
 *
 * ⚠️ 电厂名称里出现逗号或引号是很常见的事（如 `Test, Inc.`），
 *    不转义的话 Excel 打开会**整行错列**。规则：
 *      含 , " \r \n 时用双引号包裹，且内部的双引号要翻倍。
 */
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把单元格换成**适合 CSV 的原始值**。
 *
 * ⚠️ 与表格显示的 `formatCell` 刻意不同：容量导出原始 MW 数值，不带单位。
 *    CSV 的用途是丢给 Excel 做透视表/排序，带 "955.7 GW" 这种字符串无法计算。
 *    国家与燃料这类**标签列**仍导出中文，保持可读。
 */
function csvValue(key: string, value: unknown): unknown {
  if (value == null) return "";
  if (key === "country") return countryLabel(String(value));
  if (key === "primary_fuel") return fuelLabel(String(value));
  if (key === "capacity_mw" || key === "total_capacity_mw") {
    const n = Number(value);
    return Number.isFinite(n) ? n : "";
  }
  return value;
}

/** 导出成功后给用户的提示 */
type ExportState = { ok: boolean; message: string } | null;

/**
 * 把查询结果拼成 CSV 并触发下载。
 *
 * 红线：不引 papaparse / xlsx，不装 plugin-dialog，全部原生能力。
 */
function downloadCsv(
  columns: readonly string[],
  rows: readonly Row[],
): { ok: boolean; message: string } {
  if (columns.length === 0 || rows.length === 0) {
    return { ok: false, message: "当前没有可导出的数据。" };
  }

  const header = columns.map((c) => csvCell(COLUMN_LABELS[c] ?? c)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => csvCell(csvValue(c, row[c]))).join(","),
  );

  // ⚠️ BOM 必不可少：不加的话 Excel 会把 UTF-8 当成 ANSI 读，中文全是乱码。
  //    \r\n 也是刻意的（RFC 4180），部分 Excel 版本会把 \n 当成行内换行。
  const csv = "\uFEFF" + [header, ...body].join("\r\n");

  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, "-");
    a.download = `电力设施查询_${ts}.csv`;
    a.click();

    // ⚠️ 必须**延迟** revoke：下载是异步发起的，立刻撤销会让下载取消或拿到空文件。
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, message: `已导出 ${rows.length} 行（含表头，UTF-8 BOM）。` };
  } catch (err) {
    return {
      ok: false,
      message: `导出失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 单元格按列做人类可读的格式化 */
function formatCell(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";

  // 阶段32：坐标保留 4 位小数（约 11 米精度）。原始浮点串太长，读起来费劲
  if (key === "lat" || key === "lon") {
    const v = Number(value);
    return Number.isFinite(v) ? v.toFixed(4) : String(value);
  }

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
  /** 发起新查询前，先把地图上的旧高亮清掉 */
  onClearMap?: () => void;
  /**
   * 当前视野上下文（阶段31）。
   * 用 ref 传：提问瞬间读权威值，不受展示副本的防抖延迟影响。
   */
  viewportRef?: RefObject<QueryContext | null>;
  /** 值变化 = 视野移动导致上次结果失效，应清空表格 */
  staleSeq?: number;
  /** 阶段32：点击结果行 → 飞到该电厂并单点高亮 */
  onFocusPlant?: (plant: PlantFocus) => void;
  /** 当前被聚焦的电厂（AppLayout 统一持有，两个表格据此标出同一行） */
  focusedPlant?: PlantFocus | null;
  /** 阶段33：共享的多轮对话记忆 */
  history?: readonly ConversationTurn[];
  onQueryDone?: (turn: ConversationTurn) => void;
}

function AiQueryPanel({
  onViewOnMap,
  onClearMap,
  viewportRef,
  staleSeq = 0,
  onFocusPlant,
  focusedPlant,
  history = [],
  onQueryDone,
}: AiQueryPanelProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<QueryState>({ status: "idle" });
  const [exportState, setExportState] = useState<ExportState>(null);

  // 阶段31：地图视野移动后，上次的「当前视野」查询结果已经对不上当前画面。
  // 表格不跟着清掉的话，用户会看到「地图飘走了、表格还停在那块区域」的误导组合。
  useEffect(() => {
    if (staleSeq > 0) setState({ status: "idle" });
  }, [staleSeq]);

  // ---- AI 配置（懒初始化自 localStorage，避免每帧都读） ----
  const [useAi, setUseAi] = useState(
    () => localStorage.getItem(LS_KEYS.enabled) === "1",
  );
  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(LS_KEYS.provider);
    return saved && saved in PROVIDER_LABELS ? (saved as Provider) : "deepseek";
  });
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(LS_KEYS.apiKey) ?? "",
  );
  const [ollamaUrl, setOllamaUrl] = useState(
    () => localStorage.getItem(LS_KEYS.ollamaUrl) ?? DEFAULT_OLLAMA_BASE_URL,
  );
  const [ollamaModel, setOllamaModel] = useState(
    () => localStorage.getItem(LS_KEYS.ollamaModel) ?? DEFAULT_OLLAMA_MODEL,
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
  useEffect(() => {
    localStorage.setItem(LS_KEYS.ollamaUrl, ollamaUrl);
  }, [ollamaUrl]);
  useEffect(() => {
    localStorage.setItem(LS_KEYS.ollamaModel, ollamaModel);
  }, [ollamaModel]);

  const isLocal = provider === "ollama";

  /**
   * 统一的 AI 配置。用可辨识联合表达，所以不可能出现
   * 「本地模式却把 apiKey 当作必需项」这类逻辑错误。
   */
  const aiConfig: AiConfig = isLocal
    ? { provider: "ollama", ollama: { baseUrl: ollamaUrl, model: ollamaModel } }
    : { provider, apiKey };

  /** 开关开启、且当前 provider 所需的配置已填齐，才走大模型 */
  const aiReady = useAi && isConfigComplete(aiConfig);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testConnection(aiConfig));
    setTesting(false);
  };

  const run = async (question: string) => {
    setInput(question);

    // ---- 阶段25：先把上一次的结果彻底清干净 ----
    // 表格与 SQL 靠 setState 切到 running 自然消失（新状态里没有 rows），
    // 但地图上的金色高亮不归本组件管，必须显式通知地图页清掉。
    // 否则解析的这几秒里，表格空了而地图还挂着旧结果，很容易误读。
    onClearMap?.();
    setExportState(null);
    setState({ status: "running" });

    // 唯一的分叉点：开关开启且配置齐备就走大模型，否则回退到本地规则引擎。
    // 阶段31：两条路径都带上「当前视野」上下文；阶段33：都带上多轮对话记忆。
    const next = await runAiQuery(question, {
      context: viewportRef?.current ?? null,
      config: aiReady ? aiConfig : null,
      history,
    });
    setState(next);
    if (next.status === "done") {
      onQueryDone?.({
        question,
        summary: next.result.explanation,
        query: next.result.query,
      });
    }
  };

  const columns =
    state.status === "done" && state.rows.length > 0
      ? Object.keys(state.rows[0])
      : [];

  /**
   * 阶段31：只读的视野上下文读数。
   *
   * 在这里读 ref 是刻意为之：面板本来就会因为输入 / 查询状态变化而重渲染，
   * 所以读数总能跟着刷新；而真正用于**解析**的，是 `run()` 被触发那一刻
   * 读到的 ref 值（不受展示延迟影响）。
   */
  const ctxView = viewportRef?.current ?? null;

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>AI 查询测试面板</h2>
      <p className={styles.hint}>
        用一句话查询本地数据库。支持三类问法：按国家聚合、按燃料类型聚合、
        全球总量概览。默认由**本地规则引擎**解析（
        <code>src/lib/nlq.ts</code>，离线可用）；开启下方开关后可改用
        **真实大模型**解析。
      </p>

      {/* 阶段31：只读的视野上下文读数。
          让用户看得见「AI 收到了什么」—— 既建立信任，也让
          「为什么没按我的视野回答」一秒就能判断。 */}
      <p className={styles.ctx}>
        当前视野上下文：
        {ctxView?.viewport
          ? `${formatViewport(ctxView.viewport)} · z${(ctxView.zoom ?? 0).toFixed(1)}` +
            (ctxView.layers?.length
              ? ` · 图层 ${ctxView.layers.join(" / ")}`
              : "")
          : "尚未上报（地图页加载后会实时上报视野与图层状态）"}
      </p>

      {/* ---------- 查询方式配置 ---------- */}
      <div className={styles.config}>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={useAi}
            onChange={(event) => setUseAi(event.target.checked)}
          />
          <span>使用大模型解析（云端需自备 API Key；本地 Ollama 无需 Key）</span>
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
                    {key === "ollama"
                      ? PROVIDER_LABELS.ollama
                      : `${PROVIDERS[key].label} · ${PROVIDERS[key].model}`}
                  </option>
                ))}
              </select>
            </div>

            {isLocal ? (
              <>
                <div className={styles.configRow}>
                  <label className={styles.configLabel} htmlFor="ollama-url">
                    服务地址
                  </label>
                  <input
                    id="ollama-url"
                    className={styles.configInput}
                    value={ollamaUrl}
                    onChange={(event) => setOllamaUrl(event.target.value)}
                    placeholder={DEFAULT_OLLAMA_BASE_URL}
                    autoComplete="off"
                    aria-label="Ollama 服务地址"
                  />
                </div>

                <div className={styles.configRow}>
                  <label className={styles.configLabel} htmlFor="ollama-model">
                    模型名称
                  </label>
                  <input
                    id="ollama-model"
                    className={styles.configInput}
                    value={ollamaModel}
                    onChange={(event) => setOllamaModel(event.target.value)}
                    placeholder={DEFAULT_OLLAMA_MODEL}
                    autoComplete="off"
                    aria-label="Ollama 模型名称"
                  />
                  <button
                    type="button"
                    className={styles.configBtn}
                    onClick={() => void runTest()}
                    disabled={testing || !ollamaUrl.trim()}
                  >
                    {testing ? "测试中…" : "测试连接"}
                  </button>
                </div>

                <p className={styles.localNote}>
                  🔒 本地推理全程离线，数据不会离开本机，也不需要 API Key。
                </p>

                <p className={styles.warn}>
                  ⚠️ 使用前需先在本机运行 Ollama 并拉取模型：
                  终端执行 <code>ollama serve</code> 与{" "}
                  <code>ollama pull {ollamaModel.trim() || DEFAULT_OLLAMA_MODEL}</code>。
                  「测试连接」会列出本机已有模型并校验填写的模型是否存在。
                </p>
              </>
            ) : (
              <>
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

                <p className={styles.warn}>
                  ⚠️ API Key 以**明文**形式存储在本地（localStorage），
                  请勿在公用电脑上使用。
                </p>
              </>
            )}

            {/* 测试结果两种模式共用：放在条件分支之外，切换 provider 也不会丢 */}
            {testResult && (
              <p
                className={styles.testResult}
                data-state={testResult.ok ? "ok" : "error"}
              >
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </p>
            )}
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
          {/* 只禁用这个按钮，不冻结整个界面 —— 地图与其他页面依然可自由操作 */}
          {state.status === "running" && (
            <span className={styles.spinner} aria-hidden="true" />
          )}
          {state.status === "running"
            ? aiReady
              ? "分析中…"
              : "查询中…"
            : "查询"}
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
        <p className={styles.status} data-state="running" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          {/* 文案按引擎区分：只有真走大模型时才是「AI 在分析」，
              规则引擎是同步瞬时完成的，写成 AI 反而误导 */}
          {aiReady ? "AI 正在分析您的问题…" : "正在执行本地规则查询…"}
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
            <div className={styles.tableHeader}>
              <span className={styles.tableCaption}>
               共 {state.rows.length} 行
              </span>
              <button
                type="button"
                className={styles.exportBtn}
                onClick={() =>
                  setExportState(downloadCsv(columns, state.rows))
                }
              >
                导出 CSV
              </button>
            </div>
          )}

          {exportState && (
            <p
              className={styles.status}
              data-state={exportState.ok ? "ok" : "error"}
            >
              {exportState.message}
            </p>
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
                  {state.rows.map((row, index) => {
                    // 阶段32：有坐标的行才可点（聚合行天然没有 lat/lon）。
                    // ⚠️ 匹配用 (name, lat, lon) 三元组 —— 只用名字会在同名电厂上点错：
                    //    实测 `Shanghai Lingang` 在库里对应 2 个点。
                    const focus = toPlantFocus(row);
                    const active = samePlant(focus, focusedPlant);
                    return (
                      <tr
                        key={index}
                        className={[
                          focus ? styles.rowClickable : "",
                          active ? styles.rowActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        tabIndex={focus ? 0 : -1}
                        title={
                          focus ? "点击定位到地图并高亮这座电厂" : undefined
                        }
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          if (focus) onFocusPlant?.(focus);
                        }}
                        onKeyDown={(e) => {
                          if (focus && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            onFocusPlant?.(focus);
                          }
                        }}
                      >
                        {columns.map((col) => (
                          <td key={col}>{formatCell(col, row[col])}</td>
                        ))}
                      </tr>
                    );
                  })}
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
