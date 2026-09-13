/**
 * 阶段39：把区域数据包投放进 $RESOURCE/packs/。
 *
 * 为什么需要这一步：区域包**刻意不进安装包**（7 个包共 116 MB，塞进去会让安装包从 ~54 MB
 * 涨到 ~170 MB）。不进安装包 ⇒ 它们不会出现在 $RESOURCE 下 ⇒ asset 协议读不到。
 * 所以需要一个「投放」动作把它们复制到 $RESOURCE/packs/。
 *
 * $RESOURCE 的位置：
 *   · 开发（tauri dev）：src-tauri/target/debug/      ← 实测过，asset URL 落在 target\debug\maps\…
 *   · 生产（装完之后）：安装目录，NSIS 用 installMode=currentUser，所以是用户可写的
 *
 * ⚠️ 代价必须说清楚：包不在安装包里，所以 `cargo clean`、删除 target、或 NSIS 升级
 *    都可能清掉 packs/，需要重跑一次本脚本。这是「不膨胀安装包」的必然取舍。
 *
 * 用法：
 *   node scripts/install_packs.mjs                      # 全部包 → dev 的 $RESOURCE/packs
 *   node scripts/install_packs.mjs --only xinan,xibei   # 只投放指定的包
 *   node scripts/install_packs.mjs --dest "D:\apps\Global Power GIS\packs"   # 指定目标（生产）
 *   node scripts/install_packs.mjs --list               # 只看现状，不复制
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "data", "packs");
/** 开发态 $RESOURCE（tauri dev 把资源放到这里） */
const DEV_DEST = join(ROOT, "src-tauri", "target", "debug", "packs");

function parseArgs(argv) {
  const cfg = { dest: DEV_DEST, only: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dest") cfg.dest = resolve(next());
    else if (a === "--only") cfg.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--list") cfg.list = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/install_packs.mjs [选项]",
          "",
          "  --dest <dir>   目标目录（默认 dev 的 src-tauri/target/debug/packs）",
          "  --only a,b     只投放指定 region（默认全部）",
          "  --list         只列出现状，不复制",
          "",
          "生产环境：把包复制到安装目录的 packs/ 子目录，例如",
          '  node scripts/install_packs.mjs --dest "%LOCALAPPDATA%\\Global Power GIS\\packs"',
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  return cfg;
}

function mb(p) {
  return (statSync(p).size / 1048576).toFixed(2);
}

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg) return 0;

  if (!existsSync(SRC_DIR)) {
    console.error(`⛔ 找不到 ${SRC_DIR}。请先跑流水线生成区域包：`);
    console.error("   node scripts/run_pipeline.mjs --regions huazhong,huanan,huabei,dongbei,xinan,xibei");
    return 1;
  }

  const all = readdirSync(SRC_DIR)
    .filter((f) => f.startsWith("osm-") && f.endsWith(".pmtiles"))
    .sort();
  const picked = cfg.only ? all.filter((f) => cfg.only.includes(f.replace(/^osm-|\.pmtiles$/g, ""))) : all;

  console.log("=== 区域数据包投放 ===");
  console.log(`源目录 : ${SRC_DIR}`);
  console.log(`目标   : ${cfg.dest}`);
  console.log(`包数量 : ${picked.length}/${all.length}\n`);

  if (!picked.length) {
    console.error("⛔ 没有匹配的包。可用：" + all.map((f) => f.replace(/^osm-|\.pmtiles$/g, "")).join(","));
    return 1;
  }

  if (cfg.list) {
    console.log("（--list 模式，不复制）");
    for (const f of picked) {
      const dest = join(cfg.dest, f);
      const state = existsSync(dest)
        ? `已存在 ${mb(dest)} MB`
        : "未投放";
      console.log(`  ${f.padEnd(24)} ${mb(join(SRC_DIR, f)).padStart(7)} MB   目标：${state}`);
    }
    return 0;
  }

  mkdirSync(cfg.dest, { recursive: true });
  let copied = 0;
  let totalMb = 0;
  for (const f of picked) {
    const src = join(SRC_DIR, f);
    const dest = join(cfg.dest, f);
    // 已存在且体积相同就跳过：这些包单个 10~25 MB，没必要每次重写
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
      console.log(`  = ${f.padEnd(24)} ${mb(src).padStart(7)} MB  （体积相同，跳过）`);
      totalMb += Number(mb(src));
      continue;
    }
    copyFileSync(src, dest);
    copied++;
    totalMb += Number(mb(src));
    console.log(`  ✓ ${f.padEnd(24)} ${mb(src).padStart(7)} MB`);
  }

  console.log(`\n复制 ${copied} 个，跳过 ${picked.length - copied} 个；目标目录现有 ${(totalMb).toFixed(2)} MB`);
  console.log(
    "\n⚠️ 这些包不在安装包里：`cargo clean`、删除 target、或 NSIS 升级后都需要重跑本脚本。",
  );
  return 0;
}

process.exitCode = main();
