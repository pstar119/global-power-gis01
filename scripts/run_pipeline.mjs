/**
 * 阶段38：全国分批流水线驱动
 *
 * 职责：把「批次定义」翻译成一串串行的 `fetch → prepare → build` 调用，
 * 每批结束后输出**三个数字**（要素数 / 归档体积 / 最大单瓦片）与失败块清单。
 *
 * 三条设计红线（都是踩过的坑）：
 *  1. **绝不并行**：Overpass 连发就被 429 打回，退避重试反而更慢。批次之间、块之间全部串行。
 *  2. **有缺口就不出包**：抓取有任何失败块时，默认**拒绝**切片 ——
 *     否则会生成一个看起来正常、实际有覆盖空洞的可选包。要强行出包得显式 --force。
 *  3. **进度落盘为 UTF-8**：PowerShell 的 `*>` 会写 UTF-16LE，文本工具读不了。
 *     这里用 `appendFileSync(..., 'utf8')` 自己写日志，保证任何时候都能读回来。
 *
 * 用法：
 *   node scripts/run_pipeline.mjs --dry-run                    # 只打印将要执行的命令
 *   node scripts/run_pipeline.mjs --stage scan                 # 只做全国粗扫（估体积）
 *   node scripts/run_pipeline.mjs --regions huazhong --stage fetch,prepare,build
 *   node scripts/run_pipeline.mjs                              # 全部批次全流程
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CELL_MEASURED, REGIONS, cellSizeOf, gridFor, scanSample } from "./pipeline_regions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALL_STAGES = ["scan", "fetch", "prepare", "build"];
/**
 * 默认阶段**不含 scan**。
 *
 * 理由（`scripts/measure_count_cost.py` 实测，2026-09-13）：
 *   - out count 的耗时基本是固定开销（2.4~4.6 秒），与要素数无关；
 *   - 换算到整块：真抓 **44.0 秒/块**（华东 64 块实测）vs 扫描 ≈ **29 秒/块**，只快约 1.5x；
 *   - 而且单点外推**高估 77%**（华东按 1 块外推 165,760，真抓 93,559），估计值本身不可靠。
 * ⇒ 扫描省下的时间不足以成为杠杆，却换不到任何数据。**直接抓**更好（可续抓、产出真数据）。
 *   扫描保留为显式选项，用于「探测端点是否可用」与「判断某区域有没有数据」。
 */
const DEFAULT_STAGES = ["fetch", "prepare", "build"];

// ---------------------------------------------------------------- 参数
/**
 * 阶段43：抓取类别。
 *
 * ‼️ 为什么要拆分：抓取很贵（华东电力 44~50 秒/块 × 64 块）。
 *    如果只想补一批管道（比如新增某条长输管线），绝不应该把电网数据重抓一遍。
 *    每个类别的产物/断点/meta 完全隔离（见 `fetch_osm_power.py` 的 `geom_path` /
 *    `progress_path` / `meta_path`），所以可以单独重跑。
 *
 * `grid` 的含义：
 *  - `region`：沿用区域网格（与电力一致，块尺寸已实测安全）；
 *  - `coarse`：把块放大到边长约 `COARSE_CHUNK_DEG` 度。
 *    管道极稀疏（全国 7 区域加起来才千条量级），用电力那种小块会
 *    把时间全花在几十次空查询上；但也不能直接 1x1 —— Overpass 单次上限 180 秒，
 *    西北 bbox 有 669 deg²，实测外推会超时。所以要按面积限幅。
 */
const CATEGORY_INFO = {
  power: { label: "电力", metaFile: (n) => `${n}_power_meta.json`, grid: "region" },
  rail: { label: "铁路干线", metaFile: (n) => `${n}_rail_meta.json`, grid: "region" },
  pipeline: { label: "油气管道", metaFile: (n) => `${n}_pipeline_meta.json`, grid: "coarse" },
};
/** `coarse` 策略的目标块边长（度）。9° -> 约 80 deg²/块，实测外推单块 < 90 秒 */
const COARSE_CHUNK_DEG = 9;

