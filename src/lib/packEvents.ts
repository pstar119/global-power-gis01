/**
 * 阶段44：数据包安装事件总线。
 *
 * 为什么需要它：下载在**设置页**触发，而地图在**地图页**（两者由侧边栏切换，
 * 同时只有一个挂载）。地图页必须知道「某个包刚下载完」，才能做三件事：
 *   1. 失效归档缓存      （否则拿到旧归档，地图上看不到任何变化）
 *   2. 拆掉旧的 source/layer（否则 source 泄漏，且新文件不会被读取）
 *   3. 重新探测并把该包纳入可加载集合
 *
 * 刻意**不用**全局状态库或 Context：跨页通信只有这一个语义，
 * 一个模块级订阅表就够，零依赖、零重渲染开销。
 */

/** 订阅者集合。用 `Set` 便于 O(1) 退订。 */
const listeners = new Set<(file: string) => void>();

/**
 * 订阅「某个包已安装完成」。
 * @returns 退订函数（供 `useEffect` 的 cleanup 直接用）
 */
export function onPackInstalled(fn: (file: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 广播「某个包已安装完成」。
 * @param file 文件名，如 `osm-huadong.pmtiles`（不含路径）
 */
export function emitPackInstalled(file: string): void {
  for (const fn of listeners) {
    try {
      fn(file);
    } catch (err) {
      // 单个订阅者出错不能影响其它订阅者
      console.error("[packs] 安装事件订阅者抛错", err);
    }
  }
}

/** 从文件名推出包 key（`osm-huadong.pmtiles` → `huadong`）。 */
export function packKeyFromFile(file: string): string {
  return file.replace(/^osm-/, "").replace(/\.pmtiles$/, "");
}
