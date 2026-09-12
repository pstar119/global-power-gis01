#!/usr/bin/env node
/**
 * 生成一个"极小"的 PMTiles v3 测试夹具，供阶段 11「本地离线 PMTiles 预研」使用。
 *
 * 运行：node scripts/make_test_pmtiles.mjs
 * 产物：public/power-fixture.pmtiles
 *
 * === 关于 overzoom（踩过的坑） ===
 * 夹具的图案是「每个瓦片内一张 NxN 网格」，所以一个格子占世界的比例恒为 1/(N·2^Z)。
 * 放大到超过夹具最大级别后，MapLibre 会拉伸最高级瓦片；一旦视口小于一个格子，
 * 视口就整个落在格子内部 → 地图全空（看起来像坏了）。
 * 判定条件：2^(z_view - Z) > W_px·N/512 时变空。
 * 第一版 Z=2、N=3，实测放大 3 级就全空，就是这个原因。
 * 现在取 Z=3、N=4：在窄视口(~471px)下可撑到约 z4.9，
 * 在 Tauri 真实的宽视口(~1080px)下可撑到约 z6。
 *
 * === 为什么用 Node 而不是 Python ===
 * `pmtiles` 包（项目已装）导出了官方的 `zxyToTileId`（Hilbert 排序）与 `bytesToHeader`。
 * 直接复用它们，可以彻底消除"自己实现 Hilbert 曲线可能算错"这一风险，
 * 同时不需要引入任何新依赖（只是用已有包装配归档，不调用任何写入器——该包本来也没有）。
 *
 * === 内容声明 ===
 * 瓦片里的几何全部是程序生成的合成图形（十字线 / 方块 / 圆点），
 * **不含任何真实电力数据**，仅为打通"协议注册 → Range 读取 → 渲染"这条链路。
 *
 * === 格式依据 ===
 * 头部 127 字节布局与目录编码格式，均逐字段对照 `node_modules/pmtiles/src/index.ts`
 * 里的 `bytesToHeader` / `deserializeIndex` 实现确认，不是凭记忆写的。
 * 关键点：目录是「四段分开写」（tileId 增量 / runLength / length / offset），
 * 且 offset 存的是 `offset + 1`，0 表示"紧接上一项"。
 */

import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zxyToTileId, bytesToHeader, PMTiles } from "pmtiles";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "public", "power-fixture.pmtiles");

// ============================================================
// 1. protobuf 基础（只实现用得到的部分）
// ============================================================

/** 无符号 varint（用 BigInt 以免 32 位位移在超界时出错） */
function uvarint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/** MVT 几何参数用的 zigzag 编码 */
const zigzag = (n) => (n << 1) ^ (n >> 31);

const tag = (field, wire) => uvarint((BigInt(field) << 3n) | BigInt(wire));
const fieldVarint = (field, value) => [...tag(field, 0), ...uvarint(value)];
const fieldBytes = (field, bytes) => [
  ...tag(field, 2),
  ...uvarint(bytes.length),
  ...bytes,
];
const packed = (nums) => nums.flatMap((n) => uvarint(n));
const utf8 = (s) => Array.from(Buffer.from(s, "utf8"));

// ============================================================
// 2. MVT（Mapbox Vector Tile）编码
// ============================================================

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;
const command = (id, count) => (id & 0x7) | (count << 3);

const GEOM_POINT = 1;
const GEOM_LINESTRING = 2;
const GEOM_POLYGON = 3;

/** 点：单个 MoveTo，坐标相对 (0,0) */
const geomPoint = ([x, y]) => [command(CMD_MOVE_TO, 1), zigzag(x), zigzag(y)];

/**
 * 折线：MoveTo 首点 + LineTo 其余点。
 * 坐标增量是「相对上一个点」的，cursor 从 (0,0) 起算。
 */
function geomLine(coords) {
  const [x0, y0] = coords[0];
  const out = [command(CMD_MOVE_TO, 1), zigzag(x0), zigzag(y0)];
  let px = x0;
  let py = y0;
  out.push(command(CMD_LINE_TO, coords.length - 1));
  for (const [x, y] of coords.slice(1)) {
    out.push(zigzag(x - px), zigzag(y - py));
    px = x;
    py = y;
  }
  return out;
}

