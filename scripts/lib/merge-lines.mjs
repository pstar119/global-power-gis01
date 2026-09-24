/**
 * 阶段56-A2：把 OSM 按杆塔切碎的 `power=line` 合并成**完整线路**。
 *
 * 为什么需要它：OSM 的 `power=line` 是「每两座杆塔一条 way」。于是同一条输电线路
 * 在数据里是几十上百个要素 —— 前端弹窗只能显示其中一段，也没法给出真实长度。
 *
 * ── 合并规则（**全部条件都是必要的，缺一不合并**，见设计文档 §4.2）
 *   1. 两条 way 在**一端坐标精确相等**。OSM 在同一杆塔处切分，端点坐标完全相同，
 *      所以**不需要容差** —— 加容差只会把相邻却无关的线误连。
 *   2. 该端点的**度数恰好为 2**（只有这两条 way 相接）。度数 ≥3 一律视为接点 /
 *      双回共塔，**停止合并**。
 *   3. 属性兼容：`line_kind` 相同；`voltage_kv` 不冲突（都非空且不同 ⇒ 不合并）；
 *      `ref` / `name` / `operator` 不冲突（两者都有值且不同 ⇒ 不合并；一方为空则取有值者）。
 *
 * ‼️ **已知局限（不要假装没有）**：本模块**不还原真实电气拓扑**。
 *    双回线路若在 OSM 里画成两条几何不相接的线 ⇒ 不会被合并（正确）；
 *    但两条电气无关的线若恰好各只有一个邻居又在同一点相接 ⇒ 会被合并（**误连**）。
 *    后者无法在不引入外部电网拓扑数据的前提下根治。
 *    ⇒ 合并结果**只用于渲染与长度统计，不作为电气证据**（例如不能据此推断"同一条线路"）。
 *
 * 零新增依赖：只用 Node 标准库。
 */

/** 端点键：与 prepare 的 `round6` 一致（6 位小数），保证"同一点"判定是精确的 */
const keyOf = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

const R_EARTH_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

/** 单段长度（Haversine 累加） */
export function lengthKm(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    sum += 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return sum;
}

/**
 * 两段是否可合并；可合并则返回合并后的属性，否则 null。
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
function mergeProps(a, b) {
  if ((a.line_kind ?? null) !== (b.line_kind ?? null)) return null;

  const va = a.voltage_kv ?? null;
  const vb = b.voltage_kv ?? null;
  if (va !== null && vb !== null && va !== vb) return null;

  const out = { ...a, voltage_kv: va ?? vb };
  for (const k of ["ref", "name", "operator"]) {
    const x = a[k] ?? null;
    const y = b[k] ?? null;
    if (x !== null && y !== null && x !== y) return null;
    out[k] = x ?? y;
  }
  // 这几项不参与"冲突判定"，只取第一个非空值（缺失是常态，不该因此拒绝合并）
  for (const k of ["cables", "wires", "circuits", "vclass"]) {
    out[k] = (a[k] ?? null) ?? (b[k] ?? null);
  }
  /**
   * ‼️ 阶段56-A2：`frequency` / `is_dc` 必须一起传播，否则**合并会把直流信息吃掉**。
   *
   * 为什么不放进上面的"取第一个非空"：一条链路的 `frequency` 若前段是 "50"、后段是 "0"，
   * 取第一个非空会得到 "50"（交流），而这条链路其实含直流段 —— 判定与显示会自相矛盾。
   * 所以规则是：**只要有一段是 "0"（直流硬信号）就取 "0"**，否则取第一个非空值；
   * `is_dc` 取**逻辑或**（任一段是直流 ⇒ 整条链路按直流渲染）。
   * 两者的语义保持一致（`frequency==="0"` ⇒ `is_dc===true`）。
   *
   * ⚠️ 全都为空时**删掉这个键**，而不是写成 `frequency: null`：
   *    否则每个合并要素都会在输出里多一个 `"frequency":null`（实测华东会有 1.1 万个），
   *    既白占 GeoJSON 体积，又让 `build_pmtiles.mjs` 的「保留字段 frequency(N)」把
   *    "真的有频率标签的要素数" 报成 "被合并过的要素数" —— 那是**读数撒谎**。
   */
  const freq = a.frequency === "0" || b.frequency === "0" ? "0" : ((a.frequency ?? null) ?? (b.frequency ?? null));
  if (freq === null) delete out.frequency;
  else out.frequency = freq;
  out.is_dc = Boolean(a.is_dc) || Boolean(b.is_dc);
  return out;
}

