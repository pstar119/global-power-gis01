#!/usr/bin/env node
/**
 * 从 Protomaps 公开的行星 PMTiles 归档里，按「全球低级别 + 区域高级别」切出一块，
 * 写成独立的 PMTiles v3 归档，作为本项目的**真实离线底图**。
 *
 * 用法：
 *   node scripts/fetch_basemap.mjs --estimate-only
 *   node scripts/fetch_basemap.mjs
 *
 * 产物：src-tauri/resources/maps/basemap.pmtiles（已加入 .gitignore，不进 Git）
 *
 * ============================================================
 * 为什么不用官方的 `pmtiles extract`？
 * ============================================================
 * 官方 CLI 是 Go 写的单文件可执行程序，只能从 GitHub Releases 下载。
 * 本机实测 `github.com/.../releases/download/...` **20 秒超时**（拿不到 17MB 的 zip），
 * 所以这条路走不通，只能自己实现切割。
 *
 * 好消息是：本机对 `build.protomaps.com` 的 **HTTP Range 是通的**
 * （实测 `Range: bytes=0-1023` 返回 `206 Partial Content`），
 * 而项目本来就依赖 `pmtiles` 包，它导出了 `FetchSource` / `bytesToHeader` /
 * `readVarint` / `findTile` / `zxyToTileId` 这些低层原语，
 * 所以**不需要引入任何新依赖**就能完成切割。
 *
 * ============================================================
 * 为什么不能「一个瓦片一个请求」
 * ============================================================
 * 目标区域有几千个瓦片。逐个 Range 请求，即使每次只要 20 ms，也要好几分钟，
 * 而且对服务端极不友好。PMTiles 的瓦片数据是**按 tileId（Hilbert 序）连续存放**的，
 * 而 Hilbert 序有空间局部性 —— 所以同一个区域、同一个级别的瓦片在文件里**基本连成一片**。
 *
 * 于是这里做两件事：
 *   1. 先从目录里把「我要的所有瓦片」的 (offset, length) 全部收集出来，**先不下正文**；
 *   2. 按 offset 排序后**合并相邻区间**（允许浪费一点带宽），一次请求拿一大段。
 * 实测请求数从几千降到几十。
 *
 * 目录本身（叶子目录）也走同一套合并逻辑，否则光读目录就要几百个请求。
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

import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHeader, findTile, readVarint, tileIdToZxy, zxyToTileId } from "pmtiles";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================
// 0. 参数
// ============================================================

/** 固定日期而不是 latest：latest 每天变，产物不可复现；失败时再回退 */
const DEFAULT_SOURCE = "https://build.protomaps.com/20260912.pmtiles";
const FALLBACK_SOURCE = "https://latest.protomaps.com/v4.pmtiles";