/** 多边形：折线 + ClosePath。ring 不要重复首点（闭合由 ClosePath 负责） */
const geomPolygon = (ring) => [...geomLine(ring), command(CMD_CLOSE_PATH, 1)];

/** 本夹具的要素不带任何属性（tags 为空），避免写入可能被误认成真实数据的字段 */
function feature({ type, geometry }) {
  return [
    ...fieldVarint(3, type),
    ...fieldBytes(4, packed(geometry)),
  ];
}

/** Layer 字段号：name=1, features=2, keys=3, values=4, extent=5, version=15 */
function layer({ name, features, extent = 4096 }) {
  const out = [...fieldBytes(1, utf8(name))];
  for (const f of features) out.push(...fieldBytes(2, f));
  out.push(...fieldVarint(5, extent));
  out.push(...fieldVarint(15, 2)); // version 必填，且必须是 2
  return out;
}

/** Tile 字段号：layers=3 */
function tile(layers) {
  const out = [];
  for (const l of layers) out.push(...fieldBytes(3, l));
  return Buffer.from(out);
}

// ============================================================
// 3. 合成几何（每个瓦片同一套图案，带一点与瓦片坐标相关的扰动，
//    这样缩放/平移时能肉眼确认瓦片确实换了）
// ============================================================

const EXTENT = 4096;
const at = (n) => Math.round(n * EXTENT);

/** 每个瓦片内的网格边长（见 buildTileLayers 的 overzoom 说明） */
const GRID_N = 4;

/** 方块环：**顺时针**（y 轴向下的屏幕坐标系），符合 MVT 规范 */
function square(cx, cy, half) {
  return [
    [at(cx - half), at(cy - half)],
    [at(cx + half), at(cy - half)],
    [at(cx + half), at(cy + half)],
    [at(cx - half), at(cy + half)],
  ];
}

/**
 * 每个瓦片内画一张合成"电网"：
 *   - power-lines : 把每一行、每一列的节点串成折线，形成网格
 *   - substations : 每个节点放一个方块
 *   - power-plants: 每个格子中心放一个圆点
 *
 * ⚠️ N 不能太小：N 越小，单个格子越大，放大后视口越容易落在格子内部而全空
 * （详见文件顶部的 overzoom 说明）。
 */
function buildTileLayers(z, x, y) {
  const N = GRID_N;
  const pos = (i) => (i + 0.5) / N;

  // 与瓦片坐标相关的确定性抖动，避免所有瓦片长得一模一样（方便肉眼确认瓦片换了）
  const jitter = (i, j) => (((i * 13 + j * 29 + x * 7 + y * 3 + z * 5) % 5) - 2) / 400;

  const nodes = [];
  for (let i = 0; i < N; i++) {
    nodes.push([]);
    for (let j = 0; j < N; j++) {
      nodes[i].push([at(pos(i) + jitter(i, j)), at(pos(j) + jitter(j, i))]);
    }
  }

  const powerLines = [];
  for (let i = 0; i < N; i++) {
    powerLines.push(
      feature({ type: GEOM_LINESTRING, geometry: geomLine(nodes[i]) }), // 第 i 行
      feature({ type: GEOM_LINESTRING, geometry: geomLine(nodes.map((row) => row[i])) }), // 第 i 列
    );
  }

  const substations = nodes
    .flat()
    .map(([nx, ny]) =>
      feature({ type: GEOM_POLYGON, geometry: geomPolygon(square(nx / EXTENT, ny / EXTENT, 0.026)) }),
    );

  const powerPlants = [];
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const cx = (pos(i) + pos(i + 1)) / 2;
      const cy = (pos(j) + pos(j + 1)) / 2;
      powerPlants.push(feature({ type: GEOM_POINT, geometry: geomPoint([at(cx), at(cy)]) }));
    }
  }

  return [
    layer({ name: "power-lines", features: powerLines }),
    layer({ name: "substations", features: substations }),
    layer({ name: "power-plants", features: powerPlants }),
  ];
}

// ============================================================
// 3.5 MVT 反解（仅用于自校验）
//     只实现读回自己写的东西所必需的部分。有了它，图层名 / 要素数 / 几何类型
//     都能在生成阶段被确定性验证，而不必依赖"去浏览器里看一眼"。
// ============================================================

