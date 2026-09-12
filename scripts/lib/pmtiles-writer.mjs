/**
 * PMTiles v3 归档写入器（共享模块）
 * ============================================================
 * 这段代码最初写在 `scripts/fetch_basemap.mjs` 里（阶段26），
 * 产出的 1107 瓦片 / 31.76 MB 底图归档被官方 `pmtiles` 包读回校验通过，
 * 也真的被 MapLibre 通过 HTTP Range 正常读取过。
 * 阶段29 需要写第二份归档（OSM 电网），所以把它抽出来共用 ——
 * **二进制格式代码绝不能有两份拷贝**，否则迟早分叉。
 *
 * 说明：这是「复用已有、已验证的写入器」，MVT 本身仍然由 `vt-pbf` 编码，
 *      本模块只负责容器（header + 目录 + 拼接）。
 *
 * ============================================================
 * 格式依据
 * ============================================================
 * 头部 127 字节的字段偏移、目录的四段式编码、叶子目录的判定方式，
 * 均逐字段对照 `node_modules/pmtiles/src/index.ts` 的
 * `bytesToHeader` / `deserializeIndex` / `findTile` / `getZxyAttempt` 确认，不是凭记忆写的。
 * 关键点：
 *   - 目录编码 = varint 条目数 → N×varint(tileId 增量) → N×varint(runLength)
 *     → N×varint(length) → N×varint(offset+1，0 表示「紧接上一项」)；
 *   - **叶子目录条目用 `runLength = 0` 标识**，其 `offset` 相对 `leafDirectoryOffset`，
 *     `length` 是该叶子目录的长度；
 *   - 瓦片正文的 `offset` 相对 `tileDataOffset`。
 *
 * ⚠️ 根目录有 16 KB 的硬上限（压缩后）。条目上万时必须切成叶子目录，
 *    否则 MapLibre 读目录会失败 —— 阶段 11 的夹具条目很少所以没做这一层。
 */

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { tileIdToZxy, zxyToTileId } from "pmtiles";

export { tileIdToZxy, zxyToTileId };

/** 头部固定 127 字节 */
export const HEADER_LEN = 127;
/** 根目录压缩后的硬上限 */
export const MAX_ROOT_DIR = 16384;

/** PMTiles v3 的 Compression 枚举 */
export const COMPRESSION = { Unknown: 0, None: 1, Gzip: 2, Brotli: 3, Zstd: 4 };
/** PMTiles v3 的 TileType 枚举 */
export const TILE_TYPE = { Unknown: 0, Mvt: 1, Png: 2, Jpeg: 3, Webp: 4, Avif: 5, Mlt: 6 };

// ============================================================
// 瓦片坐标工具
// ============================================================

export const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);

export function tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/**
 * 枚举 bbox 在 [minZoom, maxZoom] 内覆盖到的所有瓦片 ID（Hilbert 序）。
 * 返回 Map<z, tileId[]>，方便按层统计与限流。
 */
export function enumerateBboxTiles({ bbox, minZoom, maxZoom }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const perZoom = new Map();
  const all = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));
    const x0 = clamp(tileX(minLon, z));
    const x1 = clamp(tileX(maxLon, z));
    const y0 = clamp(tileY(maxLat, z));
    const y1 = clamp(tileY(minLat, z));
    const list = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) list.push(zxyToTileId(z, x, y));
    }
    list.sort((a, b) => a - b);
    perZoom.set(z, list);
    all.push(...list);
  }
  return { ids: [...new Set(all)].sort((a, b) => a - b), perZoom };
}

// ============================================================
// 目录序列化
// ============================================================

export function uvarint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

