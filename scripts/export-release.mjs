/**
 * 把 Release 产物复制到「项目树之外」再运行 —— 规避 DSH 沙箱给工作区打的 Low 完整性标签。
 *
 * 背景（2026-10-11 实测）
 * ----------------------
 * DSH 的本地沙箱会给工作区目录（本项目 = J:\Projects\global-power-gis）常驻打上 Windows 的
 * Low 完整性强制标签（mandatory label），并附带一个能力 SID 的允许 ACE。按 Windows 规则，
 * 进程的完整性级别取决于**镜像文件自带的标签**，所以从这棵树里构建出来的任何 exe
 * （bundle\nsis\*setup.exe、target\release\global-power-gis.exe）都会以 Low IL 启动；
 * 而 Low 进程对 Medium 及以上的对象（K:\、%APPDATA%、HKCU、桌面）是写拒绝 —— 典型症状是
 * NSIS 安装报「无法打开要写入的文件」，或者从树里直接跑 exe 时应用写不了数据库与 packs 目录。
 *
 * 复制（copyFileSync）不会带走源文件的强制标签，新文件继承**目标目录**的标签，
 * 所以把产物复制到未打标签的目录后一切正常。
 *
 * 用法
 * ----
 *   node scripts/export-release.mjs                  # 最新 NSIS 安装包 → 桌面
 *   node scripts/export-release.mjs D:\gpg-release   # 指定输出目录
 *   node scripts/export-release.mjs --exe            # 连 release 版 exe 一起复制
 *   node scripts/export-release.mjs --force          # 允许输出到项目树内（不建议）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(repoRoot, "src-tauri", "target", "release", "bundle", "nsis");
const releaseExe = join(repoRoot, "src-tauri", "target", "release", "global-power-gis.exe");

const argv = process.argv.slice(2);
const wantExe = argv.includes("--exe");
const force = argv.includes("--force");
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}
const positional = argv.filter((a) => !a.startsWith("--"));

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;

function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

/** 读强制标签，只认 icacls 的输出；没有 icacls（非 Windows）或读不到时返回 unknown。 */
function labelOf(file) {
  try {
    const out = execFileSync("icacls", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/Low Mandatory Level/i.test(out)) return "low";
    if (/Mandatory Label/i.test(out)) return "other";
    return "none";
  } catch {
    return "unknown";
  }
}

function labelText(kind) {
  if (kind === "low") return "Low（会被以低完整性启动，写不了 Medium 及以上位置）";
  if (kind === "none") return "无 Low 标签 ✅";
  if (kind === "other") return "有强制标签（不是 Low）";
  return "读不到（跳过检查）";
}

/** 挑最新的 NSIS 安装包：优先版本号匹配，其次修改时间最新。 */
function pickInstaller() {
  if (!existsSync(bundleDir)) return null;
  const all = readdirSync(bundleDir)
    .filter((n) => n.toLowerCase().endsWith(".exe"))
    .map((n) => join(bundleDir, n));
  if (all.length === 0) return null;
  const matching = all.filter((p) => basename(p).includes("_" + version + "_"));
  const pool = matching.length > 0 ? matching : all;
  pool.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return pool[0];
}

const installer = pickInstaller();
if (!installer) {
  console.error("[export-release] 没找到 NSIS 安装包：" + bundleDir);
  console.error("                  先跑构建：npm run tauri build");
  process.exit(1);
}

let destDir = positional[0] ? resolve(positional[0]) : join(homedir(), "Desktop");
if (!existsSync(destDir) && positional[0]) mkdirSync(destDir, { recursive: true });
if (!existsSync(destDir)) destDir = homedir();

const insideTree = resolve(destDir).toLowerCase().startsWith(resolve(repoRoot).toLowerCase() + sep);
if (insideTree && !force) {
  console.error("[export-release] 输出目录落在项目树里，导出就没意义了（新文件会继承 Low 标签）：");
  console.error("                " + destDir);
  console.error("                换一个树外的目录，或用 --force 强行继续。");
  process.exit(1);
}

const targets = [installer];
if (wantExe) {
  if (existsSync(releaseExe)) targets.push(releaseExe);
  else console.warn("[export-release] 跳过 --exe：不存在 " + releaseExe);
}

console.log("导出 Release 产物（项目树 " + repoRoot + " 内的 exe 会被以 Low IL 启动，必须先复制出来）");
let bad = 0;
for (const src of targets) {
  const name = basename(src);
  const dst = join(destDir, name);
  copyFileSync(src, dst);
  const size = statSync(dst).size;
  const hash = sha256(dst);
  const kind = labelOf(dst);
  if (kind === "low") bad += 1;
  console.log("");
  console.log("  " + name);
  console.log("    源    : " + src + "  (" + human(statSync(src).size) + ")");
  console.log("    目标  : " + dst + "  (" + human(size) + ")");
  console.log("    sha256: " + hash);
  console.log("    标签  : " + labelText(kind));
}

console.log("");
if (bad > 0) {
  console.error("[export-release] 导出后的文件仍带 Low 标签，说明输出目录本身在被打标签的树里 —— 换个目录。");
  process.exit(1);
}
console.log("完成。安装/运行请一律使用上面「目标」里的那份：");
for (const src of targets) console.log("  " + join(destDir, basename(src)));
console.log("（安装包可直接双击；静默安装示例：\"<路径>\" /S /D=K:\\Global Power GIS）");