/** 简单的并查集 */
function makeUf(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  return { find, union: (a, b) => { p[find(a)] = find(b); } };
}

/**
 * @param {Array<{properties: Record<string, unknown>, geometry: {type: string, coordinates: number[][]}}>} features
 * @param {{maxOsmIds?: number}} [opts]
 * @returns {{features: typeof features, stats: {input: number, output: number, groups: number, maxChain: number, lengthBeforeKm: number, lengthAfterKm: number}}}
 */
export function mergeLines(features, opts = {}) {
  /**
   * 每个合并要素最多记几个 `osm_id`（默认 **5**）。
   *
   * 用途只有一个：弹窗里给出"这条线路由哪些 OSM way 组成"的抽样线索。
   * 「合并了多少段」由 `merged_count` 表达，**不丢信息**；首段 `osm_id` 也照旧单列。
   *
   * ⚠️ 别指望它能显著压体积（2026-09-24 实测）：华东包三个新增字段合计 +5.5 MB，
   *    其中 `length_km`（double 8 字节）≈ +2.65、`osm_ids` ≈ +1.98、`merged_count` ≈ +0.54；
   *    而**合并率只有 12~17%，绝大多数要素 `merged_count=1`** ⇒ 20 → 5 只让 7 包从
   *    152.08 降到 151.61 MB（−0.31%）。要真正压体积得改 `length_km` 的表示或不再落
   *    `osm_ids`，那属于数据模型变更（设计 §4.1），不在本模块内自作主张。
   *
   * ⚠️ 这个参数**必须一路传到 `decorate()`**。早先版本它只被读进局部变量、
   *    `decorate` 里却写死 `slice(0, 20)` —— 参数形同虚设，调它没有任何效果，
   *    而且**不报错**（渲染、门禁都正常）。改这里务必同时改 `decorate`。
   */
  const maxOsmIds = opts.maxOsmIds ?? 5;
  const segs = features.map((f, i) => {
    const coords = f.geometry.coordinates;
    return { i, f, coords, start: keyOf(coords[0]), end: keyOf(coords[coords.length - 1]) };
  });

  // 端点 -> 落在该点的 (段, 端别)
  const at = new Map();
  const add = (k, s, which) => {
    const arr = at.get(k);
    if (arr) arr.push({ s, which });
    else at.set(k, [{ s, which }]);
  };
  for (const s of segs) {
    add(s.start, s, "start");
    add(s.end, s, "end");
  }

  const uf = makeUf(segs.length);
  for (const list of at.values()) {
    // 规则 2：度数必须**恰好为 2**，且必须是两条不同的 way
    // （同一段的 start/end 同点 = 闭合环，list 会有两条但 s.i 相同 ⇒ 排除，避免自连）
    if (list.length !== 2) continue;
    const [x, y] = list;
    if (x.s.i === y.s.i) continue;
    // 规则 3
    if (mergeProps(x.s.f.properties, y.s.f.properties) === null) continue;
    uf.union(x.s.i, y.s.i);
  }

  const groups = new Map();
  for (const s of segs) {
    const r = uf.find(s.i);
    const g = groups.get(r);
    if (g) g.push(s);
    else groups.set(r, [s]);
  }

  const out = [];
  let maxChain = 0;
  let lenBefore = 0;
  for (const s of segs) lenBefore += lengthKm(s.coords);

  /**
   * 组内邻接表：`segIndex -> [邻居 segIndex]`。
   *
   * ‼️ **只在这里建一次**。早先的版本把它写在下面的分组循环内部，
   *    等于"对每一个组都全量重扫一遍端点表" —— 华东 75k 条线路时
   *    实测**跑满 600 秒被强制超时**（复杂度 O(组数 × 端点数)）。
   *    移到循环外之后是 O(端点数)。
   *
   * ⚠️ 判据必须与上面的 union 循环**逐条一致**（度数=2、非自连、属性兼容）；
   *    少一条就会连出"跨接点"的链，而那种错误在渲染上看不出来。
   */
  const link = new Map();
  for (const list of at.values()) {
    if (list.length !== 2) continue;
    const [x, y] = list;
    if (x.s.i === y.s.i) continue;
    if (mergeProps(x.s.f.properties, y.s.f.properties) === null) continue;
    if (!link.has(x.s.i)) link.set(x.s.i, []);
    if (!link.has(y.s.i)) link.set(y.s.i, []);
    link.get(x.s.i).push(y.s.i);
    link.get(y.s.i).push(x.s.i);
  }

  let brokenChains = 0;
  for (const group of groups.values()) {
    // 从链端（只有 1 个邻居）起步；纯环则任取一段
    let cur = group.find((s) => (link.get(s.i)?.length ?? 0) <= 1) ?? group[0];
    let curCoords = cur.coords;

    /**
     * 起步定向：若它只有一个邻居，就让"接邻居的那一端"落在**末端**。
     *
     * ‼️ 少了这一步会静默丢长度：两段若在**同一点起始**（V 形拐点，OSM 里很常见），
     *    正向走会走到另一端时接不上邻居。实测这个缺陷让华东线路总长少了 **9.5%**
     *    （验收口径是 <0.1%）—— 而且渲染上看不出来，只有长度守恒断言能抓到。
     */
    const startNbrs = link.get(cur.i) ?? [];
    if (startNbrs.length === 1) {
      const nb = segs[startNbrs[0]];
      if (nb.start === keyOf(curCoords[0]) || nb.end === keyOf(curCoords[0])) {
        curCoords = [...curCoords].reverse();
      }
    }

    const seen = new Set();
    let props = null;
    let coords = [];
    const osmIds = [];
    let count = 0;

    while (cur && !seen.has(cur.i)) {
      let c = curCoords;
      const tail = coords.length ? keyOf(coords[coords.length - 1]) : null;
      if (tail !== null) {
        if (keyOf(c[0]) === tail) {
          // 方向已对
        } else if (keyOf(c[c.length - 1]) === tail) {
          c = [...c].reverse();
        } else {
          // ‼️ 接不上就**断开**，且此时**什么都不消费**（不加入 seen），
          //    让下面的兜底循环把它原样输出 —— 宁可多出一条链，也不丢长度。
          brokenChains++;
          break;
        }
      }
      seen.add(cur.i);
      count++;
      props = props === null ? { ...cur.f.properties } : (mergeProps(props, cur.f.properties) ?? props);
      osmIds.push(cur.f.properties.osm_id);
      coords = coords.length ? coords.concat(c.slice(1)) : c.slice();

      const nbrs = (link.get(cur.i) ?? []).filter((n) => !seen.has(n));
      cur = nbrs.length ? segs[nbrs[0]] : null;
      curCoords = cur ? cur.coords : null;
    }

    // 组内若有分支（理论上被度数=2 排除），把剩下的段按原样追加，避免丢数据
    for (const s of group) {
      if (seen.has(s.i)) continue;
      out.push(decorate(s.f, [s.f.properties.osm_id], 1, s.coords, maxOsmIds));
      count = Math.max(count, 1);
      seen.add(s.i);
    }

    if (count > 0 && props !== null) {
      out.push(decorate({ ...features[0], properties: props }, osmIds, count, coords, maxOsmIds));
      maxChain = Math.max(maxChain, count);
    }
  }

  let lenAfter = 0;
  for (const f of out) lenAfter += lengthKm(f.geometry.coordinates);

  return {
    features: out,
    stats: {
      input: segs.length,
      output: out.length,
      groups: groups.size,
      maxChain,
      /** 走链时接不上而主动断开的次数（**必须为 0**；不为 0 说明方向对齐有问题） */
      brokenChains,
      lengthBeforeKm: lenBefore,
      lengthAfterKm: lenAfter,
    },
  };
}

/**
 * @param {number} maxOsmIds 逗号串里最多记几个 id —— **由 `mergeLines` 传入**，
 *   不要在这里写死常量（写死会让 `opts.maxOsmIds` 静默失效，见 `mergeLines` 的注释）。
 */
function decorate(base, osmIds, count, coords, maxOsmIds) {
  return {
    type: "Feature",
    properties: {
      ...base.properties,
      osm_id: osmIds[0] ?? base.properties.osm_id,
      // ⚠️ MVT **不支持数组属性**（vt-pbf 会写坏或报错），所以这里存成逗号串
      osm_ids: osmIds.slice(0, maxOsmIds).join(","),
      merged_count: count,
      length_km: Math.round(lengthKm(coords) * 100) / 100,
    },
    geometry: { type: "LineString", coordinates: coords },
  };
}