export function serializeDirectory(entries) {
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

// ============================================================
// 组装归档
// ============================================================

/**
 * @param {object} o
 * @param {Map<number, Buffer>} o.tiles  tileId → 已按 tileCompression 压好的瓦片字节
 * @param {Buffer} o.metadataBuf         元数据 JSON（内部会按 internalCompression 压）
 * @param {number} o.tileType            1 = MVT
 * @param {number} o.tileCompression     瓦片正文的压缩方式（2 = gzip）
 * @param {[number,number,number,number]} o.bounds [w, s, e, n]
 * @param {[number,number,number]} o.center [zoom, lon, lat]
 * @param {number} o.minZoom
 * @param {number} o.maxZoom
 */
export function buildArchive({
  tiles,
  metadataBuf,
  tileType = TILE_TYPE.Mvt,
  tileCompression = COMPRESSION.Gzip,
  internalCompression = COMPRESSION.Gzip,
  bounds,
  center,
  minZoom,
  maxZoom,
}) {
  const sorted = [...tiles.entries()].sort((a, b) => a[0] - b[0]);

  const chunks = [];
  const tileEntries = [];
  let offset = 0;
  for (const [tileId, buf] of sorted) {
    tileEntries.push({ tileId, offset, length: buf.length, runLength: 1 });
    chunks.push(buf);
    offset += buf.length;
  }
  const tileData = Buffer.concat(chunks);
  const meta = gzipSync(metadataBuf);

  // ---- 目录：先试单层根目录，超过 16 KB 就切叶子 ----
  let rootEntries = tileEntries;
  let leafBlobs = [];
  let rootDir = gzipSync(serializeDirectory(tileEntries));

  if (rootDir.length > MAX_ROOT_DIR) {
    const LEAF_ENTRIES = 4096;
    leafBlobs = [];
    rootEntries = [];
    let leafOffset = 0;
    for (let i = 0; i < tileEntries.length; i += LEAF_ENTRIES) {
      const group = tileEntries.slice(i, i + LEAF_ENTRIES);
      const blob = gzipSync(serializeDirectory(group));
      // runLength = 0 即「这是一条叶子目录指针」，offset 相对 leafDirectoryOffset
      rootEntries.push({
        tileId: group[0].tileId,
        offset: leafOffset,
        length: blob.length,
        runLength: 0,
      });
      leafOffset += blob.length;
      leafBlobs.push(blob);
    }
    rootDir = gzipSync(serializeDirectory(rootEntries));
    if (rootDir.length > MAX_ROOT_DIR) {
      throw new Error(
        `根目录压缩后仍有 ${rootDir.length} 字节（上限 ${MAX_ROOT_DIR}），叶子目录切分不够细`,
      );
    }
  }

  const leafData = Buffer.concat(leafBlobs);
  const rootOffset = HEADER_LEN;
  const metaOffset = rootOffset + rootDir.length;
  const leafOffset = metaOffset + meta.length;
  const tileDataOffset = leafOffset + leafData.length;

  const h = Buffer.alloc(HEADER_LEN);
  h.write("PMTiles", 0, "latin1");
  h.writeUInt8(3, 7);
  const u64 = (v, o) => h.writeBigUInt64LE(BigInt(v), o);
  u64(rootOffset, 8);
  u64(rootDir.length, 16);
  u64(metaOffset, 24);
  u64(meta.length, 32);
  u64(leafOffset, 40);
  u64(leafData.length, 48);
  u64(tileDataOffset, 56);
  u64(tileData.length, 64);
  u64(tileEntries.length, 72); // numAddressedTiles
  u64(tileEntries.length + rootEntries.length, 80); // numTileEntries（含叶子指针）
  u64(tileEntries.length, 88); // numTileContents
  h.writeUInt8(1, 96); // clustered
  h.writeUInt8(internalCompression, 97);
  h.writeUInt8(tileCompression, 98);
  h.writeUInt8(tileType, 99);
  h.writeUInt8(minZoom, 100);
  h.writeUInt8(maxZoom, 101);
  h.writeInt32LE(Math.round(bounds[0] * 1e7), 102);
  h.writeInt32LE(Math.round(bounds[1] * 1e7), 106);
  h.writeInt32LE(Math.round(bounds[2] * 1e7), 110);
  h.writeInt32LE(Math.round(bounds[3] * 1e7), 114);
  h.writeUInt8(center[0], 118);
  h.writeInt32LE(Math.round(center[1] * 1e7), 119);
  h.writeInt32LE(Math.round(center[2] * 1e7), 123);

  return { buf: Buffer.concat([h, rootDir, meta, leafData, tileData]), leafCount: leafBlobs.length };
}

// ============================================================
// 自校验：用官方 pmtiles 包把刚写的文件读回来
// ============================================================

class MemorySource {
  #buf;
  constructor(buf) {
    this.#buf = buf;
  }
  async getBytes(offset, length) {
    return {
      data: this.#buf.buffer.slice(
        this.#buf.byteOffset + offset,
        this.#buf.byteOffset + offset + length,
      ),
    };
  }
  getKey() {
    return "verify";
  }
}

/**
 * 用**官方 `pmtiles` 包**读回归档。格式写错（比如根目录/叶子目录算错）一定会抛错，
 * 比「去浏览器里看一眼」可靠得多。
 *
 * @param {string} path
 * @param {object} o
 * @param {number[]} o.sampleIds 要抽样解码的 tileId（Hilbert）
 * @param {string[]} o.layerNames 期望出现的 MVT 图层名（用于粗校验，可选）
 */
export async function verifyArchive(path, { sampleIds = [], layerNames = [] } = {}) {
  const { PMTiles } = await import("pmtiles");
  const raw = readFileSync(path);
  const pm = new PMTiles(new MemorySource(raw));
  const header = await pm.getHeader();
  const checked = [];
  let ok = 0;
  let missing = 0;
  for (const id of sampleIds) {
    const [z, x, y] = tileIdToZxy(id);
    // ⚠️ getZxy 返回的已经是**解压后**的瓦片正文（内部按 header.tileCompression 解压过），
    //    所以这里不能去校验 gzip 魔数。
    const r = await pm.getZxy(z, x, y);
    if (!r) {
      missing++;
      continue;
    }
    const bytes = Buffer.from(r.data);
    // MVT 没有魔数，但图层名是明文长度前缀字符串，用真实图层名探测最可靠
    const text = bytes.toString("latin1");
    const layers = layerNames.filter((n) => text.includes(n));
    checked.push({ z, x, y, size: bytes.length, layers });
    ok++;
  }
  return { header, checked, ok, missing };
}