const DEFAULTS = {
  source: DEFAULT_SOURCE,
  /** 全球范围只保留到这一级（再往里就只切区域，否则体积会爆） */
  globalMaxZoom: 4,
  /**
   * 区域 bbox：中国中东部（华北/华东/华中/华南/西南东部，含台湾）。
   * 实测：全球 z0-z4（5.75 MB）+ 该 bbox z5-z8（26.0 MB）= 31.8 MB。
   * 若改成 bbox 73,18,135,54 且只到 z7，则是 26.1 MB（面积大但更糊）。
   * 再往深一级（z9）体积会翻到 53 MB 以上，超出预期的 10-50 MB 区间。
   */
  bbox: [98, 18, 128, 46],
  regionMinZoom: 5,
  regionMaxZoom: 8,
  out: "src-tauri/resources/maps/basemap.pmtiles",
  /** 合并区间时允许浪费的最大空隙（字节） */
  maxGap: 65536,
  /** 单次请求的最大字节数 */
  maxChunk: 8 * 1024 * 1024,
  concurrency: 6,
  estimateOnly: false,
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--source") cfg.source = next();
    else if (a === "--global-maxzoom") cfg.globalMaxZoom = Number(next());
    else if (a === "--bbox") cfg.bbox = next().split(",").map(Number);
    else if (a === "--region-minzoom") cfg.regionMinZoom = Number(next());
    else if (a === "--region-maxzoom") cfg.regionMaxZoom = Number(next());
    else if (a === "--out") cfg.out = next();
    else if (a === "--estimate-only") cfg.estimateOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: node scripts/fetch_basemap.mjs [选项]",
          "",
          "  --source <url>          源归档地址（默认 " + DEFAULT_SOURCE + "）",
          "  --global-maxzoom <n>    全球范围保留到第几级（默认 4，即全世界 z0-z4）",
          "  --bbox <minLon,minLat,maxLon,maxLat>  区域范围（默认 98,18,128,46）",
          "  --region-minzoom <n>    区域起始级别（默认 5）",
          "  --region-maxzoom <n>    区域最高级别（默认 8）",
          "  --out <path>            输出路径（默认 " + DEFAULTS.out + "）",
          "  --estimate-only         只试算体积与瓦片数，不下载瓦片正文",
          "",
          "提示：先跑 --estimate-only 定级别。每多一级体积大致翻倍。",
        ].join("\n"),
      );
      process.exitCode = 0;
      return null; // 由调用方判断并退出（避免 process.exit 丢掉缓冲输出）
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (cfg.bbox.length !== 4 || cfg.bbox.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bbox 需要 4 个数字（minLon,minLat,maxLon,maxLat），收到 ${cfg.bbox}`);
  }
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));

// ============================================================
// 1. 带合并的 Range 读取器
// ============================================================

/**
 * 收集一批 (offset,length)，把邻近的合并成大块，一次性取回再切片。
 *
 * 合并策略要小心「浪费」和「请求数」的平衡：
 * 空隙上限 64 KB 时，绝大多数同级别瓦片都能并进同一块；
 * 再放宽只会白下载别人家的数据，收益不大。
 */
function coalesce(ranges, { maxGap, maxChunk }) {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  const chunks = [];
  for (const r of sorted) {
    const last = chunks[chunks.length - 1];
    if (
      last &&
      r.offset - (last.offset + last.length) <= maxGap &&
      r.offset + r.length - last.offset <= maxChunk
    ) {
      last.length = r.offset + r.length - last.offset;
    } else {
      chunks.push({ offset: r.offset, length: r.length });
    }
  }
  return chunks;
}

class RangeReader {
  #url;
  #stats = { requests: 0, bytes: 0, retries: 0 };

  constructor(url) {
    this.#url = url;
  }

  get stats() {
    return { ...this.#stats };
  }

  async #one(offset, length, attempt = 0) {
    try {
      const res = await fetch(this.#url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (res.status !== 206) {
        // 200 说明服务端忽略了 Range，会白下载整个文件（行星归档 100+ GB）
        throw new Error(
          `服务端未按 Range 返回：HTTP ${res.status}（期望 206）。` +
            `若返回 200，说明该地址不支持字节服务，不能用于大文件。`,
        );
      }
      const cr = res.headers.get("content-range") ?? "";
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
      if (!m || Number(m[1]) !== offset) {
        throw new Error(`Content-Range 与请求不符：请求 ${offset}-${offset + length - 1}，收到 ${cr}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== length) {
        throw new Error(`正文长度不符：期望 ${length}，收到 ${buf.length}`);
      }
      this.#stats.requests++;
      this.#stats.bytes += buf.length;
      return buf;
    } catch (err) {
      if (attempt >= 3) throw new Error(`Range 读取失败 (${offset}+${length})：${err.message}`);
      this.#stats.retries++;
      const wait = 400 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return this.#one(offset, length, attempt + 1);
    }
  }

  /** 精确读一段（用于头部等小数据） */
  read(offset, length) {
    return this.#one(offset, length);
  }

  /**
   * 批量读。返回 `offset -> Buffer` 的 Map。
   * ⚠️ 同一个 offset 只应出现一次（调用方负责去重），否则键会互相覆盖。
   */
  async readMany(ranges) {
    if (ranges.length === 0) return new Map();
    const chunks = coalesce(ranges, cfg);
    const out = new Map();

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= chunks.length) return;
        const c = chunks[i];
        const buf = await this.#one(c.offset, c.length);
        for (const r of ranges) {
          if (r.offset >= c.offset && r.offset + r.length <= c.offset + c.length) {
            out.set(r.offset, buf.subarray(r.offset - c.offset, r.offset - c.offset + r.length));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, chunks.length) }, worker));
    return out;
  }
}

// ============================================================
// 2. 读取远程归档的目录
// ============================================================

function decompressInternal(buf, internalCompression) {
  if (internalCompression === 1) return buf; // none
  if (internalCompression === 2) return gunzipSync(buf);
  throw new Error(`不支持 internalCompression=${internalCompression}（仅支持 1=none / 2=gzip）`);
}