/**
 * 某一类别在某批次上的分块方案。
 * ⚠️ 返回的 `cols/rows` 直接传给 `fetch_osm_power.py --grid`，
 *    必须与该类别已有的断点文件对应的网格一致，否则断点对不上会全部重抓
 *    （数据不会错，只是白跑）。
 */
function gridForCategory(region, category, target) {
  if (CATEGORY_INFO[category]?.grid !== "coarse") return gridFor(region, target);
  const [w, s, e, n] = region.bbox;
  return {
    cols: Math.max(1, Math.round((e - w) / COARSE_CHUNK_DEG)),
    rows: Math.max(1, Math.round((n - s) / COARSE_CHUNK_DEG)),
  };
}

function parseArgs(argv) {
  const cfg = {
    regions: null,
    categories: ["power"],
    stages: new Set(DEFAULT_STAGES),
    target: { ...CELL_MEASURED },
    scanFactor: 3,
    packDir: "data/packs",
    reportPath: "data/packs/pipeline_report.json",
    /**
     * 全国可选包**默认开启**低级别封顶，而切片脚本本身默认关闭。
     * 分工：驱动只产可选包（要素多，z0~z6 会把瓦片撑到近 1 MB）；
     * 切片脚本还要产进安装包的核心区归档，那里默认值必须保持不变 ——
     * 否则阶段29~37 关于 osm_grid.pmtiles 的全部验收结论会被静默推翻。
     */
    maxFeaturesPerTile: 20000,
    capBelowZoom: 8,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--regions") cfg.regions = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--category") {
      cfg.categories = next().split(",").map((s) => s.trim()).filter(Boolean);
      const bad = cfg.categories.filter((c) => !CATEGORY_INFO[c]);
      if (bad.length) throw new Error(`未知类别：${bad.join(",")}；可用：${Object.keys(CATEGORY_INFO).join(",")}`);
    }
    else if (a === "--stage") cfg.stages = new Set(next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--target-cell") {
      const [lon, lat] = next().split("x").map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon <= 0 || lat <= 0) {
        throw new Error("--target-cell 格式应为 1.1875x1.9375");
      }
      cfg.target = { ...cfg.target, lon, lat };
    } else if (a === "--scan-factor") cfg.scanFactor = Number(next());
    else if (a === "--pack-dir") cfg.packDir = next();    else if (a === "--max-features-per-tile") cfg.maxFeaturesPerTile = Number(next());
    else if (a === "--cap-below-zoom") cfg.capBelowZoom = Number(next());    else if (a === "--report") cfg.reportPath = next();
    else if (a === "--dry-run") cfg.dryRun = true;
    else if (a === "--force") cfg.force = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/run_pipeline.mjs [选项]",
          "",
          "  --regions a,b   只跑指定批次（默认全部，按密度递减顺序）",
          "  --category <list>  抓取类别，逗号分隔。默认 power",
          "                     power    电力设施（线路/变电站/电厂）",
          "                     rail     铁路干线（railway=rail 且无 service，不含地铁轻轨）",
          "                     pipeline 油气管道（man_made=pipeline 且 substance=gas|oil）",
          "                     ‼️ 各类别产物/断点/meta 完全隔离，可单独重跑某一类而不碰其他类",
          "  --stage s1,s2   要执行的阶段：fetch,prepare,build,scan（默认 fetch,prepare,build）",
          "                  不加 scan：实测它只快 ~1.5x 却换不到数据，直接抓更划算",
          "  --target-cell   目标块尺寸 lonxlat（默认对齐华东实测 1.1875x1.9375）",
          "  --scan-factor   抽样扫描的步长（默认 3 = 每 3 列/行取一格；**块尺寸与真抓一致**）",
          "  --pack-dir      可选包输出目录（默认 data/packs，该目录已被 .gitignore 忽略）",
          "  --max-features-per-tile <n>  低级别单瓦片要素封顶（默认 20000；0 = 关闭）",
          "  --cap-below-zoom <n>  只对低于该级别的瓦片封顶（默认 8）",
          "  --report        报表 JSON 路径（默认 data/packs/pipeline_report.json）",
          "  --dry-run       只打印命令，不执行",
          "  --force         即使抓取有失败块也继续切片（默认拒绝，避免出带空洞的包）",
          "",
          "批次：",
          ...REGIONS.map((r) => `  ${r.key.padEnd(10)} ${r.label}  ${r.provinces}`),
        ].join("\n"),
      );
      return null;
    } else throw new Error(`未知参数：${a}`);
  }
  return cfg;
}

