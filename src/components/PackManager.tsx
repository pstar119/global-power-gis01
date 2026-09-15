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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { emitPackInstalled } from "../lib/packEvents";
import styles from "./PackManager.module.css";

const MANIFEST_URL = "/packs_manifest.json";

/**
 * 开发/验证用的**运行时覆盖**。
 *
 * ❗ 为什么需要它：仅靠「改环境变量 + 重新生成清单」两步太容易漏掉一步。
 *    这个变量在 `vite dev` 启动时就被注入，不需要重新生成任何文件：
 *
 * ```text
 * $env:VITE_PACKS_BASE_URL = "http://127.0.0.1:8099"
 * npm run tauri dev
 * ```
 *
 * 它在界面上会显示为「来源：本地覆盖」，一看就知道生效了没有。
 * （`PACKS_BASE_URL` 是**生成清单时**用的，用于正式部署换托管，两者不要混淆。）
 */
const VITE_BASE_URL = (() => {
  const raw = import.meta.env.VITE_PACKS_BASE_URL as string | undefined;
  const trimmed = raw?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
})();

interface PackEntry {
  key: string;
  label: string;
  provinces: string;
  file: string;
  sizeMb: number | null;
  features: number | null;
  /** 阶段44：下载所需；本机没有该包时为 null */
  downloadUrl: string | null;
  sha256: string | null;
  bytes: number | null;
}

interface PacksManifest {
  packs: PackEntry[];
  release?: { baseUrl: string; note?: string };
}

interface PackFileStatus {
  file: string;
  exists: boolean;
  bytes: number;
  partBytes: number;
}

interface DownloadProgress {
  file: string;
  received: number;
  total: number;
  percent: number;
}

type Phase = "idle" | "downloading" | "done" | "error";

