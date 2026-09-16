/**
 * 阶段49：把 `public/packs_manifest.json` 还原成**发布态**，并验证它确实不是本地地址。
 *
 * ━━━ 为什么需要它 ━━━
 * 本地下载链路实测（README_OFFLINE_TEST.md）要求把 `http://127.0.0.1:8099`
 * **烧进清单**再重新打包。测完如果忘了还原：
 *   · 你手上那个 .exe 里烧的是 127.0.0.1
 *   · 发给任何人 ⇒ **100% 下载失败**，而且界面只会说「下载失败」，看不出原因
 * 所以这一步不能靠"记得"，要靠一条命令 + 一个会**大声失败**的校验。
 *
 * ━━━ 它做了什么 ━━━
 *   1. `git checkout -- public/packs_manifest.json` 还原到 HEAD 的版本
 *   2. 读回清单，打印 release.baseUrl
 *   3. 🔴 **断言 baseUrl 不是回环地址** —— 是的话 exit 1（绝不允许"看起来成功"）
 *   4. 检查工作区里该文件是否干净
 *   5. 提醒重新 `npm run tauri build`（还原清单 ≠ 还原安装包）
 *
 * 用法：
 *     node scripts/restore_packs_manifest.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "public", "packs_manifest.json");
const REL = "public/packs_manifest.json";
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i;

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

console.log("=== 还原 public/packs_manifest.json ===");

let dirty;
try {
  dirty = git("status", "--porcelain", "--", REL);
} catch (e) {
  fail(`git 不可用：${e.message}`);
}
console.log(dirty ? `  改动前状态 : ${dirty}` : "  改动前状态 : 干净（无需还原）");

try {
  git("checkout", "--", REL);
} catch (e) {
  fail(`git checkout 失败：${e.message}`);
}
console.log("  已执行 : git checkout -- " + REL);

// ---- 校验：还原后的基址绝不能是回环地址 ----
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (e) {
  fail(`清单读取/解析失败：${e.message}`);
}

const baseUrl = manifest?.release?.baseUrl ?? "";
console.log(`  当前 baseUrl : ${baseUrl}`);

if (!baseUrl) fail("清单里没有 release.baseUrl —— 还原结果不可信");
if (LOOPBACK.test(baseUrl)) {
  fail(
    `baseUrl 仍然是回环地址：${baseUrl}\n` +
      "  ⇒ 这份清单**绝不能**用于发布（所有用户都会下载失败）。\n" +
      "  可能原因：checkout 之后又被重新生成过（比如 shell 里还留着 PACKS_BASE_URL）。\n" +
      "  请检查并清掉该环境变量后重试：Remove-Item Env:\\PACKS_BASE_URL",
  );
}

const packs = manifest?.packs ?? [];
const missingSha = packs.filter((p) => !p.sha256).length;
console.log(`  包数量       : ${packs.length}（缺 sha256 的：${missingSha}）`);
if (missingSha > 0) {
  fail(
    `有 ${missingSha} 个包缺少 sha256 —— 前端拿不到校验和就无法下载。\n` +
      "  这通常说明清单是在 data/packs 不完整时重新生成的。请核对后重试。",
  );
}

const stillDirty = git("status", "--porcelain", "--", REL);
if (stillDirty) fail(`还原后该文件仍然有改动：${stillDirty}`);

console.log("  ✅ 清单已是发布态，且工作区干净");

console.log(
  [
    "",
    "=".repeat(72),
    "⚠️ 还差一步：还原清单 **不等于** 还原安装包。",
    "   你之前为本地测试打的那个 .exe 里烧的仍是 127.0.0.1，必须重新构建：",
    "",
    "     npm run tauri build",
    "",
    "   构建后确认（这一步别省）：",
    '     (Get-Content dist\\packs_manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).release.baseUrl',
    "   期望是 https://gh-proxy.com/https://github.com/... —— 不能出现 127.0.0.1",
    "=".repeat(72),
    "",
  ].join("\n"),
);