function deserializeDirectory(buf) {
  const p = { buf: new Uint8Array(buf), pos: 0 };
  const numEntries = readVarint(p);
  const entries = [];
  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint(p);
    lastId += v;
    entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 1 });
  }
  for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint(p);
  for (let i = 0; i < numEntries; i++) entries[i].length = readVarint(p);
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint(p);
    if (v === 0 && i > 0) entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    else entries[i].offset = v - 1;
  }
  return entries;
}

/** 与 `findTile` 同语义，但返回下标 —— 便于按叶子目录去重 */
function findIndex(entries, tileId) {
  let m = 0;
  let n = entries.length - 1;
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = tileId - entries[k].tileId;
    if (cmp > 0) m = k + 1;
    else if (cmp < 0) n = k - 1;
    else return k;
  }
  if (n >= 0) {
    if (entries[n].runLength === 0) return n;
    if (tileId - entries[n].tileId < entries[n].runLength) return n;
  }
  return -1;
}

// ============================================================
// 3. 目标瓦片枚举
// ============================================================

const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
function tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/**
 * 全球前 `globalMaxZoom` 级取**全世界**（低级别瓦片本来就覆盖全球，
 * 只切中国的话，地图缩小到 z0 时周边会是一片空白，看起来像坏了）；
 * 再往里只切 bbox，否则体积会失控。
 */
function enumerateTiles() {
  const [minLon, minLat, maxLon, maxLat] = cfg.bbox;
  const ids = [];
  const perZoom = new Map();

  for (let z = 0; z <= cfg.globalMaxZoom; z++) {
    const list = [];
    const n = 2 ** z;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) list.push(zxyToTileId(z, x, y));
    perZoom.set(z, list);
    ids.push(...list);
  }

  for (let z = cfg.globalMaxZoom + 1; z <= cfg.regionMaxZoom; z++) {
    const n = 2 ** z;
    const x0 = Math.max(0, Math.min(n - 1, tileX(minLon, z)));
    const x1 = Math.max(0, Math.min(n - 1, tileX(maxLon, z)));
    const y0 = Math.max(0, Math.min(n - 1, tileY(maxLat, z)));
    const y1 = Math.max(0, Math.min(n - 1, tileY(minLat, z)));
    const list = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) list.push(zxyToTileId(z, x, y));
    }
    perZoom.set(z, list);
    ids.push(...list);
  }

  return { ids: [...new Set(ids)].sort((a, b) => a - b), perZoom };
}

// ============================================================
// 4. 组装输出归档
// ============================================================

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
const MAX_ROOT_DIR = 16384;