// ---------------------------------------------------------------- 运行器

/**
 * 找一个可用的 Python 解释器。
 *
 * 🔴 **阶段54 修**：此前候选表里只有**一个**绝对路径 ——
 *    `%LOCALAPPDATA%\Programs\Python\Python311\python.exe`。实测（2026-09-18）
 *    这台机器上 python 装在 `C:\Python314\python.exe`，**那条路径根本不存在**，
 *    于是函数静默落到裸 `python` —— 而 python 不在 PATH，
 *    结果是整条流水线在第一步就崩，报的还是「找不到命令」这种与根因无关的错。
 *
 * 现在的顺序（**显式优先，猜测在后**）：
 *   1. `$env:PYTHON` —— 用户显式指定，永远最高优先。这是最稳的用法。
 *   2. 常见安装目录里**扫**一遍（`%LOCALAPPDATA%\Programs\Python\Python3*`
 *      与 `C:\Python3*`）—— 不再写死小版本号。
 *   3. 裸 `python` —— 交给 PATH 碰运气，并在下面打印实际用到的解释器，
 *      以便「跑的是哪个 Python」不再靠猜。
 */
function pythonPath() {
  // 1) 显式指定
  const explicit = process.env.PYTHON;
  if (explicit && isAbsolute(explicit) && existsSync(explicit)) return explicit;

  // 2) 扫常见目录。⚠️ 用 readdirSync 才能适配任意小版本（3.11 / 3.14 / …）
  const roots = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Python"),
    "C:\\",
    "D:\\",
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // 目录不可读（权限/不存在）——跳过，不要因此崩掉
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/^Python3/i.test(e.name)) continue;
      const cand = join(root, e.name, "python.exe");
      if (existsSync(cand)) return cand;
    }
  }

  // 3) 兜底：交给 PATH（并在调用处打印实际解释器）
  return "python";
}

const PY = pythonPath();

/**
 * 打印实际用到的解释器。
 *
 * ‼️ 阶段54 加：此前「跑的是哪个 Python」只能靠猜，而候选表写死的那条路径
 *    在本机并不存在 —— 于是「流水线崩了」和「解释器选错了」之间的因果
 *    要花很久才能建立。打一行出来，这类问题一眼可见。
 */
console.log(`[pipeline] Python = ${PY}${process.env.PYTHON ? "（来自 $env:PYTHON）" : ""}`);

/**
 * ⚠️ 必须带 `-u`：驱动用管道接住子进程 stdout，此时 Python 会切成**块缓冲**，
 *    进度要等缓冲区满或进程退出才吐出。实测过一次：扫描跑了 5 分钟，终端一个字都没有，
 *    只能靠产物文件猜进度。对几小时的全国运行，这是不可接受的。
 */
const PY_ARGS_PREFIX = ["-u"];

