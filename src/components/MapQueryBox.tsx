/**
 * 地图页的浮动查询框（阶段31）。
 *
 * 为什么放在地图页：GIS 用户是**看着地图提问**的，切到设置页去查非常割裂。
 * 设置页保留完整面板（含 AI 配置、导出 CSV），这里只做「提问 + 看结果」。
 *
 * ⚠️ 与设置页共用 `lib/aiQuery.ts` 的同一套解析 / SQL / 取数逻辑，
 *    不存在第二份实现。
 * ⚠️ 只读：只执行 SELECT。
 */

import { useEffect, useState, type RefObject } from "react";
import {
  COLUMN_LABELS,
  MAP_BOX_HIDDEN_COLUMNS,
  readStoredAiConfig,
  runAiQuery,
  type QueryState,
} from "../lib/aiQuery";
import {
  EXAMPLES,
  HISTORY_SHOWN_TURNS,
  formatViewport,
  samePlant,
  toPlantFocus,
  type ConversationTurn,
  type ParsedQuery,
  type PlantFocus,
  type QueryContext,
} from "../lib/nlq";
import styles from "./MapQueryBox.module.css";

interface MapQueryBoxProps {
  /**
   * 当前视野上下文（已做 200ms 防抖的**展示副本**）。
   * 真正用于解析的是 ref —— 拖拽刚停下就提问时，ref 一定是最新的。
   */
  viewport: QueryContext | null;
  /** 权威视野上下文：提问瞬间读取，避免展示副本的防抖延迟影响解析 */
  viewportRef?: RefObject<QueryContext | null>;
  /** 值变化 = 视野移动导致上次「当前视野」查询失效，需要清空旧结果 */
  staleSeq?: number;
  /** 把查询结果交给地图：飞行 + 高亮 */
  onViewOnMap?: (query: ParsedQuery) => void;
  /** 发起新查询前先清掉地图上的旧高亮 */
  onClearMap?: () => void;
  /** 阶段32：点击结果行 → 飞到该电厂并单点高亮 */
  onFocusPlant?: (plant: PlantFocus) => void;
  /** 当前被聚焦的电厂（由 AppLayout 统一持有，跨页一致） */
  focusedPlant?: PlantFocus | null;
  /** 阶段33：多轮对话记忆（AppLayout 持有） */
  history?: readonly ConversationTurn[];
  /** 阶段33：一轮查询完成后回报，供写入共享记忆 */
  onQueryDone?: (turn: ConversationTurn) => void;
  /** 工作台是否展开（由地图页持有，展开时会把左上的图层控制面板右推） */
  open?: boolean;
  onToggleOpen?: () => void;
}

