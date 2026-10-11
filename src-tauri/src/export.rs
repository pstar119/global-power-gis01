//! 阶段54：CSV 导出的「选路径 + 写盘」动作，整体放在 **Rust 侧**。
//!
//! ## 为什么要把这件事从前端搬过来
//!
//! 阶段52 为 CSV 导出破例引了两对依赖：
//!   · `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` —— 弹原生「另存为」
//!   · `@tauri-apps/plugin-fs`     / `tauri-plugin-fs`     —— 把字节写到用户选的路径
//!
//! 其中第二项带来了一个**过宽的权限**：`capabilities/default.json` 里必须写
//! `fs:write-all`，意思是「前端任意脚本可写任意路径」。
//! 而且它**不能靠 `fs:scope` 收紧** —— 用户要自选保存位置，白名单不可能预先知道。
//!
//! ## 只把「写」搬过来是不够的（这一点很容易做错）
//!
//! 曾经考虑过一个更小的改法：前端照旧调 `save()` 拿路径，再把路径传给一个新的
//! `write_file(path, contents)` 命令。**那样等于什么都没改** ——
//! 前端仍然能构造任意路径，只是把 `fs:write-all` 换了个名字，属于安全戏法。
//!
//! 真正能收敛权限的做法是**让路径永远不经过前端**：
//! 原生对话框在这里弹、`PathBuf` 在这里拿到、字节在这里写。
//! 前端只递进来一个**建议文件名**（纯字符串，会被 `safe_suggested_name()` 洗过），
//! 拿回去一个用于提示的路径字符串。
//!
//! ## 收益（已实测核实，2026-09-18）
//!
//! | 项 | 变化 | 核实方式 |
//! |---|---|---|
//! | 权限 | 删掉 `fs:write-all` 与 `dialog:allow-save` | `capabilities/default.json` |
//! | npm 依赖 | **减 2 个** | `npm install` 输出 `removed 2 packages` |
//! | cargo 直接依赖 | 减 1 个（本 crate 的依赖表里不再有它） | `Cargo.lock` 的 diff 只有 1 行 |
//! | 前端可写范围 | 从「任意路径」收敛为「**只有用户亲手在原生对话框里选中的那一个文件**」 | 路径不再跨 IPC |
//!
//! 🔴 **但不要指望体积下降 —— 这一条差点被我自己写错，记在这里免得后人再错一次**：
//!    `tauri-plugin-fs` 是 `tauri-plugin-dialog` 的**传递依赖**
//!    （`Cargo.lock` 里 `tauri-plugin-dialog` 的 `dependencies` 含它就是证据）。
//!    所以删掉直接依赖后，**这个 crate 照样会被编译并链进二进制**。
//!    ⇒ 本次改动的价值在**权限收敛**，不在减体积。想要体积收益得连 dialog 一起换掉，
//!      那需要直接依赖 `rfd`（= 新增依赖，需单独授权），目前不做。
//!
//! ⚠️ `tauri-plugin-dialog` 的 **cargo** 依赖要保留 —— 它提供本文件用到的
//! `DialogExt`。删掉的只是它在**前端**的那一半（npm 包 + capability 放行）。
//!
//! ## 为什么必须 `spawn_blocking`
//!
//! `blocking_save_file()` 会阻塞当前线程直到用户做出选择（可能几分钟）。
//! 在异步命令里直接调用会占住 async runtime 的工作线程。
//! 更要紧的是它**不能在主线程上调用**（会与窗口消息循环互相等待）。
//! `spawn_blocking` 把它挪到阻塞线程池，两个问题一起回避 ——
//! 这与 `packs.rs::pack_download` 的做法一致。

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 把前端递来的「建议文件名」洗成一个**纯文件名**。
///
/// ‼️ 它不参与真正的路径拼接（路径来自对话框），所以这里**不是**安全边界，
///    只是「别让用户看到一个诡异的默认名」的卫生措施：
///    · 去掉 `C:\x\y` / `../../y` 这类前缀，只留最后一段
///    · 去掉 Windows 文件名里非法或会被误解析的字符
///    · 洗空之后回落到一个确定的默认名，绝不让对话框拿到空字符串
fn safe_suggested_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();

    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\u{0}'))
        .filter(|c| !c.is_control())
        .collect();

    if cleaned.is_empty() {
        "export.csv".to_string()
    } else {
        cleaned
    }
}