function makeReader(bytes) {
  let pos = 0;
  return {
    eof: () => pos >= bytes.length,
    varint() {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        const b = bytes[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      return Number(result);
    },
    take(n) {
      const s = bytes.subarray(pos, pos + n);
      pos += n;
      return s;
    },
    skip(wire) {
      if (wire === 0) this.varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) {
        // ⚠️ 千万不要写成 `pos += this.varint()`：复合赋值会**先读 pos 的旧值**，
        // 而 this.varint() 内部又会 pos++，于是读长度自身占用的那 1 字节被丢掉，
        // 解析器在后续字段上静默错位（官方解码器用两条独立语句就是为了避开这个坑）。
        const n = this.varint();
        pos += n;
      } else if (wire === 5) pos += 4;
      else {
        const lo = Math.max(0, pos - 8);
        const ctx = [...bytes.subarray(lo, pos + 4)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        throw new Error(`不支持的 wire type: ${wire} (pos=${pos}/${bytes.length}, 上下文=[${ctx}])`);
      }
    },
  };
}

function decodeFeature(bytes) {
  const r = makeReader(bytes);
  const out = { type: null };
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 3 && wire === 0) out.type = r.varint(); // GeomType
    else r.skip(wire); // tags=2 / geometry=4 都是 packed，跳过即可
  }
  return out;
}

function decodeLayer(bytes) {
  const r = makeReader(bytes);
  const out = { name: "", version: 0, extent: 0, featureCount: 0, geomTypes: new Set() };
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const n = r.varint();
      out.name = Buffer.from(r.take(n)).toString("utf8");
    } else if (field === 2 && wire === 2) {
      const n = r.varint();
      const f = decodeFeature(r.take(n));
      out.featureCount++;
      out.geomTypes.add(f.type);
    } else if (field === 5 && wire === 0) {
      out.extent = r.varint();
    } else if (field === 15 && wire === 0) {
      out.version = r.varint();
    } else {
      r.skip(wire);
    }
  }
  return out;
}

function decodeMvt(buf) {
  const r = makeReader(new Uint8Array(buf));
  const layers = [];
  while (!r.eof()) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 3 && wire === 2) {
      const n = r.varint();
      layers.push(decodeLayer(r.take(n)));
    } else {
      r.skip(wire);
    }
  }
  return layers;
}

const GEOM_TYPE_NAME = { 1: "Point", 2: "LineString", 3: "Polygon" };

// ============================================================
// 4. PMTiles v3 容器组装
// ============================================================

/**
 * 目录序列化。
 * 格式（对照 deserializeIndex 实现）：varint 条目数 → N×varint tileId 增量
 * → N×varint runLength → N×varint length → N×varint offset(+1，0 表示连续)
 */
function serializeDirectory(entries) {
  const out = [...uvarint(entries.length)];

  let lastId = 0;
  for (const e of entries) {
    out.push(...uvarint(e.tileId - lastId));
    lastId = e.tileId;
  }
  for (const e of entries) out.push(...uvarint(e.runLength));
  for (const e of entries) out.push(...uvarint(e.length));

  let prev = null;
  for (const e of entries) {
    const contiguous = prev && e.offset === prev.offset + prev.length;
    out.push(...uvarint(contiguous ? 0 : e.offset + 1));
    prev = e;
  }

  return Buffer.from(out);
}

const HEADER_LEN = 127;

