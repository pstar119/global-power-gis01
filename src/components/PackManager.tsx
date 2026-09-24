/**
 * 阶段44：数据包管理面板。
 *
 * # 为什么下载不在这个组件里做
 *
 * 前端 `fetch` **读不到** GitHub Release 资产（实测：该主机不发 `Access-Control-Allow-Origin`）。
 * 所以下载、断点续传、SHA256 校验、原子落位全部在 Rust 侧完成（见 `src-tauri/src/packs.rs`），
 * 本组件只负责：**显示状态 + 发指令 + 显示进度**。
 *
 * 这样做还顺带避免了 163 MB 走 IPC、以及为 WebView 放宽 CSP。
 *
 * # 与地图页的联动
 *
 * 下载成功后必须广播 `emitPackInstalled` —— 地图页据此失效归档缓存并重挂图层。
 * 少了这一步的症状是「提示下载成功，但地图上依然没有数据」。
 */
import { useMemo } from "react";

import { usePackDownloads } from "../hooks/usePackDownloads";
import { DEV_BASE_URL_OVERRIDE, mb } from "../lib/packs";
import styles from "./PackManager.module.css";

/**
 * 阶段48：原先内联在本文件里的「下载运行时覆盖 / 清单类型 / 错误翻译 / mb」
 * 以及整套下载状态机，已搬到 `src/lib/packs.ts` 与
 * `src/hooks/usePackDownloads.ts` —— 因为首次启动的「欢迎向导」需要
 * **完全相同**的这一套，绝不能抄第二份。
 *
 * 本组件现在只负责**渲染**：把 hook 的状态画出来，并显示进度/错误。
 */

function PackManager() {
  const {
    manifestErr,
    packs,
    files,
    effectiveBase,
    statuses,
    progress,
    phases,
    errors,
    bridgeOk,
    stateOf,
    downloadUrlOf,
    download,
    cancel,
    remove,
  } = usePackDownloads();

  /**
   * 每行的文件名。
   * ⚠️ hook 已返回同序的 `files`，这里仍用 useMemo 包一层只为写法一致 ——
   *    不要改成 `packs.map(...)` 内联，那会在每次渲染建新数组。
   */
  const fileList = useMemo(() => files, [files]);

  if (manifestErr) {
    return (
      <section className={styles.panel}>
        <p className={styles.title}>数据包管理</p>
        <p className={styles.note}>无法读取数据包清单：{manifestErr}</p>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      <p className={styles.title}>数据包管理</p>
      <p className={styles.note}>
        区域数据包体积较大，不随安装包分发。下载保存在
        <code className={styles.code}>%APPDATA%\com.pstar119.globalpowergis\packs\</code>
        ，支持断点续传与 SHA256 校验。
      </p>
      {!bridgeOk && (
        <p className={styles.error}>
          未检测到 Tauri 后端（当前可能是纯浏览器打开的页面），下载功能不可用。
        </p>
      )}

      <ul className={styles.list}>
        {packs.map((pack, i) => {
          const file = fileList[i];
          const st = statuses[file];
          const phase = phases[file] ?? "idle";
          const pr = progress[file];
          const err = errors[file];
          /**
           * 阶段56-A3（设计 §5.4）：**四态**而不是"在/不在"。
           * ‼️ `outdated` = 文件在、但字节数与清单不符 ⇒ 是上一版的数据。
           *    它必须显示成「需更新」而不是「已下载」，否则老用户永远不知道自己
           *    用的是旧归档（旧版含铁路/管道、且没有直流信息），而界面上一切正常。
           */
          const state = stateOf(pack);
          const outdated = state === "outdated";
          const done = state === "installed" || phase === "done";
          const busy = phase === "downloading";
          const resumable = state === "partial";
          const sizeText = pack.bytes ? mb(pack.bytes) : pack.sizeMb ? `${pack.sizeMb} MB` : "—";
          const url = downloadUrlOf(pack);

          return (
            <li key={pack.key} className={styles.row}>
              <div className={styles.head}>
                <span className={styles.name}>
                  {pack.label}
                  <span className={styles.prov}>{pack.provinces}</span>
                </span>
                <span className={styles.size}>{sizeText}</span>
              </div>

              <div className={styles.statusLine}>
                <span
                  className={
                    done
                      ? styles.badgeDone
                      : busy
                        ? styles.badgeBusy
                        : outdated
                          ? styles.badgeOutdated
                          : resumable
                            ? styles.badgePart
                            : styles.badgeIdle
                  }
                >
                  {done
                    ? "已下载"
                    : busy
                      ? `下载中 ${(pr?.percent ?? 0).toFixed(1)}%`
                      : outdated
                        ? "需更新"
                        : resumable
                          ? `未完成（可续传 ${mb(st?.partBytes ?? 0)}）`
                          : "未下载"}
                </span>

                {!done && !busy && bridgeOk && (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void download(pack)}
                    disabled={!url}
                    title={url ?? "清单里没有该包的下载地址"}
                  >
                    {outdated ? "更新" : resumable || err ? "重试 / 续传" : "下载"}
                  </button>
                )}
                {busy && bridgeOk && (
                  <button type="button" className={styles.btn} onClick={() => void cancel(file)}>
                    取消
                  </button>
                )}
                {(done || outdated) && bridgeOk && (
                  <button type="button" className={styles.btnDanger} onClick={() => void remove(file)}>
                    删除
                  </button>
                )}
              </div>

              {/* 过期时把**凭据**摆出来：本机字节数 vs 清单字节数。
                  只说"需更新"而不给数字，用户没法判断是不是误报。 */}
              {outdated && (
                <p className={styles.note}>
                  本机 <code className={styles.code}>{mb(st?.bytes ?? 0)}</code> ≠ 清单{" "}
                  <code className={styles.code}>{mb(pack.bytes ?? 0)}</code>
                  —— 该包是上一版的数据（可能仍含已撤销的铁路/管道、且没有直流分档）。
                  重新下载会**原子替换**，失败时旧文件保持不动。
                </p>
              )}

              {busy && (
                <div className={styles.barOuter} role="progressbar" aria-valuenow={pr?.percent ?? 0}>
                  <div className={styles.barInner} style={{ width: `${Math.max(1, pr?.percent ?? 0)}%` }} />
                  <span className={styles.barText}>
                    {pr ? `${mb(pr.received)} / ${mb(pr.total || pack.bytes || 0)}` : "准备中…"}
                  </span>
                </div>
              )}

              {err && <p className={styles.error}>{err}</p>}
            </li>
          );
        })}
      </ul>

      <p className={styles.note}>
        下载地址：<code className={styles.code}>{effectiveBase ?? "—"}</code>
        <span className={DEV_BASE_URL_OVERRIDE ? styles.badgePart : styles.badgeIdle}>
          {DEV_BASE_URL_OVERRIDE ? "本地覆盖（环境变量）" : "来自清单 packs_manifest.json"}
        </span>
      </p>
    </section>
  );
}

export default PackManager;