/// 弹原生「另存为」对话框，并把 `contents` 写到用户选中的文件。
///
/// 返回值与前端约定：
///   · `Ok(None)`         —— 用户取消（**不是错误**，不该弹报错提示）
///   · `Ok(Some(path))`   —— 已写入，`path` 仅用于回显提示
///   · `Err(错误码串)`    —— 失败，错误码交给 `friendlyError` 那个思路翻译
///
/// ⚠️ 这里**不做** `.csv` 后缀强制：加了 `add_filter("CSV", ["csv"])` 之后，
///    系统对话框自己会补后缀；再强制一次反而会覆盖用户在对话框里显式输入的扩展名。
/// 先写同目录的 .tmp、fsync、再原子改名。
///
/// 🔴 为什么不直接 `std::fs::write(&path, ...)`：用户选的多半是一个**已存在的文件**
///    （导出就是覆盖），而 `write` 会先把目标截断 —— 磁盘满 / 进程被杀 / 杀软拦截时
///    留下的是「半截新内容 + 原内容已丢」，两头都没有，且不可恢复。
///    临时文件 + 改名保证目标要么是完整的旧文件、要么是完整的新文件。
/// ⚠️ 临时文件必须与目标**同目录**：`rename` 只在同一个卷内才是原子的。
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    // 上一次失败可能留下 .tmp，先清掉，避免撞上一个只读残留
    let _ = fs::remove_file(&tmp);

    fs::write(&tmp, bytes).map_err(|e| format!("IO_ERROR: 写入 {} 失败: {e}", tmp.display()))?;

    // ‼️ 先 fsync 再改名：否则断电后可能出现「名字已就位、内容还在页缓存里」的空文件。
    if let Err(e) = OpenOptions::new().read(true).write(true).open(&tmp).and_then(|f| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("IO_ERROR: 同步 {} 失败: {e}", tmp.display()));
    }

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("IO_ERROR: 无法把 {} 改名为 {}: {e}", tmp.display(), path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub async fn export_csv_file(
    app: AppHandle,
    file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let suggested = safe_suggested_name(&file_name);
    let app_for_task = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app_for_task
            .dialog()
            .file()
            .set_file_name(&suggested)
            .add_filter("CSV", &["csv"])
            .blocking_save_file();

        // 用户点了取消 —— 静默返回，不当作错误
        let Some(file_path) = chosen else {
            return Ok(None);
        };

        let path: PathBuf = file_path
            .into_path()
            .map_err(|e| format!("BAD_PATH: 无法解析所选路径: {e}"))?;

        write_atomically(&path, contents.as_bytes())?;

        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("JOIN_ERROR: 导出任务异常: {e}"))?
}

/// 供 `cargo test` 直接验证的纯函数（不弹对话框、不碰文件系统）。
///
/// ⚠️ 测试函数名用 ASCII：非 ASCII 标识符虽然没有大小写，但会触发
///    `non_snake_case` 警告 —— 一旦有人加 `-D warnings` 就会失败。
#[cfg(test)]
mod tests {
    use super::{safe_suggested_name, write_atomically};
    use std::fs;
    use std::path::PathBuf;

    /// 造一个独立的临时目录：覆盖写盘这件事必须真的落盘才算验证过。
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // ‼️ 不用 std::env::temp_dir()：受限沙箱里子进程对 %TEMP% 只有拒绝访问（os error 5），
        //    测试会整片假失败；crate 的 target/ 必定可写（cargo 自己就在写），也随构建一起被清掉。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("gpg-export-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 路径分隔符在前后都出现时，只留最后一段。
    #[test]
    fn strips_path_prefix() {
        assert_eq!(safe_suggested_name(r"C:\tmp\a.csv"), "a.csv");
        assert_eq!(safe_suggested_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_suggested_name("/var/tmp/x.csv"), "x.csv");
    }

    /// 非法字符与首尾空白都要清掉。
    #[test]
    fn removes_illegal_chars() {
        assert_eq!(safe_suggested_name("a:b*c?.csv"), "abc.csv");
        assert_eq!(safe_suggested_name("  x.csv  "), "x.csv");
    }

    /// 洗成空串时必须有确定回落值 —— 绝不让对话框拿到空名字。
    #[test]
    fn falls_back_on_empty() {
        assert_eq!(safe_suggested_name(""), "export.csv");
        assert_eq!(safe_suggested_name("   "), "export.csv");
        assert_eq!(safe_suggested_name("///"), "export.csv");
        assert_eq!(safe_suggested_name(":::"), "export.csv");
    }

    /// 正常的中文文件名字与日期原样保留（这是实际用到的默认名形态）。
    #[test]
    fn keeps_normal_chinese_name() {
        assert_eq!(
            safe_suggested_name("当前视野电厂_z8_2026-09-18.csv"),
            "当前视野电厂_z8_2026-09-18.csv"
        );
    }

    /// R8：覆盖导出必须是原子的 —— 目标换成新内容，且不残留 .tmp。
    #[test]
    fn write_atomically_overwrites_existing_file_and_leaves_no_tmp() {
        let dir = tmp_dir("ok");
        let path = dir.join("out.csv");
        fs::write(&path, b"old,content\n").unwrap();

        write_atomically(&path, b"new,content\n").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new,content\n", "必须原子地换成新内容");
        assert!(!dir.join("out.csv.tmp").exists(), "不该残留 .tmp");
        let _ = fs::remove_dir_all(&dir);
    }

    /// R8：失败路径不能把原文件带走 —— 目录不存在时应当报错且什么都不留下。
    #[test]
    fn write_atomically_fails_cleanly_on_missing_directory() {
        let dir = tmp_dir("fail");
        let path = dir.join("nope").join("out.csv");

        let err = write_atomically(&path, b"x\n").expect_err("目录不存在时必须失败");

        assert!(
            err.starts_with("IO_ERROR"),
            "错误码必须仍是 IO_ERROR（前端按它翻译），实际：{err}"
        );
        assert!(!path.exists(), "失败时不该产生目标文件");
        let _ = fs::remove_dir_all(&dir);
    }
}
