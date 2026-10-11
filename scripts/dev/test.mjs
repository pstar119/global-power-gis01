/**
 * scripts/dev/test.mjs —— 跑 scripts 下所有 *.test.mjs。
 *
 * 为什么需要它：项目里没有测试框架（不新增依赖），测试文件就是普通的 node 脚本，
 * 自己打印结果并以退出码表示成败。本文件负责发现 + 逐个执行 + 汇总。
 * ⚠️ 只扫 scripts/ 目录（不扫 node_modules / data）。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { realNode, repoRoot, run } from "./env.mjs";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".test.mjs")) out.push(p);
  }
  return out;
}

const files = walk(join(repoRoot, "scripts")).sort();
if (files.length === 0) {
  console.log("no test files found under scripts/");
  process.exit(0);
}

const node = realNode();
const results = [];
for (const f of files) {
  const label = "test: " + f.slice(repoRoot.length + 1).replace(/\\/g, "/");
  const r = run(label, node, [f]);
  results.push({ label, code: r.code, secs: r.secs });
}

const failed = results.filter((r) => r.code !== 0);
console.log("");
console.log("================ TEST SUMMARY ================");
for (const r of results) console.log((r.code === 0 ? "PASS" : "FAIL").padEnd(4) + "  " + r.label);
console.log(files.length + " test file(s), " + failed.length + " failed");
process.exit(failed.length === 0 ? 0 : 1);
