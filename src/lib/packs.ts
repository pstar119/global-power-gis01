/**
 * 阶段48：数据包下载的**共用纯逻辑**。
 *
 * 为什么抽出来：设置页的「数据包管理」与首次启动的「欢迎向导」需要**完全相同**的
 * 清单解析、地址拼接、错误翻译。这些逻辑原本内联在 `PackManager.tsx` 里，
 * 向导若照抄一份，两处就会开始漂移 —— 而它们中任何一处错了都表现为
 * 「用户下不了包」，属于最难排查的那类问题。
 *
 * ⚠️ 这里**只放纯逻辑**（无 React、无状态）。带状态的部分在
 *    `src/hooks/usePackDownloads.ts`，两处共用同一份状态机。
 */

export const MANIFEST_URL = "/packs_manifest.json";

/** 单个区域数据包在清单里的描述 */
export interface PackEntry {
  key: string;
  label: string;
  provinces: string;
  file: string;
  sizeMb: number | null;
  features: number | null;
  /** 下载所需；本机没有该包且清单里也没记录过时为 null */
  downloadUrl: string | null;
  sha256: string | null;
  bytes: number | null;
  /** 阶段48：区域包围盒 [w, s, e, n]，向导完成后用它把地图初始化到已下载区域 */
  bbox?: [number, number, number, number];
}

export interface PacksManifest {
  packs: PackEntry[];
  release?: {
    baseUrl: string;
    /**
     * 阶段48：**预留字段，当前只读不用**（用户拍板：降级逻辑先不做）。
     *
     * 值是 GitHub 直连基址（不经镜像）。真正做自动降级时，
     * 只需在镜像下载失败后用 `effectiveBaseOf()` 传入这个地址重试一次。
     */
    directBaseUrl?: string | null;
    note?: string;
  };
}

export interface PackFileStatus {
  file: string;
  exists: boolean;
  bytes: number;
  partBytes: number;
}

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
  percent: number;
}

/**
 * 开发/验证用的**运行时覆盖**（**只在 `vite dev` 下生效**）。
 *
 * ‼️ 两个名字都读，但语义相同 —— `vite.config.ts` 里设了
 *    `envPrefix: ["VITE_", "PACKS_"]`，所以同一个环境变量既能被
 *    `gen_packs_manifest.mjs`（生成清单时）读到，也能被这里（运行时）读到。
 *    这样就不存在「设了变量却因为忘了重新生成清单而不生效」这种坑了。
 *
 * ```text
 * $env:PACKS_BASE_URL = "http://127.0.0.1:8099"
 * npm run tauri dev
 * ```
 *
 * 它在界面上会显示为「本地覆盖」，一看就知道生效了没有。
 *
 * 🔴 **生产构建里这个值恒为 null**（下面的 `DEV` 判断）。
 *
 *    原因是实测出来的一个会让分发**静默全灭**的坑：
 *    `vite.config.ts` 的 envPrefix 里有 `PACKS_`，而 Vite 会把**构建时 shell 环境里**
 *    匹配前缀的变量原样内联进产物。于是「本地联调完、shell 里还留着
 *    `PACKS_BASE_URL=http://127.0.0.1:8099`，直接 `tauri build` 发版」，
 *    就会把 localhost 写进安装包 —— 而它的优先级**高于清单**，
 *    结果**所有用户**的下载都指向自己的机器、100% 失败。
 *    最恶劣的是它完全静默：代码正常、清单正常、只是下载全挂。
 *
 *    实测证据（2026-09-15）：带该变量跑 `npm run build`，
 *    `dist/assets/index-*.js` 里能搜到 `127.0.0.1:9999`。
 *
 *    ⇒ 这里加 DEV 判断（第二道保险），且 `vite.config.ts` 的 build 侧
 *      已**不再注入 `PACKS_` 前缀**（第一道），两道叠加后生产包安全。
 *      需要在生产模式临时改地址时，走清单那条路（唯一配置点）：
 *        $env:PACKS_BASE_URL="http://127.0.0.1:8099"; node scripts/gen_packs_manifest.mjs
 */
export const DEV_BASE_URL_OVERRIDE: string | null = (() => {
  // ⚠️ 这一行不能删，理由见上。`import.meta.env.DEV` 在 build 时为 false。
  if (!import.meta.env.DEV) return null;
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const raw = env.VITE_PACKS_BASE_URL ?? env.PACKS_BASE_URL;
  const trimmed = raw?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
})();

/**
 * 实际生效的下载基址：本地覆盖优先，其次清单里的正式地址。
 *
 * ‼️ 基址存在时前端会**由基址重新拼** URL，而不是直接用清单里的 `downloadUrl` ——
 *    否则本地覆盖对已经写死完整 URL 的条目无效。
 */
export function effectiveBaseOf(manifest: PacksManifest | null): string | null {
  return DEV_BASE_URL_OVERRIDE ?? manifest?.release?.baseUrl ?? null;
}

/** 清单条目 → 下载地址。基址为空时才回落到条目里写死的完整 URL。 */
export function urlOf(
  pack: PackEntry,
  effectiveBase: string | null,
): string | null {
  if (effectiveBase) return `${effectiveBase}/${fileNameOf(pack)}`;
  return pack.downloadUrl;
}

/** `packs/osm-huadong.pmtiles` → `osm-huadong.pmtiles` */
export function fileNameOf(pack: PackEntry): string {
  return pack.file.split("/").pop() ?? "";
}

/** 读取并校验清单。失败时抛错，由调用方决定是「不弹向导」还是「显示错误」。 */
export async function loadManifest(): Promise<PacksManifest> {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as PacksManifest;
  if (!Array.isArray(data?.packs)) throw new Error("清单格式不正确");
  return data;
}

/** 把 Rust 回传的类型化错误码翻译成人话。 */
export function friendlyError(raw: string): string {
  const msg = raw.replace(/^.*?(?:Error:\s*)?/, "");
  if (raw.includes("CHECKSUM_MISMATCH")) return "文件损坏，请重试下载";
  if (raw.includes("SIZE_MISMATCH")) return "文件大小不符，请重试下载";
  if (raw.includes("TIMEOUT")) return "网络超时（断点已保留，可继续）";
  if (raw.includes("NETWORK_ERROR")) return "网络错误（断点已保留，可继续）";
  if (raw.includes("HTTP_ERROR")) return "服务器返回错误（404：该地址上没有这个文件）";
  if (raw.includes("RANGE_NOT_SATISFIABLE")) return "服务器拒绝续传请求，请重试下载";
  if (raw.includes("CANCELLED")) return "已取消（断点已保留）";
  if (raw.includes("BAD_FILE_NAME")) return "文件名非法";
  if (raw.includes("BUSY")) return "该数据包正在下载中";
  if (raw.includes("DIR_ERROR")) return "无法创建数据目录";
  return msg || "下载失败";
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
