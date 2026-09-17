/**
 * 阶段51：外观主题（深色 / 浅色）。
 *
 * ‼️ **零依赖、零 UI 库** —— 主题完全靠 `App.css` 里那套 `--gpg-*` CSS 令牌切换。
 *    本文件只做三件事：读写 localStorage、把 `data-theme` 写到 `<html>`、广播变化。
 *
 * ⚠️ 为什么必须有「订阅」这一层：MapLibre 的**样式是 JSON，不认 CSS 变量** ——
 *    底图那 10 个图层的配色只能在 JS 里显式改（`setPaintProperty`）。
 *    主题开关在「设置页」、地图在「地图页」，两者是不同路由；
 *    用模块级订阅，比把主题状态穿过 AppLayout 一层层往下传要干净得多，
 *    也不会让 AppLayout 无谓地重渲染整棵子树。
 */

/** 深色 = 主题引入前的原始观感；浅色 = 新增。 */
export type Theme = "dark" | "light";

/** localStorage 键名。沿用 AppLayout 里 `WIZARD_FLAG_KEY` 的同款命名风格。 */
const LS_KEY = "gpg.theme";

/**
 * 缺省主题 = 深色。
 * ‼️ 刻意不跟随 `prefers-color-scheme`：主题引入前本项目是**固定深色**，
 *    若跟随系统，浅色系统上的老用户会在升级后被动看到一套新外观。
 *    要跟随系统得显式做一个 "auto" 选项，那是另一个需求。
 */
export const DEFAULT_THEME: Theme = "dark";

function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

/** 读取持久化的主题。localStorage 在受限环境可能直接抛错，所以整体兜底。 */
export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return isTheme(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const listeners = new Set<(t: Theme) => void>();

/** 订阅主题变化；返回取消订阅函数。 */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 把主题写到 `<html data-theme="…">`，CSS 令牌据此切换。
 *
 * ⚠️ `color-scheme` 由 CSS 里 `:root` / `:root[data-theme="light"]` 声明，
 *    **不在这里内联设置** —— 集中在一处才不会出现「JS 内联值覆盖了 CSS 值」的隐性打架。
 */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

/** 设置主题（持久化 + 应用 + 广播）。 */
export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(LS_KEY, t);
  } catch {
    /* 存储不可用时也不该让 UI 崩掉 —— 主题仍然在本次会话内生效 */
  }
  applyTheme(t);
  for (const fn of listeners) fn(t);
}

/**
 * 启动时立刻落地一次主题。
 *
 * ‼️ 这是**模块级副作用**，故意如此：它必须在 React 首次渲染**之前**执行，
 *    否则浅色用户会先看到一帧深色再跳变（闪白/闪黑）。
 *    本模块由 `main.tsx` 在最早期导入，所以这个时机是确定的。
 */
applyTheme(readTheme());
