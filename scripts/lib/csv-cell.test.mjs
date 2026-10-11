/**
 * scripts/lib/csv-cell.test.mjs —— csvCell 的公式注入（CWE-1236）回归测试。
 *
 * 为什么这么测：`src/lib/csvExport.ts` 依赖其它模块与 @tauri-apps/api，没法直接 import；
 * 而 `csvCell` 本身是**自包含**的，所以从源码里按大括号配对抠出函数体，用 typescript
 * 转译后执行。这样测的是**真实源码**，不是复制来的副本。
 * ⚠️ 源码是 CRLF，抠取按大括号配对做，不依赖行尾。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { repoRoot } from "../dev/env.mjs";

const require = createRequire(import.meta.url);

/** 从源码里抠出 `export function <name>(...)...{...}`（大括号配对，含首尾）。 */
function extractFunction(src, name) {
  const start = src.indexOf("export function " + name + "(");
  if (start < 0) throw new Error("source function not found: " + name);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting: " + name);
}

const srcPath = join(repoRoot, "src", "lib", "csvExport.ts");
const src = readFileSync(srcPath, "utf8");
const ts = require("typescript");
const js = ts.transpileModule(extractFunction(src, "csvCell"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const csvCell = new Function("exports", js + "\nreturn exports.csvCell;")({});

let pass = 0;
let fail = 0;
function eq(actual, expected, what) {
  if (actual === expected) {
    pass++;
    console.log("ok   " + what + "  => " + JSON.stringify(actual));
  } else {
    fail++;
    console.log("FAIL " + what + "  got " + JSON.stringify(actual) + " want " + JSON.stringify(expected));
  }
}

// ---- 公式注入：字符串以 = + - @ tab CR 开头时必须加单引号中和 ----
eq(csvCell("=1+1"), "'=1+1", "string starting with =");
eq(csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0", "string starting with +");
eq(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)", "=SUM");
eq(csvCell("@SUM(A1)"), "'@SUM(A1)", "string starting with @");
eq(csvCell("\t=1+1"), "'\t=1+1", "string starting with TAB then =");
eq(csvCell("\r=1"), "\"'\r=1\"", "string starting with CR then = (neutralised, then quoted per RFC 4180)");
eq(csvCell("-5"), "'-5", "string '-5' is a string, so it is neutralised too");

// ---- 数值不能被中和：负数是合法数据，必须保持可计算 ----
eq(csvCell(-5), "-5", "number -5 stays numeric");
eq(csvCell(-3.5), "-3.5", "number -3.5 stays numeric");
eq(csvCell(0), "0", "number 0");

// ---- RFC 4180 转义 ----
eq(csvCell("a,b"), '"a,b"', "comma gets quoted");
eq(csvCell('say "hi"'), '"say ""hi"""', "inner quotes get doubled");
eq(csvCell("line1\nline2"), '"line1\nline2"', "newline gets quoted");

// ---- 空值 ----
eq(csvCell(null), "", "null -> empty");
eq(csvCell(undefined), "", "undefined -> empty");

console.log("");
console.log("tests " + (pass + fail) + " / pass " + pass + " / fail " + fail);
process.exit(fail === 0 ? 0 : 1);
