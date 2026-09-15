/**
 * 阶段48：数据包下载的**共用状态机**。
 *
 * 设置页的「数据包管理」与首次启动的「欢迎向导」共用这一个 hook ——
 * 下载、取消、删除、进度、错误翻译只有一份实现。
 *
 * ⚠️ 用户拍板：**坚决不写两份重复代码**。同一个下载逻辑维护两份，
 *    在一个还会持续演进的功能上迟早出事。
 *
 * ⚠️ 仍然只用 `useState` / `useRef`，**不引入任何状态库**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { emitPackInstalled } from "../lib/packEvents";
import {
  effectiveBaseOf,
  fileNameOf,
  friendlyError,
  loadManifest,
  type DownloadProgress,
  type PackEntry,
  type PackFileStatus,
  type PacksManifest,
  urlOf,
} from "../lib/packs";

export type PackPhase = "idle" | "downloading" | "done" | "error";

export interface PackDownloadsApi {
  manifest: PacksManifest | null;
  manifestErr: string | null;
  packs: PackEntry[];
  /** 与 `packs` 同序的文件名，避免各处反复 split */
  files: string[];
  effectiveBase: string | null;
  statuses: Record<string, PackFileStatus>;
  progress: Record<string, DownloadProgress>;
  phases: Record<string, PackPhase>;
  errors: Record<string, string>;
  /** false = 不是 Tauri 环境（纯浏览器打开），下载功能不可用 */
  bridgeOk: boolean;
  downloadUrlOf: (pack: PackEntry) => string | null;
  refresh: (list: string[]) => Promise<void>;
  download: (pack: PackEntry) => Promise<boolean>;
  cancel: (file: string) => Promise<void>;
  remove: (file: string) => Promise<void>;
}

export function usePackDownloads(): PackDownloadsApi {
  const [manifest, setManifest] = useState<PacksManifest | null>(null);
  const [manifestErr, setManifestErr] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, PackFileStatus>>({});
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [phases, setPhases] = useState<Record<string, PackPhase>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bridgeOk, setBridgeOk] = useState(true);

  /**
   * 组件卸载后不能再 setState（下载是长任务，用户很可能中途切页）。
   * ⚠️ 严格模式下 effect 会跑两遍，所以初值必须在这里置 true、cleanup 置 false。
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const packs = manifest?.packs ?? [];
  const files = packs.map(fileNameOf);
  const effectiveBase = effectiveBaseOf(manifest);

  const downloadUrlOf = useCallback(
    (pack: PackEntry) => urlOf(pack, effectiveBase),
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
      console.warn("[packs] pack_status 失败（可能不是 Tauri 环境）", err);
      if (mountedRef.current) setBridgeOk(false);
    }
  }, []);

  // 挂载时载入清单并探测本机已有哪些包
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadManifest();
        if (cancelled) return;
        setManifest(data);
        void refresh(data.packs.map(fileNameOf));
      } catch (err) {
        if (!cancelled) setManifestErr(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /**
   * 下载一个包。返回是否成功 —— 向导要靠它决定「进入下一步」还是「标记失败继续下一个」。
   *
   * ‼️ 成功后会 `emitPackInstalled` —— 地图页据此失效归档缓存并重挂图层。
   *    少了这一步的症状是「提示下载成功，但地图上依然没有数据」。
   */
  const download = useCallback(
    async (pack: PackEntry): Promise<boolean> => {
      const file = fileNameOf(pack);
      const url = urlOf(pack, effectiveBase);
      if (!url || !pack.bytes) {
        setErrors((p) => ({
          ...p,
          [file]: "清单里缺少该包的下载地址或大小（本机没有对应文件）",
        }));
        setPhases((p) => ({ ...p, [file]: "error" }));
        return false;
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
        if (!mountedRef.current) return true;
        setPhases((p) => ({ ...p, [file]: "done" }));
        await refresh([file]);
        emitPackInstalled(file);
        return true;
      } catch (err) {
        if (!mountedRef.current) return false;
        setPhases((p) => ({ ...p, [file]: "error" }));
        setErrors((p) => ({ ...p, [file]: friendlyError(String(err)) }));
        await refresh([file]);
        return false;
      }
    },
    [effectiveBase, refresh],
  );

  const cancel = useCallback(async (file: string) => {
    try {
      await invoke("pack_cancel", { file });
    } catch (err) {
      console.warn("[packs] 取消失败", err);
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

  return {
    manifest,
    manifestErr,
    packs,
    files,
    effectiveBase,
    statuses,
    progress,
    phases,
    errors,
    bridgeOk,
    downloadUrlOf,
    refresh,
    download,
    cancel,
    remove,
  };
}