/** 把 Rust 回传的类型化错误码翻译成人话。 */
function friendlyError(raw: string): string {
  const msg = raw.replace(/^.*?(?:Error:\s*)?/, "");
  if (raw.includes("CHECKSUM_MISMATCH")) return "文件损坏，请重试下载";
  if (raw.includes("SIZE_MISMATCH")) return "文件大小不符，请重试下载";
  if (raw.includes("TIMEOUT")) return "网络超时（断点已保留，可继续）";
  if (raw.includes("NETWORK_ERROR")) return "网络错误（断点已保留，可继续）";
  if (raw.includes("HTTP_ERROR")) return "服务器返回错误（若是 404，说明下载地址还不可匿名访问）";
  if (raw.includes("RANGE_NOT_SATISFIABLE")) return "服务器拒绝续传请求，请重试下载";
  if (raw.includes("CANCELLED")) return "已取消（断点已保留）";
  if (raw.includes("BAD_FILE_NAME")) return "文件名非法";
  if (raw.includes("BUSY")) return "该数据包正在下载中";
  if (raw.includes("DIR_ERROR")) return "无法创建数据目录";
  return msg || "下载失败";
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PackManager() {
  const [manifest, setManifest] = useState<PacksManifest | null>(null);
  const [manifestErr, setManifestErr] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, PackFileStatus>>({});
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 非 Tauri 环境（纯浏览器打开 dev server）下所有命令都会失败，明确提示而不是静默。 */
  const [bridgeOk, setBridgeOk] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const packs = manifest?.packs ?? [];
  const files = useMemo(() => packs.map((p) => p.file.split("/").pop() ?? ""), [packs]);

  /** 实际生效的基址：本地覆盖优先，其次清单里的正式地址。 */
  const effectiveBase = VITE_BASE_URL ?? manifest?.release?.baseUrl ?? null;
  /**
   * 某个包的下载地址。
   * ‼️ 基址存在时**由基址重新拼**，而不是直接用清单里的 `downloadUrl` ——
   *    否则本地覆盖对已经写死完整 URL 的条目无效。
   */
  const urlOf = useCallback(
    (pack: PackEntry): string | null => {
      const name = pack.file.split("/").pop() ?? "";
      if (effectiveBase) return `${effectiveBase}/${name}`;
      return pack.downloadUrl;
    },
    [effectiveBase],
  );

  const refresh = useCallback(async (list: string[]) => {
    if (!list.length) return;
    try {
      const rows = await invoke<PackFileStatus[]>("pack_status", { files: list });
      if (!mountedRef.current) return;
      const next: Record<string, PackFileStatus> = {};
      for (const r of rows) next[r.file] = r;
      setStatuses(next);
      setBridgeOk(true);
      // 已存在的包不保留错误态
      setErrors((prev) => {
        const copy = { ...prev };
        for (const r of rows) if (r.exists) delete copy[r.file];
        return copy;
      });
    } catch (err) {
      console.warn("[PackManager] pack_status 失败（可能不是 Tauri 环境）", err);
      if (mountedRef.current) setBridgeOk(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(MANIFEST_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PacksManifest;
        if (cancelled) return;
        setManifest(data);
        void refresh(data.packs.map((p) => p.file.split("/").pop() ?? ""));
      } catch (err) {
        if (!cancelled) setManifestErr(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const download = useCallback(
    async (pack: PackEntry, file: string) => {
      const url = urlOf(pack);
      if (!url || !pack.bytes) {
        setErrors((p) => ({ ...p, [file]: "清单里缺少该包的下载地址或大小（本机没有对应文件）" }));
        setPhases((p) => ({ ...p, [file]: "error" }));
        return;
      }
      setErrors((p) => {
        const c = { ...p };
        delete c[file];
        return c;
      });
      setPhases((p) => ({ ...p, [file]: "downloading" }));

      const channel = new Channel<DownloadProgress>();
      channel.onmessage = (p) => {
        if (!mountedRef.current) return;
        setProgress((prev) => ({ ...prev, [p.file]: p }));
      };

      try {
        await invoke("pack_download", {
          req: {
            file,
            url,
            sha256: pack.sha256 ?? "",
            bytes: pack.bytes,
          },
          onProgress: channel,
        });
        if (!mountedRef.current) return;
        setPhases((p) => ({ ...p, [file]: "done" }));
        await refresh([file]);
        // ‼️ 关键一步：通知地图页失效缓存并重挂图层。
        emitPackInstalled(file);
      } catch (err) {
        if (!mountedRef.current) return;
        setPhases((p) => ({ ...p, [file]: "error" }));
        setErrors((p) => ({ ...p, [file]: friendlyError(String(err)) }));
        await refresh([file]);
      }
    },
    [refresh, urlOf],
  );

  const cancel = useCallback(async (file: string) => {
    try {
      await invoke("pack_cancel", { file });
    } catch (err) {
      console.warn("[PackManager] 取消失败", err);
    }
  }, []);

  const remove = useCallback(
    async (file: string) => {
      try {
        await invoke("pack_remove", { file });
        setPhases((p) => ({ ...p, [file]: "idle" }));
        setProgress((p) => {
          const c = { ...p };
          delete c[file];
          return c;
        });
        await refresh([file]);
        emitPackInstalled(file); // 让地图页把该包拆掉（现在文件已不存在）
      } catch (err) {
        setErrors((p) => ({ ...p, [file]: friendlyError(String(err)) }));
      }
    },
    [refresh],
  );

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
          const file = files[i];
          const st = statuses[file];
          const phase = phases[file] ?? "idle";
          const pr = progress[file];
          const err = errors[file];
          const done = phase === "done" || st?.exists;
          const busy = phase === "downloading";
          const resumable = !st?.exists && (st?.partBytes ?? 0) > 0;
          const sizeText = pack.bytes ? mb(pack.bytes) : pack.sizeMb ? `${pack.sizeMb} MB` : "—";
          const url = urlOf(pack);

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
                    done ? styles.badgeDone : busy ? styles.badgeBusy : resumable ? styles.badgePart : styles.badgeIdle
                  }
                >
                  {done
                    ? "已下载"
                    : busy
                      ? `下载中 ${(pr?.percent ?? 0).toFixed(1)}%`
                      : resumable
                        ? `未完成（可续传 ${mb(st?.partBytes ?? 0)}）`
                        : "未下载"}
                </span>

                {!done && !busy && bridgeOk && (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void download(pack, file)}
                    disabled={!url}
                    title={url ?? "清单里没有该包的下载地址"}
                  >
                    {resumable || err ? "重试 / 续传" : "下载"}
                  </button>
                )}
                {busy && bridgeOk && (
                  <button type="button" className={styles.btn} onClick={() => void cancel(file)}>
                    取消
                  </button>
                )}
                {done && bridgeOk && (
                  <button type="button" className={styles.btnDanger} onClick={() => void remove(file)}>
                    删除
                  </button>
                )}
              </div>

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
        <span className={VITE_BASE_URL ? styles.badgePart : styles.badgeIdle}>
          {VITE_BASE_URL ? "本地覆盖 VITE_PACKS_BASE_URL" : "来自清单 packs_manifest.json"}
        </span>
      </p>
    </section>
  );
}

export default PackManager;
