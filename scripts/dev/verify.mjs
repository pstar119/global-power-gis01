/**
 * scripts/dev/verify.mjs —— 一条命令跑完全部验证。
 *
 * 用法
 * ----
 *   node scripts/dev/verify.mjs            # 快：前端类型检查 + 单元测试（秒级）
 *   node scripts/dev/verify.mjs --rust     # 再加 cargo check / clippy(-D warnings) / test（分钟级）
 *
 * 设计意图（见 docs 里的"省时间"约定）
 *   - 迭代时只跑快的：改代码 → verify → 攒够一批再打包；
 *   - 打包/真机验收用 scripts/dev/package.mjs，别在迭代里反复 build --release。
 * 控制台标签用 ASCII（原因见 env.mjs 头部说明）。
 */
import { join } from "node:path";
import { cargoExe, realNode, repoRoot, run, tauriDir, tool } from "./env.mjs";

const argv = process.argv.slice(2);
const wantRust = argv.includes("--rust") || argv.includes("--all");
const node = realNode();
const tsc = tool("typescript/bin/tsc");

const results = [];
function step(label, bin, args, cwd) {
  const r = run(label, bin, args, { cwd });
  results.push({ label, code: r.code, secs: r.secs });
  return r.code === 0;
}

step("typecheck: src (tsconfig.json)", node, [tsc, "--noEmit", "--pretty", "false"]);
step("typecheck: vite.config.ts (tsconfig.node.json)", node, [
  tsc,
  "-p",
  "tsconfig.node.json",
  "--noEmit",
  "--pretty",
  "false",
]);
step("unit tests: all scripts/**/*.test.mjs", node, [join(repoRoot, "scripts", "dev", "test.mjs")]);

if (wantRust) {
  step("cargo check --all-targets", cargoExe(), ["check", "--all-targets", "--quiet"], tauriDir);
  step("cargo clippy --all-targets -- -D warnings", cargoExe(), [
    "clippy",
    "--all-targets",
    "--quiet",
    "--",
    "-D",
    "warnings",
  ], tauriDir);
  step("cargo test", cargoExe(), ["test", "--quiet"], tauriDir);
}

const failed = results.filter((r) => r.code !== 0);
console.log("");
console.log("================ VERIFY SUMMARY ================");
for (const r of results) {
  console.log((r.code === 0 ? "PASS" : "FAIL").padEnd(4) + "  " + r.secs.toFixed(1).padStart(6) + "s  " + r.label);
}
console.log("total: " + results.length + " steps, " + failed.length + " failed" + (wantRust ? "" : "  (rust checks skipped; use --rust)"));
process.exit(failed.length === 0 ? 0 : 1);
