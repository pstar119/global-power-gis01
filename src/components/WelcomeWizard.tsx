/**
 * 阶段48：首次启动「欢迎向导」。
 *
 * # 为什么需要它
 *
 * 安装包**不含**区域电网数据包（7 个包共约 163 MB，不随安装包分发）。
 * 新用户装完打开应用，看到的是一张只有电厂点的地图 —— 如果没有引导，
 * 很容易得出「这软件没数据」的结论。向导负责把「去哪里拿数据、拿哪些」
 * 讲清楚并一键完成。
 *
 * # 三个必须做对的点
 *
 * 1. **不阻塞启动**：清单读不到、或不是 Tauri 环境（纯浏览器打开）时
 *    **一律不弹** —— 宁可没有向导，也不能因为一个探测失败让用户卡在门口。
 * 2. **不重复骚扰**：点过「跳过」或走完流程都会写 localStorage 标记，
 *    之后不再自动弹（否则每启动一次弹一次）。
 * 3. **进度与失败都如实呈现**：某个包失败只标记它自己并继续下一个，
 *    绝不让一个包的失败把整轮卡死。
 *
 * # 为什么下载逻辑不在这里
 *
 * 下载状态机在 `src/hooks/usePackDownloads.ts`，与设置页的「数据包管理」
 * **共用同一份实现**（用户拍板：坚决不写两份重复代码）。
 */
import { useMemo, useRef, useState } from "react";

import type { PackDownloadsApi } from "../hooks/usePackDownloads";
import { fileNameOf, mb, type PackEntry } from "../lib/packs";
import styles from "./WelcomeWizard.module.css";

/** 默认勾选的区域（用户指定：华东、华中、华南等核心区域） */
const DEFAULT_SELECTED = ["huadong", "huazhong", "huanan"] as const;

/** 走完向导（或跳过）后写入，避免每次启动都弹 */
export const WIZARD_FLAG_KEY = "gpg.wizard.done";

type Step = "pick" | "downloading" | "done";

interface WelcomeWizardProps {
  api: PackDownloadsApi;
  /** 结束向导。bbox = 已就绪区域的并集包围盒（无则 null） */
  onFinish: (bbox: [number, number, number, number] | null) => void;
}

/** 把若干 [w,s,e,n] 合并成一个并集包围盒 */
function unionBbox(
  boxes: ReadonlyArray<[number, number, number, number]>,
): [number, number, number, number] | null {
  if (!boxes.length) return null;
  let [w, s, e, n] = boxes[0];
  for (const b of boxes.slice(1)) {
    w = Math.min(w, b[0]);
    s = Math.min(s, b[1]);
    e = Math.max(e, b[2]);
    n = Math.max(n, b[3]);
  }
  return [w, s, e, n];
}

