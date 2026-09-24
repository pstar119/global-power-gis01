# 数据源图谱与接入路线图

> 日期：2026-09-24
> 起因：用户要求审查 [OpenGridWorks](https://opengridworks.com/) 使用的数据源，并在**不涉及商业侵权、不采购商业数据**的前提下尽量复刻。
> 结论已由用户拍板：**维持「中国纯电力重构（项目 A）→ 相邻带邻国（项目 B）」两步走**，
> 本图谱作为**增量接入路线图**，逐项接进来。

---

## 0. 审查方法与局限（先读这段）

⚠️ **站点本身无法直读**：`opengridworks.com` 与 `/about` 两次直接抓取都被 Vercel 的机器人校验拦下
（HTTP `429` + `Vercel Security Checkpoint`）。因此本文档的源清单来自：

1. **第三方报道**：[Digital Substation 的专文](https://digitalsubstation.com/en/article/opengridworks-open-world-power-infrastructure-map?lang=es)
   （列出 OSM / ENTSO-E / Global Energy Monitor / OurGridFuture / EIA / HIFLD / IM3 / PNNL / DOE / WRI / TeleGeography，
   底图 CARTO + OSM；并指出"美国因 EIA/HIFLD 而明显更细"）；
2. **站内证据**（用户提供的截图）：弹窗 attribution、图层分组名、**URL 的 `layers=` 参数**。

**已证实 / 未核实 两档在表中明确标注** —— 不要把本表当成对该站的权威描述。

### 最强的站内证据：URL 参数直接暴露图层键

```text
opengridworks.com/power-plants?lat=43.60&lng=-96.63&z=15.87&layers=b,datacenters,chpoints,osm,gem,…
```

- `osm` —— OpenStreetMap 电力层（可对上）
- `gem` —— Global Energy Monitor（可对上；与本项目 `gem` 包同名）
- `datacenters` —— 数据中心层（可对上）
- `b` / `chpoints` —— **含义未确认**（不猜）

弹窗证据：南达科他某变电站弹窗显示字段「电压 / 来源 / 输出 / 功率 / 地点 / 数据源 / 频率 / 参考 / OSM ID」
且 attribution 写着「开放街道地图（ODbL）」⇒ **该要素来自 OSM**。

---

## 1. 源图谱与许可裁决

| 网站图层（其口径） | 数据源 | 许可 / 可得性 | 能否合法复刻 | 本项目现状 |
|---|---|---|---|---|
| 电厂 120,000+ | OSM + **GEM** + **WRI** + EIA(美) | OSM ODbL ✅ / GEM CC BY 4.0 ✅ / WRI CC BY 4.0 ✅ / EIA 美国联邦·公有领域 ✅ | ✅ 可以 | **已有**：GEM 包 + WRI 全球 34,936 座 |
| 输电线路 2.7M / 变电站 800k | OSM + HIFLD(美) + ENTSO-E(欧) | OSM ✅；**HIFLD 已迁移**（见 §3）；ENTSO-E 需注册并受其条款约束 | 🟡 部分 | **已有**：中国 7 区 + 核心区（OSM 管线） |
| GEM 层 | Global Energy Monitor | CC BY 4.0 ✅ | ✅ 可以 | **已有**（煤 / 油气 / 生物质三类） |
| 数据中心 / 互联网交换 | **OSM**（站内 attribution 已证实）；互联交换疑似 PeeringDB | OSM ✅；PeeringDB 有自身 ToS，**须核实** | 🟡 数据中心 ✅；互联网交换待核实 | ❌ 未做（`MapPage.tsx` 已留「数据中心」占位分组） |
| 油气管道 | OSM（+ 美国 PHMSA 等） | OSM ✅ | ✅ 技术上可以 | 🟡 **上一轮已决定不做**（与"只做电力"一致） |
| 洪水风险区 | **WRI Aqueduct** | CC BY 4.0 ✅ | ✅ 可以 | ❌ 未做（已留「洪水风险区」占位分组） |
| 计划中输电项目 | 报道提及 IM3 / PNNL / DOE，**具体数据集未核实** | ❓ | ❓ 需先查清 | ❌ 未做 |
| **海底通信电缆** | **TeleGeography** | 🔴 **商业授权数据** | ❌ **排除**（用户明确排除商业采购） | — |
| 底图 | CARTO + OSM | CARTO 按其条款使用 | ✅ **无需复刻** | 已有 Protomaps 离线底图（ODbL/免费） |

---

## 2. 三条硬结论

1. **该网站"开放的那半边"，本项目已持有大部分**：OSM 电力层、GEM、WRI 三个源都在跑，连图层键都撞名。
   真正缺的是**美国专属源（HIFLD / EIA）**与**上下文层（数据中心 / 洪水 / 计划项目）**。
2. **海缆层只能放弃**。用 OSM 的 `communication=line` + `location=underwater` 顶替，
   覆盖率会显著低于商业源 —— **如实施，必须在界面上如实标注覆盖口径，不做等价假装**。
3. **"数量与模式相似"只在美国成立**。该站全球基线与我们同源（OSM/GEM），
   美国密度来自 EIA/HIFLD ⇒ 「复刻数量」的实质是**是否接入美国专属源**。

---

## 3. 待核查清单（实施前必须查清，不许猜）

| # | 事项 | 为什么必须查 | 查法 |
|---|---|---|---|
| V1 | **HIFLD 当前的可用入口** | HIFLD Open 已发生迁移（有专门的过渡说明），部分数据集由第三方镜像（如 DataLumos）托管；另有需资质的 **HIFLD Secure** 层（不能用） | 查迁移说明与现行门户，确认输电线路/变电站数据的现行下载点与许可 |
| V2 | **ENTSO-E 的条款** | 需注册；再分发条件不明 | 读其数据许可条款后再决定是否纳入离线包 |
| V3 | **PeeringDB 的 ToS** | 互联网交换点层疑似来自此处 | 读 ToS，确认非商业再分发是否允许 |
| V4 | **IM3 / PNNL / DOE 具体是哪些数据集** | "计划中输电项目"层的实际来源不清 | 先确认数据集名称与许可，再决定接不接 |
| V5 | TeleGeography 的授权方式 | 已判定排除，但需确认是否存在开放子集 | 仅作记录，默认不做 |

> ⚠️ 这五条**都是许可与可得性问题，不是技术问题**。本项目红线是"许可明确前不下载、不分发"。

---

## 4. 接入顺序（路线图）

与已批准的两个项目的关系：

| 序 | 内容 | 状态 |
|---|---|---|
| 1 | **项目 A**：中国纯电力数据面重构（去铁路/管道 + 属性扩容 + 换流站/海缆**电力侧** + 几何合并 + 直交流分档） | ✅ 设计已定，待实施 |
| 2 | **项目 B**：相邻带 5 个邻国电网包 + 5 个底图包 + 多文种字形 | ✅ 设计已定（待 A 完成后按新口径复核） |
| 3 | **增量 1：数据中心层**（OSM `telecom=data_center` / `building=data_center`） | ⏳ 未开始；**复用 B 的 OSM 管线与包机制**，成本最低的新层 |
| 4 | **增量 2：洪水风险区层**（WRI Aqueduct，CC BY 4.0） | ⏳ 未开始 |
| 5 | **增量 3：美国电力数据**（EIA-860/923 + HIFLD，替换/补充 WRI 的美国口径） | ⏳ 未开始；**依赖 V1 结论** |
| 6 | **增量 4：计划中输电项目** | ⏳ 未开始；**依赖 V4 结论** |
| 7 | 海缆层 | ❌ **已排除**（商业数据） |

> 📌 每个增量都必须遵守项目既有红线：**零新增依赖**（除非单独授权）、
> **大数据走按需下载包**、**许可未明确前不下载不分发**、**易失数字给命令不给固定值**。

---

## 5. 引用来源

- [OpenGridWorks — an open map of the world's power infrastructure（Digital Substation）](https://digitalsubstation.com/en/article/opengridworks-open-world-power-infrastructure-map?lang=es)
- [opengridworks.com](https://opengridworks.com/)（直读被 Vercel 机器人校验拦截，HTTP 429）
- 用户提供的四张站内截图（图层分组、弹窗字段、URL `layers=` 参数）
