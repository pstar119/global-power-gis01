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
  readStoredAiConfig,
  runAiQuery,
  type QueryState,
} from "../lib/aiQuery";
import { EXAMPLES, formatViewport, type ParsedQuery, type QueryContext } from "../lib/nlq";
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
}

function MapQueryBox({
  viewport,
  viewportRef,
  staleSeq = 0,
  onViewOnMap,
  onClearMap,
}: MapQueryBoxProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<QueryState>({ status: "idle" });

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
    });
    setState(next);

    // 解析成功就把结果交给地图（飞过去 + 金色高亮）
    if (next.status === "done") onViewOnMap?.(next.result.query);
  };

  const ctx = viewport?.viewport;
  const rows =
    state.status === "done" ? state.rows.slice(0, 5) : [];

  return (
    <section className={styles.box} aria-label="地图查询">
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
                  {Object.keys(rows[0]).map((k) => (
                    <th key={k}>{COLUMN_LABELS[k] ?? k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {Object.keys(rows[0]).map((k) => (
                      <td key={k}>{String(r[k] ?? "—")}</td>
                    ))}
                  </tr>
                ))}
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
    </section>
  );
}

export default MapQueryBox;
