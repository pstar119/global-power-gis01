/**
 * 校验被我误删后重建的 GeoJSON 是否与前端预期一致。
 *
 * 背景：清理时我用 `public/osm/*_power.geojson` 通配删除，把 `smoketest_power.geojson`
 * 也删了 —— 而它是 `MapPage.tsx` 的 `OSM_DATA_URL`（OSM 图层加载失败时的回退数据）。
 * 从 `data/osm/` 源文件重建后，必须验证结构与前端读取代码的预期一致，
 * 不能只看「文件存在」。
 *
 * 前端预期（见 prepare_osm_geojson.mjs 的 KEEP_PROPS 与 MapPage 的图层 filter）：
 *   - 顶层是 FeatureCollection
 *   - 每个要素 properties 至少有 ftype（line|substation|plant）与 vclass
 *   - vclass 取值必须是 735+ / 500-734 / 220-499 / <220 / unknown
 *   - 几何类型只能是 LineString / MultiLineString / Point
 *   - 坐标必须在合法经纬度范围内
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALID_FTYPE = new Set(["line", "substation", "plant"]);
const VALID_VCLASS = new Set(["735+", "500-734", "220-499", "<220", "unknown"]);
const VALID_GEOM = new Set(["LineString", "MultiLineString", "Point"]);

function check(rel) {
  const p = resolve(ROOT, rel);
  console.log(`\n=== ${rel} ===`);
  let fc;
  try {
    fc = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.log(`❌ 读取失败：${e.message}`);
    return false;
  }
  const problems = [];
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    console.log("❌ 顶层不是 FeatureCollection");
    return false;
  }
  const byType = {};
  const byClass = {};
  let badGeom = 0;
  let badCoord = 0;
  for (const f of fc.features) {
    const pr = f.properties ?? {};
    const ft = pr.ftype;
    const vc = pr.vclass;
    if (!VALID_FTYPE.has(ft)) problems.push(`非法 ftype: ${ft}`);
    if (!VALID_VCLASS.has(vc)) problems.push(`非法 vclass: ${vc}`);
    byType[ft] = (byType[ft] ?? 0) + 1;
    byClass[vc] = (byClass[vc] ?? 0) + 1;
    const g = f.geometry;
    if (!g || !VALID_GEOM.has(g.type)) {
      badGeom++;
      continue;
    }
    const pts = g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? g.coordinates : g.coordinates.flat();
    for (const c of pts) {
      if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) {
        badCoord++;
        break;
      }
    }
  }
  console.log(`要素总数 : ${fc.features.length.toLocaleString()}`);
  console.log(`体积     : ${(statSync(p).size / 1048576).toFixed(2)} MB`);
  console.log(`ftype    : ${JSON.stringify(byType)}`);
  console.log(`vclass   : ${JSON.stringify(byClass)}`);
  const ok = problems.length === 0 && badGeom === 0 && badCoord === 0 && fc.features.length > 0;
  if (problems.length) console.log(`❌ 属性问题 ${problems.length} 处，例如：${problems.slice(0, 3).join(" / ")}`);
  if (badGeom) console.log(`❌ 非法几何类型 ${badGeom} 个`);
  if (badCoord) console.log(`❌ 非法坐标 ${badCoord} 个`);
  console.log(ok ? "✅ 结构与前端预期完全一致" : "❌ 有问题，需检查");
  return ok;
}

let allOk = true;
for (const rel of ["public/osm/smoketest_power.geojson", "public/osm/core_power.geojson"]) {
  if (!check(rel)) allOk = false;
}
console.log(allOk ? "\n两项均通过。" : "\n有项未通过。");
process.exitCode = allOk ? 0 : 1;
