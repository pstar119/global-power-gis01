/**
 * 阶段52：CSV 导出工具（从 AiQueryPanel.tsx 抽出，两处共用）。
 *
 * ## 依赖情况（阶段54 已收敛，别再照抄阶段52 的说法）
 *
 * 阶段52 曾为「另存为」破例引入 2 对依赖：
 *   - `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` —— 弹「另存为」对话框
 *   - `@tauri-apps/plugin-fs`     / `tauri-plugin-fs`     —— 写文件到用户选定路径
 *
 * ‼️ **阶段54 把「选路径 + 写盘」整体下沉到 Rust**（`src-tauri/src/export.rs`），
 *    原因是 `fs:write-all` 权限过宽（前端可写任意路径），且**无法用 `fs:scope` 收紧**
 *    —— 用户要自选保存位置，白名单不可能预先知道。
 *
 *    改法上有个容易走错的岔路，记在这里免得有人「简化」回去：
 *    ❌ 前端弹完对话框、把路径传给一个新的 `write_file(path, ...)` 命令 ——
 *       那样前端仍能构造任意路径，等于把 `fs:write-all` 换个名字，是安全戏法；
 *    ✅ 对话框与写盘都在 Rust 侧，**路径永远不经过前端**（现在的做法）。
 *
 *    于是本文件只剩「拼 CSV 字符串」+「把字符串交给一条 Rust 命令」，
 *    不再 import 任何 Tauri 插件：npm 依赖少 2 个，`fs:write-all` /
 *    `dialog:allow-save` 两条权限一并删掉。
 *
 * ⚠️ 仍然不引 papaparse / xlsx（CSV 拼接是手写的，够用且零依赖）。
 */

import { COLUMN_LABELS } from "./aiQuery";
import { countryLabel } from "./country";
import { fuelLabel } from "./fuel";
import { invoke } from "@tauri-apps/api/core";

type Row = Record<string, unknown>;

/**
 * CSV 单元格转义（RFC 4180）。
 * ⚠️ 含 , " \r \n 时用双引号包裹，内部双引号翻倍。
 */
export function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把单元格换成适合 CSV 的原始值。
 * ⚠️ 容量导出纯数字，不带单位；国家/燃料仍导中文。
 */
export function csvValue(key: string, value: unknown): unknown {
  if (value == null) return "";
  if (key === "country") return countryLabel(String(value));
  if (key === "primary_fuel") return fuelLabel(String(value));
  if (key === "capacity_mw" || key === "total_capacity_mw") {
    const n = Number(value);
    return Number.isFinite(n) ? n : "";
  }
  return value;
}

export interface DownloadCsvOptions {
  filenamePrefix?: string;
  filenameSuffix?: string;
}

/**
 * 把行拼成 CSV 并触发下载。
 */
export async function downloadCsv(
  columns: readonly string[],
  rows: readonly Row[],
  options: DownloadCsvOptions = {},
): Promise<{ ok: boolean; message: string }> {
  if (columns.length === 0 || rows.length === 0) {
    return { ok: false, message: "当前没有可导出的数据。" };
  }

  const header = columns.map((c) => csvCell(COLUMN_LABELS[c] ?? c)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => csvCell(csvValue(c, row[c]))).join(","),
  );
  const csv = "\uFEFF" + [header, ...body].join("\r\n");

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const prefix = options.filenamePrefix ?? "电力设施查询";
  const suffix = options.filenameSuffix ?? "";
  const defaultName = `${prefix}${suffix}_${ts}.csv`;

  try {
    /**
     * 阶段54：一条命令搞定「弹另存为 + 写盘」。
     * ‼️ 传的是**建议文件名**（不是路径）—— 真正的保存路径由 Rust 侧的原生对话框
     *    决定并直接使用，前端从头到尾拿不到、也构造不了它。
     *    返回 null 表示用户取消（不是错误）。
     */
    const savedPath = await invoke<string | null>("export_csv_file", {
      fileName: defaultName,
      contents: csv,
    });

    if (!savedPath) {
      return { ok: false, message: "已取消导出。" };
    }

    return { ok: true, message: `已导出 ${rows.length} 行到：${savedPath}` };
  } catch (err) {
    return {
      ok: false,
      message: `导出失败：${friendlyExportError(String(err))}`,
    };
  }
}

/**
 * 把 `export.rs` 回传的类型化错误码翻译成人话。
 * 错误码沿用 `packs.ts::friendlyError` 的同一套风格（大写码 + 冒号 + 细节）。
 *
 * ⚠️ 原生字符串匹配 `includes` 而不是 `startsWith` 判断 —— Tauri 会把命令名
 *    一并塞进错误串（形如 `export_csv_file: IO_ERROR: ...`），前缀判断会漏。
 */
function friendlyExportError(raw: string): string {
  if (raw.includes("BAD_PATH")) return "无法解析所选路径";
  if (raw.includes("IO_ERROR")) {
    // 最常见的一类：目标文件正被 Excel / WPS 打开，Windows 会拒绝写入
    if (/拒绝访问|Access is denied|os error 5/i.test(raw)) {
      return "无法写入该文件：它可能正被其他程序（如 Excel）占用，或被设为只读";
    }
    if (/空间不足|not enough space|os error 112/i.test(raw)) {
      return "磁盘空间不足，未能写入";
    }
    return "写入失败（路径可能不存在，或没有写权限）";
  }
  if (raw.includes("JOIN_ERROR")) return "导出任务异常中断";
  if (raw.includes("not found") || raw.includes("not allowed")) {
    return "当前环境不支持原生保存对话框（请确认运行的是桌面版而非浏览器预览）";
  }
  return raw || "未知错误";
}