function MapQueryBox({
  viewport,
  viewportRef,
  staleSeq = 0,
  onViewOnMap,
  onClearMap,
  onFocusPlant,
  focusedPlant,
  history = [],
  onQueryDone,
  open = true,
  onToggleOpen,
}: MapQueryBoxProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<QueryState>({ status: "idle" });
  /** 会话历史默认只露最近 5 轮，「展开更多」看全部 */
  const [showAllHistory, setShowAllHistory] = useState(false);

  // 视野移动 → 上一次的视野限定结果已经对不上当前画面，清掉，
  // 不然用户会看到「地图已经飘走了，表格还停在那块区域」的误导组合。
  useEffect(() => {
    if (staleSeq > 0) setState({ status: "idle" });
  }, [staleSeq]);

  const run = async (question: string) => {
    const q = question.trim();
    if (!q || state.status === "running") return;

    setInput(q);
    onClearMap?.();
    setState({ status: "running" });

    // ⚠️ 每次提问现读 localStorage：用户在设置页改了开关/模型，这里立刻生效
    //    （三个页面常驻挂载，用 state 缓存会永远读到挂载那一刻的旧值）
    const { config, enabled } = readStoredAiConfig();

    const next = await runAiQuery(q, {
      context: viewportRef?.current ?? null,
      config: enabled ? config : null,
      history,
    });
    setState(next);

    // 阶段33：成功一轮就写进共享记忆，下一次追问才能「记得」刚才的视野与约束
    if (next.status === "done") {
      onQueryDone?.({
        question: q,
        summary: next.result.explanation,
        query: next.result.query,
      });
    }

    // 解析成功就把结果交给地图（飞过去 + 金色高亮）
    if (next.status === "done") onViewOnMap?.(next.result.query);
  };

  const ctx = viewport?.viewport;
  const rows =
    state.status === "done" ? state.rows.slice(0, 5) : [];
  // 经纬度只用于点击定位，不在“简易”表格里显示
  const columns = rows.length
    ? Object.keys(rows[0]).filter((k) => !MAP_BOX_HIDDEN_COLUMNS.has(k))
    : [];
  const shownHistory = showAllHistory
    ? history
    : history.slice(-HISTORY_SHOWN_TURNS);

  // 折叠态：只留一条竖向导轨，不跟「图层控制」抢空间
  if (!open) {
    return (
      <button
        type="button"
        className={styles.rail}
        onClick={onToggleOpen}
        aria-expanded={false}
        title="展开 AI 工作台"
      >
        AI 工作台
      </button>
    );
  }

  return (
    <section className={styles.box} aria-label="地图查询">
      <div className={styles.head}>
        <h2 className={styles.title}>AI 工作台</h2>
        <button
          type="button"
          className={styles.collapse}
          onClick={onToggleOpen}
          aria-expanded={true}
          title="折叠工作台"
        >
          ‹
        </button>
      </div>

      <div className={styles.row}>
        <input
          className={styles.input}
          type="text"
          value={input}
          placeholder="问一句，例如：当前视野里最大的5个电厂"
          aria-label="自然语言查询"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run(input);
          }}
        />
        <button
          type="button"
          className={styles.btn}
          disabled={state.status === "running"}
          onClick={() => void run(input)}
        >
          {state.status === "running" ? "解析中…" : "查询"}
        </button>
      </div>

      {/* 只读上下文读数：让用户看得见「AI 收到了什么」。
          这是信任问题也是排错手段 —— 「为什么没按我的视野回答」一秒就能看出。 */}
      <p className={styles.ctx}>
        当前视野{" "}
        {ctx
          ? `${formatViewport(ctx)} · z${(viewport?.zoom ?? 0).toFixed(1)}`
          : "尚未上报（地图加载中）"}
        {viewport?.layers?.length ? ` · 图层 ${viewport.layers.join(" / ")}` : ""}
      </p>

      {state.status === "rejected" && (
        <p className={`${styles.status} ${styles.err}`}>{state.message}</p>
      )}
      {state.status === "error" && (
        <p className={`${styles.status} ${styles.err}`}>
          执行失败：{state.message}
        </p>
      )}

      {state.status === "done" && (
        <>
          <p className={styles.status}>
            {state.result.explanation} · 命中 {state.rows.length} 行
          </p>
          {state.rows.length === 0 ? (
            <p className={styles.status}>
              当前视野内没有匹配的机组 —— 缩小地图或换个问题再试。
            </p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  {columns.map((k) => (
                    <th key={k}>{COLUMN_LABELS[k] ?? k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  // 阶段32：有坐标的行才可点（聚合行天然没有 lat/lon）
                  const focus = toPlantFocus(r);
                  const active = samePlant(focus, focusedPlant);
                  return (
                    <tr
                      key={i}
                      className={[
                        focus ? styles.rowClickable : "",
                        active ? styles.rowActive : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      tabIndex={focus ? 0 : -1}
                      title={focus ? "点击定位到地图并高亮这座电厂" : undefined}
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
                      {columns.map((k) => (
                        <td key={k}>{String(r[k] ?? "—")}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {state.rows.length > 5 && (
            <p className={styles.status}>
              仅显示前 5 行，共 {state.rows.length} 行（完整表格见设置页的 AI 查询面板）
            </p>
          )}
        </>
      )}

      {state.status === "idle" && (
        <div className={styles.chips}>
          {EXAMPLES.slice(0, 2).map((ex) => (
            <button
              key={ex}
              type="button"
              className={styles.chip}
              onClick={() => void run(ex)}
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* 阶段33：会话历史。默认只露最近 5 轮，可展开看全部。 */}
      {history.length > 0 && (
        <div className={styles.history}>
          <p className={styles.historyLabel}>对话历史（{history.length} 轮）</p>
          <ul className={styles.historyList}>
            {shownHistory.map((t, i) => (
              <li key={`${t.question}-${i}`} className={styles.historyItem}>
                <span className={styles.historyQ}>{t.question}</span>
                <span className={styles.historyA}>{t.summary}</span>
              </li>
            ))}
          </ul>
          {history.length > HISTORY_SHOWN_TURNS && (
            <button
              type="button"
              className={styles.chip}
              onClick={() => setShowAllHistory((v) => !v)}
            >
              {showAllHistory
                ? `收起（只看最近 ${HISTORY_SHOWN_TURNS} 轮）`
                : `展开更多（全部 ${history.length} 轮）`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default MapQueryBox;