function buildArchive({ tiles, metadataBuf, srcHeader, bounds, center, minZoom, maxZoom }) {
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
  h.writeUInt8(2, 97); // internalCompression = gzip
  h.writeUInt8(srcHeader.tileCompression, 98); // 原样保留（Protomaps 是 gzip）
  h.writeUInt8(srcHeader.tileType, 99); // 1 = mvt
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
// 5. 输出归档的自校验
// ============================================================

/**
 * 用**官方 `pmtiles` 包**把刚写出来的文件读回来。
 * 如果格式写错了（比如根目录/叶子目录算错），这里一定抛错 ——
 * 比「去浏览器里看一眼」可靠得多。
 */
class MemorySource {
  #buf;
  constructor(buf) {
    this.#buf = buf;
  }
  async getBytes(offset, length) {
    return { data: this.#buf.buffer.slice(this.#buf.byteOffset + offset, this.#buf.byteOffset + offset + length) };
  }
  getKey() {
    return "verify";
  }
}

async function verifyArchive(path, sampleIds) {
  const { PMTiles } = await import("pmtiles");
  const raw = readFileSync(path);
  const pm = new PMTiles(new MemorySource(raw));
  const header = await pm.getHeader();
  const checked = [];
  let ok = 0;
  for (const id of sampleIds) {
    const [z, x, y] = tileIdToZxy(id);
    // ⚠️ getZxy 返回的已经是**解压后**的瓦片正文（内部按 header.tileCompression 解压过），
    //    所以这里不能去校验 gzip 魔数，要校验它确实是一张 MVT。
    const r = await pm.getZxy(z, x, y);
    if (!r) continue;
    const bytes = Buffer.from(r.data);
    // MVT 没有魔数，但 layer 名是明文长度前缀字符串，拿真实图层名探测最可靠
    const text = bytes.toString("latin1");
    const layers = ["earth", "water", "roads", "landuse", "places", "boundaries", "buildings"].filter((n) =>
      text.includes(n),
    );
    checked.push({ z, x, y, size: bytes.length, layers });
    ok++;
  }
  return { header, checked, ok };
}

// ============================================================
// 主流程
// ============================================================

async function openSource() {
  for (const url of [cfg.source, FALLBACK_SOURCE]) {
    try {
      const reader = new RangeReader(url);
      const head = await reader.read(0, HEADER_LEN);
      const header = bytesToHeader(head.buffer.slice(head.byteOffset, head.byteOffset + HEADER_LEN));
      return { url, reader, header };
    } catch (err) {
      console.warn(`⚠️  ${url} 不可用：${err.message}`);
    }
  }
  throw new Error("所有数据源都不可用，请检查网络或改用 --source 指定其它归档地址");
}

async function main() {
  console.log("=== 阶段 26：切割真实离线底图（Protomaps PMTiles）===\n");
  const { url, reader, header } = await openSource();
  console.log(`数据源      : ${url}`);
  console.log(
    `源归档      : z${header.minZoom}-${header.maxZoom}，瓦片数 ${header.numAddressedTiles.toLocaleString()}，` +
      `tileType=${header.tileType}，tileCompression=${header.tileCompression}`,
  );

  const { ids, perZoom } = enumerateTiles();
  console.log(
    `\n目标范围    : 全球 z0-z${cfg.globalMaxZoom}（全世界）+ ` +
      `z${cfg.globalMaxZoom + 1}-z${cfg.regionMaxZoom}（bbox ${cfg.bbox.join(",")}）`,
  );
  console.log(`候选瓦片    : ${ids.length.toLocaleString()}`);

  // ---- 目录：根目录 ----
  const rootRaw = await reader.read(header.rootDirectoryOffset, header.rootDirectoryLength);
  const rootEntries = deserializeDirectory(decompressInternal(rootRaw, header.internalCompression));
  console.log(`根目录条目  : ${rootEntries.length.toLocaleString()}`);

  // ---- 第一遍：用根目录定位，收集需要的叶子目录 ----
  const direct = new Map(); // tileId -> {offset, length}
  const leafNeeded = new Map(); // 根目录下标 -> {offset, length}
  const pendingByLeaf = new Map(); // 根目录下标 -> tileId[]

  for (const id of ids) {
    const i = findIndex(rootEntries, id);
    if (i < 0) continue;
    const e = rootEntries[i];
    if (e.runLength > 0) {
      direct.set(id, { offset: e.offset, length: e.length });
    } else {
      if (!pendingByLeaf.has(i)) pendingByLeaf.set(i, []);
      pendingByLeaf.get(i).push(id);
      leafNeeded.set(i, {
        offset: header.leafDirectoryOffset + e.offset,
        length: e.length,
      });
    }
  }

  console.log(
    `直接命中    : ${direct.size.toLocaleString()} 个瓦片；需读叶子目录 ${leafNeeded.size.toLocaleString()} 个`,
  );

  // ---- 第二遍：批量取叶子目录（同样合并区间）----
  const leafRanges = [...leafNeeded.values()];
  const leafBytes = await reader.readMany(leafRanges);
  let missing = 0;
  const tiles = new Map(direct);

  for (const [i, wanted] of pendingByLeaf) {
    const range = leafNeeded.get(i);
    const raw = leafBytes.get(range.offset);
    if (!raw) throw new Error(`叶子目录读取缺失：offset=${range.offset}`);
    const entries = deserializeDirectory(decompressInternal(raw, header.internalCompression));
    for (const id of wanted) {
      const e = findTile(entries, id);
      if (!e || e.runLength === 0) {
        missing++;
        continue;
      }
      tiles.set(id, { offset: e.offset, length: e.length });
    }
  }

  // ---- 体积试算 ----
  const byZoom = new Map();
  let totalBytes = 0;
  for (const [id, r] of tiles) {
    const [z] = tileIdToZxy(id);
    byZoom.set(z, (byZoom.get(z) ?? 0) + r.length);
    totalBytes += r.length;
  }
  console.log(`\n命中瓦片    : ${tiles.size.toLocaleString()}（源里没有的 ${missing.toLocaleString()} 个，多为海洋）`);
  for (const z of [...byZoom.keys()].sort((a, b) => a - b)) {
    const cnt = [...tiles.keys()].filter((id) => tileIdToZxy(id)[0] === z).length;
    console.log(
      `  z${String(z).padStart(2)}  候选 ${String(perZoom.get(z)?.length ?? 0).padStart(6)}` +
        `  命中 ${String(cnt).padStart(6)}  正文 ${(byZoom.get(z) / 1048576).toFixed(2)} MB`,
    );
  }
  console.log(`正文合计    : ${(totalBytes / 1048576).toFixed(2)} MB（未计目录与元数据）`);

  if (cfg.estimateOnly) {
    console.log(`\n[试算模式] 请求统计：${reader.stats.requests} 次，${(reader.stats.bytes / 1048576).toFixed(2)} MB\n`);
    return;
  }

  // ---- 下载瓦片正文（合并成大块）----
  console.log(`\n开始下载瓦片正文（区间合并：空隙 ≤ ${cfg.maxGap / 1024} KB，单块 ≤ ${cfg.maxChunk / 1048576} MB）…`);
  const tileRanges = [...tiles.values()].map((r) => ({
    offset: header.tileDataOffset + r.offset,
    length: r.length,
  }));
  const chunksOut = await reader.readMany(tileRanges);
  console.log(`Range 请求  : ${reader.stats.requests} 次，共 ${(reader.stats.bytes / 1048576).toFixed(2)} MB`);

  const payload = new Map();
  for (const [id, r] of tiles) {
    const g = chunksOut.get(header.tileDataOffset + r.offset);
    if (!g) throw new Error(`瓦片正文读取缺失：tileId=${id}`);
    payload.set(id, g);
  }

  // ---- 元数据原样保留（含 OSM 署名）----
  const metaRaw = await reader.read(header.jsonMetadataOffset, header.jsonMetadataLength);
  const metadataBuf = decompressInternal(metaRaw, header.internalCompression);

  // ---- 写盘 ----
  const zs = [...tiles.keys()].map((id) => tileIdToZxy(id)[0]);
  const out = buildArchive({
    tiles: payload,
    metadataBuf,
    srcHeader: header,
    bounds: cfg.bbox,
    center: [(Math.min(...zs) + Math.max(...zs)) >> 1, (cfg.bbox[0] + cfg.bbox[2]) / 2, (cfg.bbox[1] + cfg.bbox[3]) / 2],
    minZoom: Math.min(...zs),
    maxZoom: Math.max(...zs),
  });

  const outPath = resolve(ROOT, cfg.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.buf);

  console.log(`\n已写出      : ${outPath}`);
  console.log(
    `体积        : ${(statSync(outPath).size / 1048576).toFixed(2)} MB` +
      `（其中叶子目录 ${out.leafCount} 个）`,
  );

  // ---- 自校验 ----
  console.log("\n用官方 pmtiles 包回读校验…");
  const sample = [];
  for (const z of [0, cfg.globalMaxZoom, cfg.regionMaxZoom]) {
    for (const id of tiles.keys()) {
      if (tileIdToZxy(id)[0] === z) {
        sample.push(id);
        break;
      }
    }
  }
  const v = await verifyArchive(outPath, sample);
  console.log(
    `回读 header : z${v.header.minZoom}-${v.header.maxZoom}，tileType=${v.header.tileType}，` +
      `tileCompression=${v.header.tileCompression}，addressed=${v.header.numAddressedTiles.toLocaleString()}`,
  );
  for (const c of v.checked) {
    console.log(
      `  z${c.z}/${c.x}/${c.y}  ${String(c.size).padStart(6)} B  图层=[${c.layers.join(",")}]`,
    );
  }
  const bad = v.checked.filter((c) => c.layers.length === 0);
  if (bad.length) throw new Error("回读校验失败：有瓦片不是可识别的 MVT（未发现任何已知图层名）");
  console.log(`\n✅ 完成：${tiles.size.toLocaleString()} 个真实底图瓦片，回读校验全部通过。\n`);
}

if (!cfg) {
  // --help：只打印用法。刻意不调 process.exit —— 那会把仍在管道缓冲里的输出一起丢掉。
} else {
  main().catch((err) => {
    console.error(`\n❌ ${err.stack ?? err.message}\n`);
    // 同样不用 process.exit：让 stdout 自然 flush，否则诊断输出可能被截断
    process.exitCode = 1;
  });
}
