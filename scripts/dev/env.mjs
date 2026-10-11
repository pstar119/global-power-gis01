/**
 * scripts/dev/env.mjs —— 构建 / 验证 / 打包入口共用的环境解析与子进程封装。
 *
 * ## 为什么需要它（2026-10-11 实测）
 *
 * DSH Harness 启动时会在**进程 PATH 的最前面**插入自己的垫片目录
 *   C:\Users\Administrator\AppData\Roaming\dsh-desktop\harness\.desktop-bin
 * 里面是 node.cmd / pnpm.cmd（内容：设 ELECTRON_RUN_AS_NODE=1 后启动
 * `F:\DSH Desktop\DSH Desktop.exe`）。后果：
 *   - `node foo.mjs` 还能跑（垫片就是 Electron 的 node 模式）；
 *   - `npm run tauri build` 会报
 *       error: unrecognized subcommand 'F:\DSH Desktop\DSH Desktop.exe'
 *     因为 node_modules/.bin/tauri.cmd 解析裸 `node` 时拿到的是 Electron 主程序。
 *
 * ‼️ 这个垫片是 Harness **动态前置**的：实测进程 PATH = [垫片, F:\DSH Desktop] + Machine PATH + USER PATH，
 *    所以改 Machine / USER PATH 也压不过它（真 node 在 Machine PATH 里的 D:\Node,js 仍排在垫片之后）。
 *    ⇒ 唯一稳的做法：spawn 之前把真 node 目录放到**子进程** PATH 的第一位（见 childEnv）。
 *
 * ## 顺带解决的问题：用 node 而不是 PowerShell 做入口
 *   - .ps1 被执行策略拦（"未对文件 ... 进行数字签名"）；
 *   - PowerShell 5.1 不支持 `&&` 串联；
 *   - 引号 / 反引号 / here-string 地狱；
 *   - 退出码被管道吞掉（`cmd | Select-Object` 拿到的是 PS 的退出码）；
 *   - PowerShell 控制台按 GBK 解码 node 的 UTF-8 输出 ⇒ 中文变乱码。
 *     **所以本目录脚本的控制台输出一律用 ASCII 标签**（中文只出现在注释与文档里）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const tauriDir = join(repoRoot, "src-tauri");

/** 真 node：PATH 里第一个 node 往往是 DSH 垫片，不可信。 */
export function realNode() {
  const cands = [
    process.env.GPG_NODE,
    "D:\\Node,js\\node.exe",
    join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return process.execPath; // 兜底：垫片（Electron 的 node 模式）也能跑 .mjs
}

/** cargo 不在 PATH 上，固定在用户目录。 */
export function cargoExe() {
  const c = join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe");
  return existsSync(c) ? c : "cargo";
}

/** git 的官方安装路径（machine PATH 里有，但显式给更保险）。 */
export function gitExe() {
  const c = "D:\\Git\\cmd\\git.exe";
  return existsSync(c) ? c : "git";
}

/**
 * 子进程环境：把真 node 目录插到 PATH 最前。
 * ⚠️ 不要去删垫片目录 —— 只做"前置"，避免影响 Harness 自身的预期。
 */
export function childEnv(extra = {}) {
  const nodeDir = dirname(realNode());
  const parts = (process.env.PATH || "").split(";").filter(Boolean);
  return { ...process.env, ...extra, PATH: [nodeDir, ...parts].join(";") };
}

/** node_modules 里的 JS 入口（用真 node 跑，绕开 .cmd 垫片）。 */
export function tool(name) {
  return join(repoRoot, "node_modules", ...name.split("/"));
}

/**
 * 同步跑一条命令，直接把输出透传到控制台。
 * 返回 { code, secs }；code === 0 表示成功。
 */
export function run(label, bin, args, opts = {}) {
  const t0 = Date.now();
  console.log("");
  console.log("=== " + label + " ===");
  console.log("$ " + bin + " " + args.join(" "));
  const res = spawnSync(bin, args, {
    cwd: opts.cwd || repoRoot,
    env: childEnv(opts.env),
    stdio: "inherit",
    windowsHide: true,
  });
  const secs = (Date.now() - t0) / 1000;
  const code = typeof res.status === "number" ? res.status : 1;
  console.log("--- " + label + ": exit " + code + " (" + secs.toFixed(1) + "s) ---");
  return { code, secs };
}

/** 跑命令并捕获输出（默认 UTF-8）。 */
export function runCapture(label, bin, args, opts = {}) {
  const res = spawnSync(bin, args, {
    cwd: opts.cwd || repoRoot,
    env: childEnv(opts.env),
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    code: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}