function buildArchive({ tiles, metadata, minZoom, maxZoom, bounds, center }) {
  // 按 tileId（Hilbert 序）排序，保证 clustered = 1
  const sorted = [...tiles.entries()].sort((a, b) => a[0] - b[0]);

  const chunks = [];
  const entries = [];
  let offset = 0;
  for (const [tileId, buf] of sorted) {
    entries.push({ tileId, offset, length: buf.length, runLength: 1 });
    chunks.push(buf);
    offset += buf.length;
  }
  const tileData = Buffer.concat(chunks);
  const rootDir = gzipSync(serializeDirectory(entries));
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata), "utf8"));

  const rootOffset = HEADER_LEN;
  const metaOffset = rootOffset + rootDir.length;
  const leafOffset = metaOffset + meta.length; // 无叶子目录（条目少，全部放根目录）
  const tileDataOffset = leafOffset;

  const h = Buffer.alloc(HEADER_LEN);
  h.write("PMTiles", 0, "latin1");
  h.writeUInt8(3, 7); // spec version

  const u64 = (v, o) => h.writeBigUInt64LE(BigInt(v), o);
  u64(rootOffset, 8);
  u64(rootDir.length, 16);
  u64(metaOffset, 24);
  u64(meta.length, 32);
  u64(leafOffset, 40);
  u64(0, 48); // 叶子目录长度
  u64(tileDataOffset, 56);
  u64(tileData.length, 64);
  u64(entries.length, 72); // numAddressedTiles
  u64(entries.length, 80); // numTileEntries
  u64(entries.length, 88); // numTileContents

  h.writeUInt8(1, 96); // clustered
  h.writeUInt8(2, 97); // internalCompression = gzip
  h.writeUInt8(2, 98); // tileCompression   = gzip
  h.writeUInt8(1, 99); // tileType          = mvt

  h.writeUInt8(minZoom, 100);
  h.writeUInt8(maxZoom, 101);
  h.writeInt32LE(Math.round(bounds.minLon * 1e7), 102);
  h.writeInt32LE(Math.round(bounds.minLat * 1e7), 106);
  h.writeInt32LE(Math.round(bounds.maxLon * 1e7), 110);
  h.writeInt32LE(Math.round(bounds.maxLat * 1e7), 114);
  h.writeUInt8(center.zoom, 118);
  h.writeInt32LE(Math.round(center.lon * 1e7), 119);
  h.writeInt32LE(Math.round(center.lat * 1e7), 123);

  return Buffer.concat([h, rootDir, meta, tileData]);
}

// ============================================================
// 5. 生成 + 用官方解码器回读自校验
// ============================================================

const MIN_ZOOM = 0;
const MAX_ZOOM = 3;

/** 让 Node 侧也能用 pmtiles 的 PMTiles 类读取内存里的归档 */
class BufferSource {
  constructor(buf, key) {
    this.buf = buf;
    this.key = key;
  }
  async getBytes(offset, length) {
    const start = this.buf.byteOffset + offset;
    const end = Math.min(start + length, this.buf.byteOffset + this.buf.length);
    return { data: this.buf.buffer.slice(start, end) };
  }
  getKey() {
    return this.key;
  }
}

function fail(msg) {
  // ⚠️ 不能在这里用 process.exit()：stdout 管道有缓冲，强制退出会把还没 flush
  // 的 console.log 全部丢掉，导致看到的诊断信息其实是“截断后的”，很容易误判。
  console.error(`\n❌ 自校验失败：${msg}`);
  process.exitCode = 1;
  throw new Error("__SELFCHECK_FAILED__");
}

