/**
 * scripts/dev/package.mjs —— 出一份可直接分发的安装包（含"树外导出"这一步）。
 *
 * 用法
 * ----
 *   node scripts/dev/package.mjs                    # 打包 + 导出到桌面
 *   node scripts/dev/package.mjs --out D:\gpg-release
 *   node scripts/dev/package.mjs --no-export        # 只打包，不复制出树
 *
 * 为什么导出是必须的一步
 * ----------------------
 * `J:\Projects\global-power-gis` 整棵树被 DSH 沙箱打了 **Low 完整性标签**，树里构建出来的
 * exe 也带这个标签 ⇒ 以 Low IL 启动 ⇒ 写不了 K:\、%APPDATA%、HKCU、桌面。
 * 复制（不是移动）到树外即可摆脱（新文件继承目标目录的标签）。
 * 细节见 scripts/export-release.mjs 头部与根目录 AGENTS.md。
 *
 * 提示：`tauri build` 会先跑 `npm run build`（tsc ×2 + vite build）；迭代时别反复跑本脚本，
 *       用 `node scripts/dev/verify.mjs` 就够了。
 */
import { join } from "node:path";
import { realNode, repoRoot, run, tool } from "./env.mjs";

const argv = process.argv.slice(2);
const noExport = argv.includes("--no-export");
const outIdx = argv.indexOf("--out");
const outDir = outIdx >= 0 ? argv[outIdx + 1] : argv.find((a) => !a.startsWith("--") && a !== argv[outIdx + 1]);

const node = realNode();
const tauriCli = tool("@tauri-apps/cli/tauri.js");

const build = run("tauri build (frontend + rust + nsis)", node, [tauriCli, "build"]);
if (build.code !== 0) {
  console.log("");
  console.log("package: FAILED at tauri build (exit " + build.code + ")");
  process.exit(build.code);
}

if (!noExport) {
  const args = [join(repoRoot, "scripts", "export-release.mjs"), "--exe"];
  if (outDir) args.splice(1, 0, outDir);
  const exp = run("export out of the project tree", node, args);
  if (exp.code !== 0) {
    console.log("");
    console.log("package: tauri build OK, but export FAILED (exit " + exp.code + ")");
    process.exit(exp.code);
  }
}

console.log("");
console.log("package: OK" + (noExport ? " (export skipped)" : " (artifacts exported out of tree)"));