/** 跑一条命令：实时转发输出到控制台，同时以 UTF-8 追加到日志文件 */
function runStep(label, cmd, args, logFile) {
  const printable = [cmd, ...args].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(" ");
  console.log(`\n${"─".repeat(72)}\n▶ ${label}\n  ${printable}\n${"─".repeat(72)}`);
  return new Promise((resolvePromise) => {
    if (!logFile) {
      // dry-run 路径不会走到这
    }
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      /**
       * ⚠️ 必须显式指定 Python 的 IO 编码。
       *
       * 实测踩坑（2026-09-13）：加了 `-u` 之后，Python 的 stdout 变成**管道**，
       * 此时它不再按控制台编码输出，而是按 Windows 本地编码（GBK）写字节；
       * 而 Node 按 UTF-8 解码 ⇒ 中文全部变成 `�׶�28` 这样的乱码，
       * **而且这个乱码会被原样写进日志文件**，几小时后就没法分析了。
       * 数据本身没事（都走文件落盘），但监控与事后分析全废。
       */
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
      },
    });
    let out = "";
    const onData = (stream, chunk) => {
      const s = chunk.toString();
      out += s;
      stream.write(s);
    };
    child.stdout.on("data", (d) => onData(process.stdout, d));
    child.stderr.on("data", (d) => onData(process.stderr, d));
    child.on("error", (err) => {
      out += `\n[spawn error] ${err.message}\n`;
      console.error(`  ⚠️ 无法启动：${err.message}`);
    });
    child.on("close", (code) => {
      if (logFile) {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(
          logFile,
          `\n===== ${label} :: ${printable} (exit ${code}) =====\n${out}\n`,
          "utf8",
        );
      }
      resolvePromise({ code: code ?? -1, out });
    });
  });
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 原子写 JSON：先写同目录 `.tmp`，再 `rename` 替换。
 *
 * 🔴 阶段43：与 `fetch_osm_power.py` 的 `write_json_atomic` 同一个理由。
 *    报表每批结束都会重写，而这个驱动要串行跑 7 个区域、可能十几个小时 ——
 *    被中断正好落在写入窗口的概率并不低。
 *    `writeFileSync` 会**先截断再写**，一旦被打断就留下非法 JSON；
 *    下次启动的 `readJson` 读出 null，会被当成「没有报表」从零开始 ——
 *    **已经跑完的批次记录全丢**（原始数据与包都还在，但清单里的要素数/体积会变 null）。
 *    `rename` 在同卷上是原子的，不存在中间态。
 */