async function main() {
  const tiles = new Map();
  const expected = [];

  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const side = 1 << z;
    for (let x = 0; x < side; x++) {
      for (let y = 0; y < side; y++) {
        const mvt = tile(buildTileLayers(z, x, y));
        tiles.set(zxyToTileId(z, x, y), gzipSync(mvt));
        expected.push({ z, x, y, mvt });
      }
    }
  }

  const archive = buildArchive({
    tiles,
    metadata: {
      name: "power-fixture",
      description: "程序生成的合成测试数据，不含任何真实电力数据",
      attribution: "合成测试数据（非真实电力数据）",
    },
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    bounds: { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 },
    center: { zoom: 1, lon: 0, lat: 20 },
  });

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, archive);

  // ---- 回读自校验 ----
  const header = bytesToHeader(
    archive.buffer.slice(archive.byteOffset, archive.byteOffset + HEADER_LEN),
  );
  if (header.specVersion !== 3) fail(`specVersion = ${header.specVersion}，期望 3`);
  if (header.numTileEntries !== expected.length) {
    fail(`numTileEntries = ${header.numTileEntries}，期望 ${expected.length}`);
  }
  if (header.tileType !== 1) fail(`tileType = ${header.tileType}，期望 1 (mvt)`);
  if (header.internalCompression !== 2 || header.tileCompression !== 2) {
    fail("压缩类型不是 gzip");
  }
  if (header.rootDirectoryOffset !== HEADER_LEN) fail("rootDirectoryOffset 不是 127");
  if (header.leafDirectoryLength !== 0) fail("叶子目录长度应为 0");

  const pm = new PMTiles(new BufferSource(archive, "fixture://selftest"));

  // ⚠️ 官方解码器会把 gzip 存储的瓦片**解压后**返回，所以比对基准必须是未压缩的 MVT。
  // （能成功解压这件事本身，就证明了头里的 tileCompression=gzip 标记是对的。）
  let verified = 0;
  for (const { z, x, y, mvt } of expected) {
    const resp = await pm.getZxy(z, x, y);
    if (!resp) fail(`官方解码器读不到 z${z}/${x}/${y}`);
    const got = Buffer.from(resp.data);
    if (!got.equals(mvt)) {
      fail(
        `z${z}/${x}/${y} 字节不一致：` +
          `写入 ${mvt.length} 字节 [${mvt.subarray(0, 10).toString("hex")}]，` +
          `读出 ${got.length} 字节 [${got.subarray(0, 10).toString("hex")}]`,
      );
    }
    verified++;
  }

  // 不存在的瓦片必须返回 undefined（证明 findTile 真的在查目录）
  const missing = await pm.getZxy(MAX_ZOOM + 1, 0, 0);
  if (missing) fail(`z${MAX_ZOOM + 1}/0/0 本不该存在，却读到了数据`);

  // ---- MVT 语义自校验：证明写出的矢量瓦片真的能被解析 ----
  const N = GRID_N;
  const expectedLayers = [
    { name: "power-lines", features: 2 * N, geom: "LineString" },
    { name: "substations", features: N * N, geom: "Polygon" },
    { name: "power-plants", features: (N - 1) * (N - 1), geom: "Point" },
  ];

  const decoded = decodeMvt(expected[0].mvt);
  if (decoded.length !== expectedLayers.length) {
    fail(`解出 ${decoded.length} 个图层，期望 ${expectedLayers.length}`);
  }
  for (let i = 0; i < expectedLayers.length; i++) {
    const want = expectedLayers[i];
    const got = decoded[i];
    if (got.name !== want.name) fail(`图层 ${i} 名称为 ${got.name}，期望 ${want.name}`);
    if (got.version !== 2) fail(`图层 ${want.name} 的 version=${got.version}，期望 2`);
    if (got.extent !== EXTENT) fail(`图层 ${want.name} 的 extent=${got.extent}，期望 ${EXTENT}`);
    if (got.featureCount !== want.features) {
      fail(`图层 ${want.name} 有 ${got.featureCount} 个要素，期望 ${want.features}`);
    }
    const types = [...got.geomTypes].map((t) => GEOM_TYPE_NAME[t] ?? t);
    if (types.length !== 1 || types[0] !== want.geom) {
      fail(`图层 ${want.name} 的几何类型为 ${types}，期望只有 ${want.geom}`);
    }
  }

  const size = statSync(OUT_PATH).size;
  console.log("✅ PMTiles 夹具已生成并通过官方解码器自校验");
  console.log(`   路径      : ${OUT_PATH.replace(ROOT, ".")}`);
  console.log(`   体积      : ${size} 字节`);
  console.log(`   缩放      : z${header.minZoom}~z${header.maxZoom}`);
  console.log(`   瓦片      : ${verified} 个（已逐字节比对）`);
  console.log(`   缺失瓦片  : 正确返回 undefined`);
  console.log(`   tileType  : ${header.tileType} (mvt)  压缩: gzip  聚类: ${header.clustered}`);
  console.log("   图层（已解析验证）：");
  for (const l of decoded) {
    const types = [...l.geomTypes].map((t) => GEOM_TYPE_NAME[t] ?? t).join(",");
    console.log(
      `     - ${l.name.padEnd(14)} v${l.version}  extent ${l.extent}  ` +
        `${l.featureCount} 个要素  ${types}`,
    );
  }
}

main().catch((e) => {
  if (e && e.message === "__SELFCHECK_FAILED__") return; // 上面已经打印过了
  console.error(e);
  process.exitCode = 1;
});
