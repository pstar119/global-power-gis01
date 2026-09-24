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

/**
 * 阶段50-B：数据包品类 —— **按生命周期分**，不是按内容分。
 *
 * · `"region"` —— **区域包**：某区域的电网线/面要素，按视口 bbox 选举、
 *                  最多同时 2 个、随视野反复增删（归档内 MVT 图层名 `grid`）
 * · `"gem"`    —— **thematic / global overlay**：全球单一图层，
 *                  由图层开关控制、**不参与视口选举**（归档内 MVT 图层名 `gem`）
 *
 * ‼️ 两者的**挂载代码不同**，混用会取到不存在的 `source-layer` ——
 *    而那个失败是**静默的**（MapLibre 只是什么都不画）。
 *
 * ⚠️ 只在这里定义一次，MapPage 以 `import type` 复用 —— 之前两边各写一份
 *    `"osm" | "gem"`，已经在漂移（MapPage 那份没有 `core` / `release`）。
 */
export type PackKind = "region" | "gem" | "basemap";

/**
 * 阶段56-B：品类判定必须**语义化**，不能再用"非 gem 即区域包"这种反向推断。
 *
 * ‼️ 为什么必须有这三条：`PackKind` 从两态变三态之后，原来那句注释规则
 *    （"运行时一律用 `=== \"gem\"` 判定，缺失自然落到 region 分支"）**不再安全**：
 *    `basemap` 既不是 gem 也不是区域包，任何 `!isThematicOverlay(p)` 的写法
 *    都会把它当成区域包 —— 而后果是**静默**的：它会被选进 `activePacks`、占掉装载名额、
 *    并被当成 MVT 图层名 `grid` 去挂载（那里面根本没有 `grid` 层）。
 */
export function isRegionPack(p: Pick<PackEntry, "kind">): boolean {
  // 缺省 = 区域包：旧清单（阶段39~56-A2）没有 kind 字段，必须继续当区域包
  return p.kind === "region" || p.kind === undefined;
}

export function isBasemapPack(p: Pick<PackEntry, "kind">): boolean {
  return p.kind === "basemap";
}

/**
 * thematic / global overlay（当前只有 GEM）：全球单一图层、由开关控制、**不参与视口选举**。
 * ⚠️ 语义已**收窄为 gem**（阶段56-B）—— 别再用它来排除"非区域包"。
 */
export function isThematicOverlay(p: Pick<PackEntry, "kind">): boolean {
  return p.kind === "gem";
}

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
  /**
   * 阶段50-B：数据包品类，决定由哪套生命周期代码挂载。
   *
   * ⚠️ 可选：旧清单没有这个字段。判定一律走 `isRegionPack` / `isBasemapPack` /
   *    `isThematicOverlay` 三个函数，**不要**在调用点写 `!== "gem"` 之类的反向推断
   *    （阶段56-B 加第三态时，那种写法会把底图包当成区域包，而且不报错）。
   */
  kind?: PackKind;
  /**
   * 阶段56-B：**底图包专用** —— 它给哪个区域包当底图。
   *
   * ‼️ 用字段而不是"从 key 前缀解析"：`basemap-kp-kr` 靠字符串猜归属，
   *    在改名/换命名规则时会**静默失效**（底图不挂载，地图上什么都不缺，只是没底图）。
   */
  forRegion?: string;
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

/**
 * 阶段53：返回**所有可用**的下载基址，按优先级排序。
 *
 * - 镜像（`baseUrl`）优先，直连（`directBaseUrl`）兜底
 * - 开发覆盖（`DEV_BASE_URL_OVERRIDE`）**独占**，不降级 ——
 *   否则本地测试失败时会偷偷用生产源，误导开发者
 * - 两个 base 相同时只留一个
 */
export function effectiveBasesOf(manifest: PacksManifest | null): string[] {
  // Dev override 独占：不做任何降级
  if (DEV_BASE_URL_OVERRIDE) return [DEV_BASE_URL_OVERRIDE];

  const bases: string[] = [];
  const base = manifest?.release?.baseUrl;
  const direct = manifest?.release?.directBaseUrl;
  if (base) bases.push(base);
  if (direct && direct !== base) bases.push(direct);
  return bases;
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

/**
 * 阶段53：判断一个 Rust 错误串是否值得换源重试。
 *
 * 只对「网络类 / 服务器类」错误返回 true；
 * 校验失败、用户取消、文件占用等与源无关的错误返回 false。
 */
export function isRetryableNetworkError(raw: string): boolean {
  // 绝对不重试：与源无关
  if (
    /CHECKSUM_MISMATCH|SIZE_MISMATCH|CANCELLED|BUSY|BAD_FILE_NAME|DIR_ERROR/.test(
      raw,
    )
  ) {
    return false;
  }
  // 值得换源重试：网络 / 服务器 / Range
  if (/TIMEOUT|NETWORK_ERROR|HTTP_ERROR|RANGE_NOT_SATISFIABLE/.test(raw)) {
    return true;
  }
  // 未知错误：保守起见不重试
  return false;
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ============================================================================
 * 阶段56-A3（设计 §5.4 / G8）：包指纹失效策略
 * ============================================================================
 * 背景：运行时原本只探测「文件存不存在」⇒ **升级后老包永远算"已安装"**，
 * 于是老用户会一直用旧归档（上一阶段的铁路/管道、没有直流信息的线路），
 * 而界面上显示"已下载"，看不出任何异常。
 *
 * 做法（**零 Rust 改动**）：`pack_status` 已经回传每个包的 `bytes`，
 * 拿它与清单里的 `bytes` 比对即可判定"这个包是上一版的"。
 *
 * ⚠️ 判据是**字节数**，不是 SHA256。两条都是事实，别互相冒充：
 *    · 字节数不同 ⇒ **一定**是不同版本（先验必然）；
 *    · 字节数相同 ⇏ 内容相同（理论上同长度的不同内容会漏判）。
 *    之所以不在这里比 SHA256：那是 30 MB × 8 的文件读取+哈希，会卡住渲染；
 *    而**下载路径本来就逐字节校验 SHA256**（`packs.rs` 只在长度+SHA256 都对时
 *    才 rename 成正式名），所以"装上的文件"在装的那一刻是可信的 —— 这里要抓的是
 *    **"装了旧版本"**，字节数足够。
 */
export type PackInstallState =
  /** 正式文件不存在（可能有 .part 可续传） */
  | "missing"
  /** 有未完成的 `.part`，可续传 */
  | "partial"
  /** 已安装且与清单指纹一致 */
  | "installed"
  /** 已安装，但**与清单不一致** ⇒ 是上一版的数据，应标「需更新」而不是「已下载」 */
  | "outdated";

export function installStateOf(
  pack: Pick<PackEntry, "bytes">,
  status: PackFileStatus | undefined,
): PackInstallState {
  // ⚠️ 分两步写而不是 `!status?.exists`：后者不会让 TS 把 `status` 收窄成已定义，
  //    下一行访问 `status.bytes` 会报 TS18048（实测踩到）。
  if (!status) return "missing";
  if (!status.exists) return (status.partBytes ?? 0) > 0 ? "partial" : "missing";
  // 清单没记字节数时**不能**判定过期 —— 宁可显示"已下载"，也不要无凭据地催用户重下 155 MB
  if (pack.bytes == null || !status.bytes) return "installed";
  return status.bytes === pack.bytes ? "installed" : "outdated";
}
