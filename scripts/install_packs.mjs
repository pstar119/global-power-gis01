/**
 * 阶段39：把数据包投放进 `packs/` 目录。
 *
 * 为什么需要这一步：数据包**刻意不进安装包**（8 个包共 170 MB，塞进去会让安装包从
 * ~47 MB 涨到 ~210 MB）。不进安装包 ⇒ 它们不会出现在 $RESOURCE 下 ⇒ asset 协议读不到。
 * 所以需要一个「投放」动作把它们复制到 `packs/`。
 *
 * 投放目标有两处，**优先级不同**（与 Rust 侧 `resolve_pack_resource()` 一致）：
 *   1. `%APPDATA%\com.pstar119.globalpowergis\packs\` —— **用户目录，第一顺位**
 *   2. `$RESOURCE/packs/` —— 开发态 = `src-tauri/target/debug/packs`；生产态 = 安装目录
 *
 * ⚠️ 优先用 `--user-dir`：用户目录**不会**被 `cargo clean` / 删除 target / NSIS 升级清掉，
 *    而 `$RESOURCE/packs/` 会被（这是「不膨胀安装包」的必然代价）。
 *
 * 用法：
 *   node scripts/install_packs.mjs                      # 全部包 → dev 的 $RESOURCE/packs
 *   node scripts/install_packs.mjs --user-dir           # 全部包 → 用户目录（**推荐**）
 *   node scripts/install_packs.mjs --only xinan,xibei   # 只投放指定的包
 *   node scripts/install_packs.mjs --only gem           # GEM 也走同一套（别名见 ALIASES）
 *   node scripts/install_packs.mjs --dest "D:\apps\Global Power GIS\packs"   # 指定目标（生产）
 *   node scripts/install_packs.mjs --list               # 只看现状，不复制
 *
 * ‼️ 阶段54 修的两个盲区（此前会让「本机包齐全」这件事无法复现）：
 *    ① 过滤器只认 `osm-*.pmtiles`，于是 **`gem-plants.pmtiles` 永远投放不了** ——
 *       GEM 图层只能靠联网下载，对一个「离线优先」的应用是自相矛盾的。
 *    ② 默认目标只有 dev 的 `$RESOURCE`，**没有一条路径能投放到用户目录** ——
 *       而用户目录恰恰是运行时优先级最高的位置。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "data", "packs");
/** 开发态 $RESOURCE（tauri dev 把资源放到这里） */
const DEV_DEST = join(ROOT, "src-tauri", "target", "debug", "packs");

/**
 * 应用标识符 —— ⚠️ 必须与 `src-tauri/tauri.conf.json` 的 `identifier` 保持一致。
 * 它决定 `app_data_dir()` 落在哪个目录下，两边不一致就会「脚本投了、应用读不到」。
 */
const APP_IDENTIFIER = "com.pstar119.globalpowergis";

/** 桌面应用的用户数据目录（此处只放 packs 子目录，与 Rust 侧 `packs_dir()` 一致）。 */
function userPacksDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) {
    throw new Error(
      "找不到环境变量 %APPDATA%（--user-dir 仅适用于 Windows）。请改用 --dest <dir> 指定目标。",
    );
  }
  return join(appdata, APP_IDENTIFIER, "packs");
}

function parseArgs(argv) {
  const cfg = { dest: DEV_DEST, only: null, list: false, isUserDir: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dest") {
      cfg.dest = resolve(next());
      cfg.isUserDir = false;
    } else if (a === "--user-dir") {
      cfg.dest = userPacksDir();
      cfg.isUserDir = true;
    } else if (a === "--only") cfg.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--list") cfg.list = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/install_packs.mjs [选项]",
          "",
          "  --user-dir     投放到用户目录（%APPDATA%\\<identifier>\\packs，**推荐**，优先级最高）",
          "  --dest <dir>   指定目标目录（覆盖 --user-dir；默认 dev 的 src-tauri/target/debug/packs）",
          "  --only a,b     只投放指定包（如 xinan,xibei 或 gem；默认全部）",
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

/**
 * `--only` 接受的**别名**：包文件名的主体 → 清单里的 `key`。
 *   osm-huadong.pmtiles → 主体 `osm-huadong`，去掉 `osm-` 前缀后是 `huadong`（= 清单 key）
 *   gem-plants.pmtiles  → 主体 `gem-plants`，而清单里的 key 是 **`gem`**（不是 gem-plants）
 * ⇒ 两个名字都接受，避免「记错 key 就找不到包」这种无谓的挫败。
 */
const ALIASES = { "gem-plants": ["gem"] };

/** 一个包文件的所有可辨识名字（至少含文件名主体，**去重**）。 */
function keysOf(fileName) {
  const stem = fileName.replace(/\.pmtiles$/, "");
  const short = stem.replace(/^osm-/, "");
  // ⚠️ 用 Set 去重：`gem-plants` 去掉 `osm-` 前缀后不变，不加 Set 会输出
  //    「gem-plants,gem-plants,gem」这种重复项，看着像脚本有 bug。
  return [...new Set([stem, short, ...(ALIASES[stem] ?? [])])];
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

  // ‼️ 阶段54：不再限定 `osm-` 前缀 —— 数据包有两类（region 与 gem），
  //    只认 osm- 会让 gem-plants.pmtiles 永远投放不了（见文件头「两个盲区」）。
  const all = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".pmtiles"))
    .sort();
  const picked = cfg.only ? all.filter((f) => keysOf(f).some((k) => cfg.only.includes(k))) : all;

  console.log("=== 数据包投放 ===");
  console.log(`源目录 : ${SRC_DIR}`);
  console.log(`目标   : ${cfg.dest}`);
  if (cfg.only) console.log(`筛选   : ${cfg.only.join(",")}`);
  console.log(`包数量 : ${picked.length}/${all.length}\n`);

  if (!picked.length) {
    // 提示时列出**所有可用别名**，让用户看到 gem 也能用 --only 选中
    console.error("⛔ 没有匹配的包。可用：");
    for (const f of all) console.error(`   ${f.padEnd(24)} → --only ${keysOf(f).join(",")}`);
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

  // ⚠️ 这段告警**只对 $RESOURCE 目标成立**：用户目录不会被 cargo clean / 升级清掉，
  //    无条件打印会让「已经用 --user-dir 投好了」的人以为白做了。
  if (!cfg.isUserDir) {
    console.log(
      "\n⚠️ 目标不是用户目录：`cargo clean`、删除 target、或 NSIS 升级后都需要重跑本脚本。",
    );
    console.log("   想一次性投到不受上述操作影响的位置，改用：--user-dir");
  } else {
    console.log("\n✅ 已投放到用户目录（运行时第一顺位，不受 cargo clean / NSIS 升级影响）。");
  }
  return 0;
}

process.exitCode = main();