function WelcomeWizard({ api, onFinish }: WelcomeWizardProps) {
  const [step, setStep] = useState<Step>("pick");
  const [selected, setSelected] = useState<readonly string[]>(
    () => DEFAULT_SELECTED,
  );
  /** 本轮真正下载成功的包 key */
  const [succeeded, setSucceeded] = useState<readonly string[]>([]);
  /**
   * 「全部取消」的信号。
   * ⚠️ 必须是 ref 而不是 state：串行下载的循环要在**下一次迭代前**读到最新值，
   *    用 state 会拿到闭包里的旧值，导致取消后还会继续下下一个。
   */
  const stoppedRef = useRef(false);

  const { packs, statuses, progress, phases, errors, bridgeOk, download, cancel } =
    api;

  /**
   * 阶段50-B.2：向导**只管区域包**，thematic（GEM）单独一块。
   *
   * ‼️ 为什么必须分开（三条都是实际会发生的）：
   *    ① GEM 的 bbox 是全世界 ⇒ 进 `finishBbox` 后地图会缩到世界视图
   *    ② 它不参与视口选举（见 MapPage 的 `isThematicOverlay`），
   *       “选区域”对它没有意义
   *    ③ 它是可选的全局图层，在「设置 → 数据包管理」里有正经入口
   */
  const regionPacks = useMemo(() => packs.filter((p) => p.kind !== "gem"), [packs]);
  const thematicPacks = useMemo(() => packs.filter((p) => p.kind === "gem"), [packs]);

  const installedSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of packs) {
      const st = statuses[fileNameOf(p)];
      if (st?.exists) s.add(p.key);
    }
    return s;
  }, [packs, statuses]);

  const toggle = (key: string) =>
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  /** 本次要下载的 = 已选且本机还没有的 */
  const targets = useMemo(
    // 阶段50-B.2：**只处理区域包**（thematic 不参与“选择区域”）
    () => regionPacks.filter((p) => selected.includes(p.key) && !installedSet.has(p.key)),
    [regionPacks, selected, installedSet],
  );

  /**
   * 阶段51：thematic（GEM）也**参与下载**，但**绝不进 `targets`**。
   *
   * ‼️ 为什么不并进 targets：`finishBbox` 由区域包的 bbox 并集算出，
   *    而 GEM 的 bbox 是全世界（-180,-85,180,85）—— 一旦进去，向导结束时地图会直接
   *    缩到世界视图，用户刚选的“华东”被**静默吞掉**（50-B.2 记过这个坑）。
   *    ⇒ 下载队列 = 区域 targets + 单独勾选的 thematic；bbox 只由区域算。
   */
  const thematicTargets = useMemo(
    () => thematicPacks.filter((p) => selected.includes(p.key) && !installedSet.has(p.key)),
    [thematicPacks, selected, installedSet],
  );

  /** 阶段51：区域包全选 / 取消全选 —— **只作用于区域包**，不碰 thematic。 */
  const allRegionsSelected =
    regionPacks.length > 0 && regionPacks.every((p) => selected.includes(p.key));
  const toggleAllRegions = () =>
    setSelected((prev) =>
      allRegionsSelected
        ? prev.filter((k) => !regionPacks.some((p) => p.key === k))
        : [...new Set([...prev, ...regionPacks.map((p) => p.key)])],
    );

  const totalBytes = targets.reduce((sum, p) => sum + (p.bytes ?? 0), 0);

  /** 串行下载：对镜像更友好，也让「已完成 N/M」这个读数稳定可信。 */
  const start = async () => {
    stoppedRef.current = false;
    setStep("downloading");
    const done: string[] = [];
    for (const pack of [...targets, ...thematicTargets]) {
      if (stoppedRef.current) break;
      const ok = await download(pack);
      if (ok) done.push(pack.key);
      if (stoppedRef.current) break;
    }
    setSucceeded((prev) => [...prev, ...done]);
    setStep("done");
  };

  const stopAll = () => {
    stoppedRef.current = true;
    // 取消当前正在下的那个；排队中的会在循环里被 stoppedRef 拦下
    for (const p of targets) {
      const f = fileNameOf(p);
      if (phases[f] === "downloading") void cancel(f);
    }
  };

  /** 已就绪（本来就装了 + 本轮下成功）的区域 → 并集 bbox */
  const readyKeys = useMemo(
    () => [...new Set([...installedSet, ...succeeded])],
    [installedSet, succeeded],
  );
  const finishBbox = useMemo(
    () =>
      unionBbox(
        // 阶段50-B.2：必须只看**区域包**。
        // ‼️ GEM 的 bbox 是全世界（-180,-85,180,85），一旦进了并集，
        //    向导结束时地图会直接缩到世界视图 —— 用户刚选的“华东”被吞掉，
        //    而且不报任何错。
        regionPacks
          .filter((p) => readyKeys.includes(p.key) && p.bbox)
          .map((p) => p.bbox as [number, number, number, number]),
      ),
    [regionPacks, readyKeys],
  );

  const finish = () => onFinish(finishBbox);

  const renderRow = (pack: PackEntry) => {
    const file = fileNameOf(pack);
    const st = statuses[file];
    const busy = phases[file] === "downloading";
    const done = st?.exists || phases[file] === "done";
    const pr = progress[file];
    const err = errors[file];
    const checked = selected.includes(pack.key);

    return (
      <li key={pack.key} className={styles.row} data-done={done || undefined}>
        {step === "pick" ? (
          <label className={styles.pickLabel}>
            <input
              type="checkbox"
              className={styles.check}
              checked={checked}
              disabled={done}
              onChange={() => toggle(pack.key)}
            />
            <span className={styles.name}>
              {pack.label}
              <span className={styles.prov}>{pack.provinces}</span>
            </span>
            <span className={styles.size}>
              {pack.sizeMb ? `${pack.sizeMb} MB` : "—"}
            </span>
          </label>
        ) : (
          <div className={styles.progressRow}>
            <span className={styles.name}>
              {pack.label}
              <span className={styles.prov}>{pack.provinces}</span>
            </span>
            <span className={styles.stateText}>
              {done
                ? "已就绪"
                : busy
                  ? `${(pr?.percent ?? 0).toFixed(1)}%`
                  : err
                    ? "失败"
                    : stoppedRef.current
                      ? "已取消"
                      : "排队中"}
            </span>
            {busy && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => void cancel(file)}
              >
                取消
              </button>
            )}
          </div>
        )}

        {step !== "pick" && busy && (
          <div className={styles.barOuter} role="progressbar" aria-valuenow={pr?.percent ?? 0}>
            <div
              className={styles.barInner}
              style={{ width: `${Math.max(1, pr?.percent ?? 0)}%` }}
            />
            <span className={styles.barText}>
              {pr
                ? `${mb(pr.received)} / ${mb(pr.total || pack.bytes || 0)}`
                : "准备中…"}
            </span>
          </div>
        )}

        {step !== "pick" && err && <p className={styles.err}>{err}</p>}
      </li>
    );
  };

  const stepIndex = step === "pick" ? 0 : step === "downloading" ? 1 : 2;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="欢迎向导">
      <div className={styles.card}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>欢迎使用 Global Power GIS</h2>
            <p className={styles.sub}>
              全球电厂数据已内置。区域电网数据（输电线路与变电站）体积较大，
              不随安装包分发，请按需下载。
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="跳过向导"
            onClick={finish}
            title="跳过，稍后可在「设置」里下载"
          >
            ✕
          </button>
        </header>

        <ol className={styles.steps}>
          {["选择区域", "下载", "完成"].map((label, i) => (
            <li
              key={label}
              className={i === stepIndex ? styles.stepOn : i < stepIndex ? styles.stepDone : styles.stepOff}
            >
              <span className={styles.stepNum}>{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {!bridgeOk && (
          <p className={styles.warn}>
            未检测到应用后端，下载功能不可用（当前可能是用浏览器打开的页面）。
          </p>
        )}

        {step === "done" ? (
          <div className={styles.doneBox}>
            {readyKeys.length ? (
              <>
                <p className={styles.doneTitle}>
                  已就绪 {readyKeys.length} 个区域
                </p>
                <p className={styles.doneSub}>
                  {packs
                    .filter((p) => readyKeys.includes(p.key))
                    .map((p) => p.label)
                    .join(" · ")}
                </p>
              </>
            ) : (
              <p className={styles.doneSub}>
                没有区域被下载。稍后可在「设置 → 数据包管理」里下载。
              </p>
            )}
            {Object.keys(errors).length > 0 && (
              <p className={styles.warn}>
                有 {Object.keys(errors).length} 个包失败，可在设置页重试。
              </p>
            )}
          </div>
        ) : (
          <>
            <div className={styles.pickAllBar}>
              <label className={styles.pickAllLabel}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={allRegionsSelected}
                  onChange={toggleAllRegions}
                />
                全选 / 取消全选（{regionPacks.length} 个区域）
              </label>
              <span className={styles.pickAllHint}>
                GEM 是独立全局包，需在下方单独勾选
              </span>
            </div>
            <ul className={styles.list}>{regionPacks.map(renderRow)}</ul>
            {/* 阶段50-B.2：thematic 数据**单独一块**，不进“选择区域”。
                ‼️ 行内的下载按钮仍可用（`renderRow` 直接调 `download(pack)`），
                   但它**不参与** targets / finishBbox / “已就绪 N 个区域” ——
                   它是全局图层，与初始视野无关。 */}
            {thematicPacks.length > 0 && (
              <div className={styles.doneBox}>
                <p className={styles.doneTitle}>主题数据（独立全局包 · 需单独勾选 · 不影响初始视野）</p>
                <ul className={styles.list}>{thematicPacks.map(renderRow)}</ul>
              </div>
            )}
          </>
        )}

        <footer className={styles.foot}>
          <span className={styles.footInfo}>
            {step === "pick" &&
              (targets.length
                ? `已选 ${targets.length} 个 · 约 ${mb(totalBytes)}`
                : installedSet.size
                  ? "所选区域均已就绪"
                  : "请至少选择一个区域")}
            {step === "downloading" && (
              <>
                正在下载…
                <button type="button" className={styles.linkBtn} onClick={stopAll}>
                  全部取消
                </button>
              </>
            )}
          </span>

          {step === "pick" && (
            <>
              <button type="button" className={styles.ghostBtn} onClick={finish}>
                跳过，稍后再说
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!targets.length || !bridgeOk}
                onClick={() => void start()}
              >
                开始下载
              </button>
            </>
          )}
          {step === "downloading" && (
            <button type="button" className={styles.ghostBtn} onClick={finish}>
              后台继续
            </button>
          )}
          {step === "done" && (
            <button type="button" className={styles.primaryBtn} onClick={finish}>
              进入地图
            </button>
          )}
        </footer>

        {step === "pick" && (
          <p className={styles.tip}>
            提示：下载支持断点续传与 SHA256 校验，保存于 <code>%APPDATA%\com.pstar119.globalpowergis\packs\</code>
          </p>
        )}
      </div>
    </div>
  );
}

export default WelcomeWizard;
