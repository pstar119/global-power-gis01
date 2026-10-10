/**
 * 阶段56-A1：断言"只有电力"。
 *
 * 为什么必须是脚本而不是肉眼：本次要删掉两类已发布数据（铁路、油气管道），
 * 而"删干净了没有"有两个易漏点 —— ① prepare 的合并表、② 切片的图层/属性白名单。
 * 只看一处会留下一半，且**不会报错**（图层里没有要素，只是什么都不画）。
 *
 * 检查职责（**不要过度声称**）：
 *   · `<file>.geojson` —— 权威内容检查：无 railway/pipeline 的 ftype + 电力属性齐备
 *   · `<file>.pmtiles` —— 结构检查：可读回、非空、含预期 MVT 图层名 `grid`
 *     （归档内所有 ftype 同在 `grid` 一层，图层名抓不到铁路/管道；内容由 GeoJSON 门禁保证）
 *
 * 用法：node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>
 * 退出码：0 = 通过；1 = 发现问题；2 = 用法错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyArchive, tileX, tileY, zxyToTileId } from "./lib/pmtiles-writer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_FTYPES = ["railway", "pipeline"];
/**
 * 线路必须出现的字段。
 *
 * 阶段56-A2 新增两项：
 *   · `is_dc` —— prepare 的三步判定结果，**每条线路都有**（true/false 都写），必须齐备；
 *   · `frequency` —— 只在补抓跑过、且该区域确有频率标签时才会出现（实测全国覆盖 ~11%）。
 *     ‼️ 所以它是否进入必查清单**取决于同区域的 `dc_tags` 产物是否存在且非空** ——
 *     写死会让"没跑补抓"与"跑了但这条真没有"两种情况的症状混在一起（假失败）。
 */
const EXPECTED_LINE_PROPS = [
  "osm_id",
  "name",
  "ref",
  "operator",
  "vclass",
  "voltage_kv",
  "line_kind",
  "circuits",
  "cables",
  "wires",
  "is_dc",
];
const DC_DEPENDENT_PROPS = ["frequency"];

/**
 * 阶段56-C：**逐 ftype** 的专属属性必查表。
 *
 * 🔴 为什么必须按 ftype 分开（这是本脚本原来的一个真 bug）：
 *    原先只有一份 `EXPECTED_LINE_PROPS`，而它是**逐要素无条件**统计的 ——
 *    于是校验一个只含 `plant_area` 的中间产物
 *    （`data/osm/<r>_power_plant_areas.geojson`，T1 的交付物）时，
 *    脚本会要求它带 `line_kind` / `circuits` / `is_dc` 等**线路专有**字段，
 *    结果是 `verdict: FAIL`。而计划 T1 Step 5 明确期望这条命令 PASS ⇒
 *    这个 FAIL 是**假失败**（文件本身是对的，是判据用错了表）。
 *    ⇒ 改成：**该 ftype 在文件里出现过，才校验它那套字段**。
 *
 * ⚠️ 不要退化成"把 plant_area 的字段并进线路表"：那会让线路文件因为缺
 *    `area_ha` 而失败，把假失败从一类搬到另一类。
 */
