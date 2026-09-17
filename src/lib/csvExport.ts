/**
 * 阶段52：CSV 导出工具（从 AiQueryPanel.tsx 抽出，两处共用）。
 *
 * ⚠️ 阶段52 破例新增了 2 个依赖（项目原本「零新增依赖」）：
 *    - @tauri-apps/plugin-dialog：弹「另存为」对话框
 *    - @tauri-apps/plugin-fs：写文件到用户选定路径
 *    引入理由与代价见 PROJECT_HANDOFF.md。
 *    仍然不引 papaparse / xlsx（CSV 拼接是手写的）。
 */

import { COLUMN_LABELS } from "./aiQuery";
import { countryLabel } from "./country";
import { fuelLabel } from "./fuel";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

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
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!filePath) {
      return { ok: false, message: "已取消导出。" };
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(csv);
    await writeFile(filePath, data);

    return { ok: true, message: `已导出 ${rows.length} 行到：${filePath}` };
  } catch (err) {
    return {
      ok: false,
      message: `导出失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
