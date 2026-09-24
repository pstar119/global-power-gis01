/**
 * `merge-lines.mjs` 的单元测试（`node --test`，零依赖）。
 *
 * 重点覆盖**不该合并**的情形 —— 合并过头会静默把两条电气无关的线连成一条，
 * 而那种错误在渲染上看不出来（线还是线），只有断言能守住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { lengthKm, mergeLines } from "./merge-lines.mjs";

const line = (id, coords, props = {}) => ({
  type: "Feature",
  properties: { osm_id: id, ftype: "line", line_kind: "line", voltage_kv: 500, ...props },
  geometry: { type: "LineString", coordinates: coords },
});

test("共用一个端点（度数=2）的两段合并为一条", () => {
  const { features, stats } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]]),
    line("way/2", [[0.01, 0], [0.02, 0]]),
  ]);
  assert.equal(features.length, 1);
  assert.equal(stats.output, 1);
  assert.equal(stats.maxChain, 2);
  assert.equal(features[0].properties.merged_count, 2);
  assert.equal(features[0].properties.osm_ids, "way/1,way/2");
  assert.equal(features[0].geometry.coordinates.length, 3, "共享端点不应重复出现");
  assert.ok(features[0].properties.length_km > 2 && features[0].properties.length_km < 2.3);
});

test("度数=3 的接点不跨越（三岔点必须断开）", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]]),
    line("way/2", [[0.01, 0], [0.02, 0]]),
    line("way/3", [[0.01, 0], [0.01, 0.01]]),
  ]);
  assert.equal(features.length, 3, "三岔点上三条都各自成链");
  for (const f of features) assert.equal(f.properties.merged_count, 1);
});

test("电压不同不合并", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]], { voltage_kv: 500 }),
    line("way/2", [[0.01, 0], [0.02, 0]], { voltage_kv: 220 }),
  ]);
  assert.equal(features.length, 2);
});

test("双方都有 ref 且不同则不合并（避免把两条不同线路接起来）", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]], { ref: "A线" }),
    line("way/2", [[0.01, 0], [0.02, 0]], { ref: "B线" }),
  ]);
  assert.equal(features.length, 2);
});

test("一方 ref 为空则兼容，并取有值的一方", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]], { ref: null }),
    line("way/2", [[0.01, 0], [0.02, 0]], { ref: "A线" }),
  ]);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.ref, "A线");
});

test("line_kind 不同不合并（line 不与 cable 混）", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]], { line_kind: "line" }),
    line("way/2", [[0.01, 0], [0.02, 0]], { line_kind: "cable" }),
  ]);
  assert.equal(features.length, 2);
});

test("闭合环不会与自己相连（自连会让 merged_count 变成环的段数）", () => {
  const ring = line("way/ring", [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0]]);
  const { features } = mergeLines([ring]);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.merged_count, 1, "环的 start==end，不得自连");
  assert.deepEqual(features[0].geometry.coordinates[0], features[0].geometry.coordinates.at(-1));
});

test("孤立段原样通过，但仍带上 merged_count 与 length_km", () => {
  const { features } = mergeLines([line("way/1", [[0, 0], [0.01, 0]])]);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.merged_count, 1);
  assert.ok(features[0].properties.length_km > 1);
});

test("方向相反的段也能正确接上（第二条要反转）", () => {
  const { features } = mergeLines([
    line("way/1", [[0, 0], [0.01, 0]]),
    line("way/2", [[0.02, 0], [0.01, 0]]), // 反向：末端才是接点
  ]);
  assert.equal(features.length, 1);
  const c = features[0].geometry.coordinates;
  assert.deepEqual(c[0], [0, 0]);
  assert.deepEqual(c.at(-1), [0.02, 0]);
});

test("合并前后总长度守恒（<0.1%，设计文档的验收口径）", () => {
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push(line(`way/${i}`, [[i * 0.01, 0], [(i + 1) * 0.01, 0]]));
  const { features, stats } = mergeLines(segs);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.merged_count, 20);
  const diff = Math.abs(stats.lengthAfterKm - stats.lengthBeforeKm) / stats.lengthBeforeKm;
  assert.ok(diff < 0.001, `长度差 ${diff} 应 < 0.1%`);
});

test("lengthKm 对已知距离给出合理值（赤道 0.01° ≈ 1.11 km）", () => {
  const d = lengthKm([[0, 0], [0.01, 0]]);
  assert.ok(Math.abs(d - 1.113) < 0.01, `实测 ${d}`);
});