function writeJsonAtomic(p, payload) {
  const tmp = `${p}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, p);
}

function sizeMb(p) {
  try {
    return Number((statSync(p).size / 1048576).toFixed(2));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 单批流程
async function processRegion(region, cfg, report) {
  const [w, s, e, n] = region.bbox;
  const bboxStr = `${w},${s},${e},${n}`;
  const { cols, rows } = gridFor(region, cfg.target);
  const cell = cellSizeOf(region, cfg.target);
  const chunks = cols * rows;
  const name = region.key;
  const logFile = join(ROOT, "data", "logs", `pipeline_${name}.log`);
  const packOut = join(cfg.packDir, `osm-${name}.pmtiles`);

  const rec = {
    key: name,
    label: region.label,
    provinces: region.provinces,
    bbox: region.bbox,
    grid: `${cols}x${rows}`,
    cellSize: `${cell.lon.toFixed(3)}x${cell.lat.toFixed(3)}`,
    chunks,
    status: "started",
    stages: {},
    startedAt: new Date().toISOString(),
  };

  console.log(`\n\n${"█".repeat(72)}`);
  console.log(`█ 批次 ${region.label}（${name}） · ${region.provinces}`);
  console.log(`█ bbox ${bboxStr} · 网格 ${cols}x${rows} = ${chunks} 块 · 块尺寸 ${rec.cellSize}`);
  console.log(`█ 串行预计 ${((chunks * cfg.target.secPerChunk) / 60).toFixed(0)} 分钟（按 ${cfg.target.secPerChunk} 秒/块估算）`);
  console.log(`${"█".repeat(72)}`);

  // ---- 1. 抽样扫描：只数数量，估体积 ----
  if (cfg.stages.has("scan")) {
    const s = scanSample(region, cfg.scanFactor, cfg.target);
    console.log(
      `\n[scan] 抽样扫描 ${s.cells}/${s.cols * s.rows} 块（step=${s.step}，**单块尺寸与真抓一致**）`,
    );
    const res = await runStep(
      "scan",
      PY,
      [
        ...PY_ARGS_PREFIX,
        "scripts/fetch_osm_power.py",
        "--bbox", bboxStr,
        "--grid", `${s.cols}x${s.rows}`,
        "--sample-step", String(s.step),
        "--name", name,
        "--count-only",
      ],
      logFile,
    );
    const scan = readJson(join(ROOT, "data", "osm", `scan_${name}.json`));
    rec.stages.scan = {
      exit: res.code,
      cells: scan?.scanned ?? null,
      empty: scan?.empty ?? null,
      anomalies: scan?.anomalies ?? null,
      totals: scan?.totals ?? null,
      scanStep: s.step,
    };
    if (scan?.totals) {
      // 用抽样实测密度外推整批要素数。⚠️ 这是**外推估计**，不是测量值：
      //    同一批内密度差异可能极大（如西北、西南），所以它只回答
      //    「这批大致是什么量级」，不能替代真抓后的实测数字。
      const scannedTotal = scan.totals.lines + scan.totals.substations + scan.totals.plants;
      const scannedCells = Math.max(1, scan.scanned ?? 1);
      rec.stages.scan.estFeatures = Math.round((scannedTotal / scannedCells) * chunks);
      console.log(
        `[scan] 实测：${scan.scanned} 块已扫，空块 ${scan.empty}，异常块 ${scan.anomalies}；` +
          `线 ${scan.totals.lines} 站 ${scan.totals.substations} 厂 ${scan.totals.plants}`,
      );
      console.log(
        `[scan] 按此密度外推整批 ${chunks} 块 ≈ ${rec.stages.scan.estFeatures} 个要素` +
          `（外推估计，非测量值；最终以真抓结果为准）`,
      );
    }
    if (res.code !== 0) {
      rec.status = "scan-failed";
      report.regions[name] = rec;
      console.error(`⚠️ [scan] 非零退出 ${res.code}，但扫描只是估算，继续后续阶段`);
    }
  }

  // ---- 2. 抓取（按类别逐个跑）----
  // ‼️ 每个类别的产物 / 断点 / meta 完全隔离（见 fetch_osm_power.py 的
  //    geom_path / progress_path / meta_path），所以「只补管道」不会碰电网数据。
  if (cfg.stages.has("fetch")) {
    rec.stages.fetch = {};
    let fetchFailed = false;
    for (const cat of cfg.categories) {
      const info = CATEGORY_INFO[cat];
      const g = gridForCategory(region, cat, cfg.target);
      const catChunks = g.cols * g.rows;
      console.log(`\n[fetch:${cat}] ${info.label} —— ${g.cols}x${g.rows} = ${catChunks} 块串行抓取（可中断，重跑同一条命令即续抓）`);
      if (catChunks !== chunks) {
        console.log(`           （与区域网格 ${cols}x${rows} 不同：${info.grid === "coarse" ? "本类别极稀疏，块已放大以避开大量空查询" : "与区域一致"}）`);
      }
      const res = await runStep(
        `fetch:${cat}`,
        PY,
        [
          ...PY_ARGS_PREFIX,
          "scripts/fetch_osm_power.py",
          "--bbox", bboxStr,
          "--grid", `${g.cols}x${g.rows}`,
          "--name", name,
          "--category", cat,
        ],
        logFile,
      );
      const meta = readJson(join(ROOT, "data", "osm", info.metaFile(name)));
      rec.stages.fetch[cat] = {
        label: info.label,
        grid: `${g.cols}x${g.rows}`,
        chunks: catChunks,
        exit: res.code,
        elapsedSec: meta?.elapsed_sec ?? null,
        complete: meta?.complete ?? null,
        failedChunks: meta?.failed_chunks?.length ?? null,
        duplicatesDropped: meta?.duplicates_dropped ?? null,
        outputs: meta?.outputs ?? null,
        // 电压分档只对电力有意义（铁路/管道没有 voltage）
        voltageClasses: cat === "power" ? (meta?.voltage_class_histogram ?? null) : null,
      };
      if (meta?.failed_chunks?.length) {
        fetchFailed = true;
        console.error(`\n${"⚠️".repeat(30)}`);
        console.error(`⚠️ 批次 ${region.label} / ${info.label} 有 ${meta.failed_chunks.length} 个失败块，数据存在覆盖空洞：`);
        for (const c of meta.failed_chunks) console.error(`     ${c.join(",")}`);
        console.error(`   补齐：node scripts/run_pipeline.mjs --regions ${name} --stage fetch --category ${cat}`);
        console.error(`${"⚠️".repeat(30)}`);
      }
      if (res.code !== 0 || meta?.complete === false) fetchFailed = true;
    }
    if (fetchFailed) {
      if (!cfg.force) {
        rec.status = "fetch-incomplete";
        report.regions[name] = rec;
        console.error(
          `\n⛔ 抓取未完整，**跳过 prepare/build** —— 宁可不出包，也不出带空洞的包。\n` +
            `   补抓后重跑本批次；确实要用残缺数据出包请显式加 --force。`,
        );
        return rec;
      }
      console.warn("\n⚠️ --force：抓取不完整仍然继续切片，产物可能含覆盖空洞。");
    }
  }

  // ---- 3. 清洗 ----
  if (cfg.stages.has("prepare")) {
    const res = await runStep(
      "prepare",
      process.execPath,
      ["scripts/prepare_osm_geojson.mjs", "--name", name, "--out-dir", "public/osm", "--out-name", `${name}_power`],
      logFile,
    );
    const pmeta = readJson(join(ROOT, "public", "osm", `${name}_power_meta.json`));
    rec.stages.prepare = {
      exit: res.code,
      featureCount: pmeta?.featureCount ?? null,
      byType: pmeta?.byType ?? null,
      byVoltageClass: pmeta?.byVoltageClass ?? null,
      outputSizeMb: pmeta?.outputSizeMb ?? null,
    };
    if (res.code !== 0) {
      rec.status = "prepare-failed";
      report.regions[name] = rec;
      console.error(`⛔ prepare 失败（exit ${res.code}），跳过 build`);
      return rec;
    }
  }

  // ---- 4. 切片（可选包） ----
  if (cfg.stages.has("build")) {
    const buildArgs = [
      "scripts/build_pmtiles.mjs",
      "--name", name,
      "--in", `public/osm/${name}_power.geojson`,
      "--out", packOut,
    ];
    if (cfg.maxFeaturesPerTile > 0) {
      buildArgs.push(
        "--max-features-per-tile", String(cfg.maxFeaturesPerTile),
        "--cap-below-zoom", String(cfg.capBelowZoom),
      );
    }
    const res = await runStep("build", process.execPath, buildArgs, logFile);
    const mFeatures = /要素数\s*:\s*([\d,]+)/.exec(res.out);
    const mTiles = /合计\s*:\s*([\d,]+)\s*张瓦片/.exec(res.out);
    const mGzip = /→\s*gzip\s+([\d.]+)\s*MB/.exec(res.out);
    const mCapped = /低级别封顶\s*:\s*([\d,]+)\s*张瓦片被截断，共丢弃\s*([\d,]+)\s*个要素/.exec(res.out);
    const mWidest = /最大单瓦片\s*:\s*([\d.]+)\s*KB 原始 \/ ([\d.]+)\s*KB gzip（z(\d+)\/(\d+)\/(\d+)，([\d,]+) 个要素）/.exec(res.out);
    rec.stages.build = {
      exit: res.code,
      out: packOut,
      packSizeMb: sizeMb(join(ROOT, packOut)),
      features: mFeatures ? Number(mFeatures[1].replace(/,/g, "")) : null,
      tiles: mTiles ? Number(mTiles[1].replace(/,/g, "")) : null,
      gzipMb: mGzip ? Number(mGzip[1]) : null,
      cappedTiles: mCapped ? Number(mCapped[1].replace(/,/g, "")) : null,
      cappedDropped: mCapped ? Number(mCapped[2].replace(/,/g, "")) : null,
      widest: mWidest
        ? { rawKb: Number(mWidest[1]), gzipKb: Number(mWidest[2]), z: +mWidest[3], x: +mWidest[4], y: +mWidest[5], features: Number(mWidest[6].replace(/,/g, "")) }
        : null,
    };
    rec.status = res.code === 0 ? "ok" : "build-failed";
  } else {
    // 没跑 build 时，状态如实写出「实际跑了哪几个阶段」，
    // 不要笼统写成 fetch-only —— 只跑 scan 也会被误标，验收时看状态会误判。
    const ran = Object.keys(rec.stages);
    if (rec.status === "started") rec.status = ran.length ? `partial(${ran.join("+")})` : "no-op";
  }

  rec.finishedAt = new Date().toISOString();
  report.regions[name] = rec;
  return rec;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg) return 0;

  const picked = cfg.regions
    ? cfg.regions.map((k) => {
        const r = REGIONS.find((x) => x.key === k);
        if (!r) throw new Error(`未知批次 ${k}；可用：${REGIONS.map((x) => x.key).join(",")}`);
        return r;
      })
    : REGIONS;

  const totalChunks = picked.reduce((a, r) => a + gridFor(r, cfg.target).cols * gridFor(r, cfg.target).rows, 0);

  console.log("=== 阶段38 全国分批流水线 ===");
  console.log(`批次     : ${picked.map((r) => r.label).join(" → ")}`);
  console.log(`阶段     : ${[...cfg.stages].join(",")}`);
  console.log(
    `类别     : ${cfg.categories.map((c) => `${c}（${CATEGORY_INFO[c].label}）`).join(" + ")}`,
  );
  console.log(`可选包   : ${cfg.packDir}/osm-<region>.pmtiles（不进安装包；该目录已被 .gitignore 忽略）`);
  console.log(`合计块数 : ${totalChunks}`);
  console.log(
    `串行预计 : ${((totalChunks * cfg.target.secPerChunk) / 3600).toFixed(1)} 小时 ` +
      `（按 ${cfg.target.secPerChunk} 秒/块估算，**不是上界**）`,
  );

  if (cfg.dryRun) {
    console.log("\n[dry-run] 将执行：");
    for (const r of picked) {
      const { cols, rows } = gridFor(r, cfg.target);
      const bboxStr = r.bbox.join(",");
      const s = scanSample(r, cfg.scanFactor, cfg.target);
      console.log(`\n— ${r.label} (${r.key})`);
      if (cfg.stages.has("scan"))
        console.log(`  ${PY} -u scripts/fetch_osm_power.py --bbox ${bboxStr} --grid ${cols}x${rows} --sample-step ${s.step} --name ${r.key} --count-only   # ${s.cells}/${cols * rows} 块`);
      if (cfg.stages.has("fetch"))
        for (const cat of cfg.categories) {
          const g = gridForCategory(r, cat, cfg.target);
          console.log(
            `  ${PY} -u scripts/fetch_osm_power.py --bbox ${bboxStr} --grid ${g.cols}x${g.rows} --name ${r.key} --category ${cat}` +
              `   # ${CATEGORY_INFO[cat].label}，${g.cols * g.rows} 块`,
          );
        }
      if (cfg.stages.has("prepare"))
        console.log(`  node scripts/prepare_osm_geojson.mjs --name ${r.key} --out-dir public/osm --out-name ${r.key}_power`);
      if (cfg.stages.has("build"))
        console.log(`  node scripts/build_pmtiles.mjs --name ${r.key} --in public/osm/${r.key}_power.geojson --out ${cfg.packDir}/osm-${r.key}.pmtiles`);
    }
    console.log("\n[dry-run] 未执行任何命令。");
    return 0;
  }

  const reportPath = join(ROOT, cfg.reportPath);
  const report = readJson(reportPath) ?? { generatedBy: "scripts/run_pipeline.mjs", regions: {} };
  // ⚠️ 之前只在这里赋一次 updatedAt，导致它永远停在**启动时刻**，
  //    而每批写入时并不刷新 —— 报表上就出现了一个「会撒谎的时间戳」：
  //    单看它无法判断进度是否在推进。现在它在每次落盘前刷新（见循环内）。
  report.startedAt = new Date().toISOString();
  report.targetCell = cfg.target;

  for (const region of picked) {
    try {
      const rec = await processRegion(region, cfg, report);
      // 每批结束立刻落盘：中途中断也不会丢掉已完成的批次记录
      report.updatedAt = new Date().toISOString();
      writeJsonAtomic(reportPath, report);
      if (rec.status !== "ok") console.warn(`⚠️ 批次 ${region.label} 状态：${rec.status}`);
    } catch (err) {
      console.error(`\n⛔ 批次 ${region.label} 异常终止：${err.message}`);
      report.regions[region.key] = { key: region.key, status: "error", error: String(err.message) };
      // ‼️ 异常也要落盘 —— 否则这一批的失败信息只存在于内存，
      //    下一批成功写盘时它就不在里面了，事后完全看不出哪批失败过。
      report.updatedAt = new Date().toISOString();
      writeJsonAtomic(reportPath, report);
    }
  }

  // ---- 汇总 ----
  console.log(`\n\n${"=".repeat(72)}\n=== 流水线汇总 ===\n${"=".repeat(72)}`);
  /** 阶段43：每类的失败块数括起来，任一类有空洞都能一眼看到 */
  const fetchSummary = (r) => {
    const f = r.stages?.fetch;
    if (!f) return "—";
    // 兼容阶段42 及以前的旧报表：那时 stages.fetch 是单对象而不是按类别分键
    if (typeof f.failedChunks !== "undefined") return f.failedChunks ?? "—";
    const vals = Object.values(f).filter((v) => v && typeof v === "object");
    if (!vals.length) return "—";
    return Object.entries(f)
      .map(([c, v]) => {
        if (!v || typeof v !== "object") return `${c}:?`;
        const fc = v.failedChunks ?? "?";
        // ‼️ 抓取进程**非零退出**时也必须显示出来。
        //    那种情况下 meta 往往根本没被写出，`failedChunks` 会取到**上一次**的旧值
        //    （实测：状态写着 fetch-incomplete，失败块却显示 `rail:0`，
        //     看起来像"一切正常"，会误导夜间监听）。
        const ex = v.exit && v.exit !== 0 ? `(exit${v.exit})` : "";
        return `${c}:${fc}${ex}`;
      })
      .join(" ");
  };
  const rows = Object.values(report.regions).map((r) => ({
    批次: r.label ?? r.key,
    状态: r.status,
    要素数: r.stages?.prepare?.featureCount ?? r.stages?.build?.features ?? "—",
    可选包MB: r.stages?.build?.packSizeMb ?? "—",
    最大瓦片KB: r.stages?.build?.widest?.rawKb ?? "—",
    封顶丢弃: r.stages?.build?.cappedDropped ?? "—",
    失败块: fetchSummary(r),
  }));
  console.table(rows);
  console.log(`报表：${cfg.reportPath}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