const EXPECTED_PROPS_BY_FTYPE = {
  line: EXPECTED_LINE_PROPS,
  // ‼️ 抓取中间产物（`data/osm/*_power_lines.geojson`）里**没有** `is_dc` / `frequency`：
  //    `is_dc` 是 prepare 依设计 §4.1 的三步判定算出来的，`frequency` 靠 dc_tags 贴回，
  //    两者都属 prepare 阶段。拿 prepare 的表去卡中间产物会得到 `line:缺is_dc` 假失败
  //    （实测）。这里只列**抓取阶段就写进 GeoJSON** 的键。
  line_raw: ["osm_id", "power", "line_kind"],
  substation: ["osm_id", "vclass", "substation_kind"],
  plant: ["osm_id", "vclass", "plant_source"],
  converter: ["osm_id", "vclass"],
  // 阶段56-C 新增：面状电厂。
  // ‼️ 两类产物的属性表**不同**，所以按"这一份是哪种"分成两个集合：
  //    · 抓取中间产物（无 `ftype`，`data/osm/*_power_plant_areas.geojson`）
  //      —— 有 `power`（原始 OSM 标签），**没有** `area_ha`（prepare 才现算）；
  //    · prepare 产物（有 `ftype`，`public/osm/*_power.geojson`）
  //      —— prepare 的 KEEP_PROPS 收窄了字段，只留 `osm_id/name/vclass/voltage_kv/`
  //        `plant_source/landuse/source_url/area_ha`（`power` 不在其中）。
  //    用一份表去卡两种文件必然产生假失败（两种方向都实测到了）。
  // `landuse` / `source_url` 是可选 OSM 标签（实测覆盖 7.6% / 5.4%），钉死必假失败，
  // 它们的存在性由 `verify_pack.mjs` 的"至少命中一个"那条断言兜。
  plant_area: ["osm_id", "vclass", "area_ha"],
  plant_area_raw: ["osm_id", "power"],
};

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/verify_power_only.mjs <file.pmtiles|file.geojson>");
  process.exitCode = 2;
} else {
  const ext = extname(path).toLowerCase();
  const ftypes = new Map();
  /**
   * `frequency` 是否列入必查 —— 依据是**同区域的 dc_tags 产物存在且非空**（A2 的补抓跑过没有）。
   * 名字从文件名推：`<name>_power.geojson` / `osm-<name>.pmtiles`；核心区归档 `osm_grid.pmtiles`
   * 对应的名字是 `core`（它的 dc_tags 由 `merge_osm_regions.mjs` 合并产出）。
   */
  const stem = basename(path).replace(/\.(geojson|pmtiles)$/i, "");
  const dcName = stem === "osm_grid" ? "core" : stem.replace(/^osm-/, "").replace(/_power$/, "");
  const dcPath = resolve(ROOT, "data", "osm", `${dcName}_dc_tags.json`);
  let dcSource = false;
  try {
    dcSource = existsSync(dcPath) && (JSON.parse(readFileSync(dcPath, "utf8")).count ?? 0) > 0;
  } catch {
    dcSource = false;
  }
  const propHits = new Map(
    [...EXPECTED_LINE_PROPS, ...(dcSource ? DC_DEPENDENT_PROPS : [])].map((k) => [k, 0]),
  );
  let lineTotal = 0;
  let pass = false;
  let extra = "";

  // 阶段56-C：**抓取中间产物没有 `ftype` 字段**（`ftype` 是 prepare 阶段才写进去的）。
  // 所以对 `data/osm/<r>_power_<kind>.geojson` 这类文件必须**按文件名推出 ftype**，
  // 否则 per-ftype 必查表会落在 `(none)` 上、整条检查形同虚设（本次实测就是这样：
  // `ftypes in file: (none)=5077`，看着 PASS 其实什么都没查）。
  // ⚠️ 只认已知的桶名；推不出来就退回"(none)"（不猜）。
  const stemParts = basename(path).replace(/\.geojson$/i, "").replace(/^.*?_power_/, "");
  const inferredFtype = ["plant_areas", "plants", "substations", "lines", "converters"].includes(stemParts)
    ? { plant_areas: "plant_area", plants: "plant", substations: "substation", lines: "line", converters: "converter" }[stemParts]
    : null;
  /**
   * 这份文件是不是**抓取中间产物**（推得出 ftype、且要素自己没有 `ftype` 属性）。
   * ⚠️ 必须在循环外算：循环后的缺失判定也要用它（否则会拿 prepare 的表去卡中间产物）。
   */
  let rawIntermediate = false;

  if (ext === ".geojson") {
    const fc = JSON.parse(readFileSync(path, "utf8"));
    /**
     * 阶段56-C：按 ftype 分别统计必查字段。
     * `keysByType` 记录**出现过**的 ftype 及其字段命中数；收尾时只对出现过的 ftype 判定，
     * 这样「只含面要素的中间产物」不会再被线路字段判成失败。
     */
    const keysByType = new Map();
    for (const f of fc.features ?? []) {
      const p = f.properties ?? {};
      // 中间产物没有 ftype ⇒ 用文件名推断（见 inferredFtype）
      if (p.ftype === undefined && inferredFtype !== null) rawIntermediate = true;
      const t = p.ftype ?? inferredFtype ?? "(none)";
      ftypes.set(t, (ftypes.get(t) ?? 0) + 1);
      if (t === "line") {
        lineTotal++;
        // ‼️ 中间产物按 `line_raw` 表判（它没有 is_dc / frequency），
        //    prepare 产物才按完整的线路表判 —— 否则中间产物必报"缺 is_dc"假失败。
        const lineKeys = rawIntermediate ? EXPECTED_PROPS_BY_FTYPE.line_raw : EXPECTED_LINE_PROPS;
        for (const k of lineKeys) if (p[k] !== undefined) propHits.set(k, (propHits.get(k) ?? 0) + 1);
        if (!rawIntermediate) {
          for (const k of DC_DEPENDENT_PROPS) if (p[k] !== undefined) propHits.set(k, propHits.get(k) + 1);
        }
      }
      const wantedKey =
        rawIntermediate && (t === "plant_area" || t === "line") ? `${t}_raw` : t;
      const wanted = EXPECTED_PROPS_BY_FTYPE[wantedKey];
      if (!wanted) continue;
      // 用 wantedKey 做分组键，避免"中间产物"与"prepare 产物"的命中数混在一起算
      if (!keysByType.has(wantedKey)) keysByType.set(wantedKey, new Map(wanted.map((k) => [k, 0])));
      const hits = keysByType.get(wantedKey);
      for (const k of wanted) if (p[k] !== undefined && p[k] !== null) hits.set(k, hits.get(k) + 1);
    }
    const bad = [...ftypes.keys()].filter((k) => FORBIDDEN_FTYPES.includes(k));

    /**
     * 缺失判定分两路：
     *   · 文件里**有线路**时，仍按原来的（更严的）线路字段表判定 —— 归档门禁语义不变；
     *   · 同时按实际出现过的**每个 ftype** 各判一次它的专属字段。
     */
    const missing = [];
    if (lineTotal > 0) {
      // 只对**本次实际使用的**那套线路字段表判定（中间产物 vs prepare 产物，见上）
      const usedLineKeys = rawIntermediate ? EXPECTED_PROPS_BY_FTYPE.line_raw : [...EXPECTED_LINE_PROPS, ...(dcSource ? DC_DEPENDENT_PROPS : [])];
      for (const k of usedLineKeys) if ((propHits.get(k) ?? 0) === 0) missing.push(k);
    }
    const perType = [];
    for (const [t, hits] of keysByType) {
      const miss = [...hits.entries()].filter(([, v]) => v === 0).map(([k]) => k);
      perType.push(`${t}:${miss.length ? `缺${miss.join("|")}` : "齐"}`);
      for (const k of miss) missing.push(`${t}.${k}`);
    }

    console.log(`forbidden ftypes: ${bad.length ? bad.join(", ") : "(none)"}`);
    console.log(`ftypes in file: ${[...ftypes.entries()].map(([t, n]) => `${t}=${n}`).join(" ") || "(空)"}`);
    console.log(
      `prop coverage: lines=${lineTotal} missing=${missing.length ? missing.join(",") : "(none)"}` +
        `${dcSource ? "" : `（frequency 未列入必查：找不到 ${dcPath}）`}`,
    );
    console.log(`per-ftype: ${perType.join("  ") || "(无)"}`);
    pass = bad.length === 0 && missing.length === 0;
  } else if (ext === ".pmtiles") {
    // 从归档 bbox 推 z6/z8 的若干 tileId 抽样；verifyArchive 内部用 MemorySource，Node 下可用
    const headerBuf = readFileSync(path).subarray(0, 127);
    const minLon = headerBuf.readInt32LE(102) / 1e7;
    const minLat = headerBuf.readInt32LE(106) / 1e7;
    const maxLon = headerBuf.readInt32LE(110) / 1e7;
    const maxLat = headerBuf.readInt32LE(114) / 1e7;
    const sampleIds = [];
    for (const z of [6, 8]) {
      for (let x = tileX(minLon, z); x <= tileX(maxLon, z) && sampleIds.length < 40; x += 2) {
        for (let y = tileY(maxLat, z); y <= tileY(minLat, z) && sampleIds.length < 40; y += 2) {
          sampleIds.push(zxyToTileId(z, x, y));
        }
      }
    }
    const r = await verifyArchive(path, { sampleIds, layerNames: ["grid"] });
    const withGrid = r.checked.filter((c) => c.layers.includes("grid")).length;
    console.log(`forbidden ftypes: (n/a for archive — 内容由对应的 geojson 检查)`);
    console.log(
      `archive: readback ok=${r.ok} missing=${r.missing} gridTiles=${withGrid} z${r.header.minZoom}-${r.header.maxZoom}`,
    );
    pass = r.ok > 0 && withGrid > 0;
    extra = "（归档结论以结构可读 + 含 grid 层为准）";
  } else {
    console.error(`不支持的扩展名: ${ext}`);
    process.exitCode = 2;
  }

  if (!process.exitCode) {
    console.log(`verdict: ${pass ? "PASS" : "FAIL"}${extra}`);
    if (!pass) process.exitCode = 1;
  }
}
