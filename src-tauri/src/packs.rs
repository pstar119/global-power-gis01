//! 阶段44：区域数据包的下载与落盘。
//!
//! # 为什么下载放在 Rust 侧，而不是前端 `fetch`
//!
//! 实测（2026-09-15，对照实验）：
//! ```text
//! GET api.github.com/...                       → Access-Control-Allow-Origin: *
//! GET github.com/.../releases/download/...     → 302，无任何 access-control-* 头
//!   └→ release-assets.githubusercontent.com    → 206 Partial Content，
//!                                                Accept-Ranges: bytes ✅
//!                                                但同样没有任何 ACAO ❌
//! ```
//! Range **完全可用**（断点续传没问题），但跨域响应 **JS 读不到** —— 浏览器会直接拦截。
//! 所以「前端 `fetch` + `ReadableStream` 写盘」这条路在架构上不成立。
//!
//! 放在 Rust 还有三个额外好处：
//! 1. 163 MB 不必过 IPC（否则每块都要序列化，吞吐与内存都很糟）
//! 2. SHA256 可以**流式**计算，内存占用 O(1)
//! 3. WebView 从不直连 GitHub ⇒ **CSP 不需要放宽**
//!
//! # 断点续传的机制
//!
//! ```text
//! 目标  {packs_dir}/osm-huadong.pmtiles
//! 中间  {packs_dir}/osm-huadong.pmtiles.part     ← 固定文件名，才能跨进程续传
//! ```
//! `.part` 的**文件长度**就是断点位置 —— 不额外维护元数据，因为文件系统本身就是
//! 最可靠的记录：断电/被杀时它反映的是**真正落盘**的字节数。
//! ⚠️ 绝不能用「已下载 X 字节」这种内存或旁路文件记进度，那种记录会在崩溃时撒谎。
//!
//! # 事务性
//!
//! 只有「长度正确 + SHA256 匹配」的完整文件才会被 `rename` 成正式名。
//! 任何失败路径都**只删 `.part`**，已有的正式文件一动不动 —— 宁可保留旧版本，
//! 也不能让损坏文件进入运行目录。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 构造带**显式 TLS provider** 的 Agent。
///
/// 🔴 这个函数存在的唯一原因是一个极易中招的陷阱（我用真机测试才撞到）：
///
/// `ureq` 的 `TlsProvider` 枚举默认值是 `Rustls`，而这个默认值
/// **与启用哪些 feature 完全无关** —— 它的文档注释原文是：
/// ```text
/// Requires the feature flag **native-tls** and that using an Agent with this
/// config option set in the TlsConfig.
/// The setting is never picked up automatically.
/// ```
/// 也就是说：只写 `features = ["native-tls"]` 而**不显式设置 provider**，
/// 运行时会走到「provider 是 Rustls，但 rustls feature 没启用」的校验分支，
/// 直接 panic：
/// ```text
/// uri scheme is https, provider is Rustls but feature is not enabled: rustls
/// ```
/// ⚠️ 这个错误**只在真正发起 HTTPS 请求时**才暴露 —— 用 `http://` 的本地
/// 测试服务器验证是**抓不到**的（我当时就是这么漏掉的）。
/// 下面的 `tls_provider_is_native_tls` 测试就是为了把这个洞封死。
fn build_agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .build()
        .into()
}

/// 每块读取大小。1 MB 在「系统调用次数」与「单次阻塞时长」之间取平衡。
const CHUNK: usize = 1024 * 1024;

/// 进度上报节流：最短间隔与最小增量，二者**任一**满足才发一次。
/// 不发节流的话 163 MB 会产生上千次 IPC，反而拖慢下载。
const PROGRESS_MIN_INTERVAL_MS: u128 = 150;
const PROGRESS_MIN_DELTA: u64 = 4 * 1024 * 1024;

/// 数据包目录名（位于应用数据目录之下）
const PACKS_SUBDIR: &str = "packs";
/// 未完成下载的后缀
const PART_SUFFIX: &str = ".part";

/// 正在下载中的文件名。用 `Vec` 而不是 `HashSet`：`Vec::new()` 是 const fn，
/// 可以直接用于 `static`，不必引入 `OnceLock` 或 `LazyLock`。
static IN_FLIGHT: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 被请求取消的文件名。下载循环每块检查一次。
static CANCEL_REQUESTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 推送给前端的进度事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file: String,
    pub received: u64,
    pub total: u64,
    pub percent: f64,
}

/// 单个包的落盘状态，供「数据包管理」面板展示。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileStatus {
    pub file: String,
    /// 正式文件是否存在
    pub exists: bool,
    /// 正式文件的字节数（不存在为 0）
    pub bytes: u64,
    /// `.part` 的字节数（>0 表示有一次可续传的未完成下载）
    pub part_bytes: u64,
}

/// 下载请求参数。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackDownloadRequest {
    /// 文件名，如 `osm-huadong.pmtiles`（**不含路径**，不接受前端传路径进来）
    pub file: String,
    pub url: String,
    /// 期望的 SHA256（小写十六进制）
    pub sha256: String,
    /// 期望的字节数，用于「断点比目标还长」的判定与提前分配
    pub bytes: u64,
}

/// 解析数据包目录，并确保它存在。
///
/// ‼️ 用 `app_data_dir()` 而不是 `$RESOURCE`：安装到 `C:\Program Files` 时
/// 资源目录是**只读**的，往那里写数据会直接失败。
/// Windows 上 `app_data_dir()` = `app_config_dir()` = `%APPDATA%\<identifier>`，
/// 所以数据包与 SQLite 数据库同处一棵树，清理与备份只需照顾一个目录。
pub fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("DIR_ERROR: 无法解析应用数据目录: {e}"))?
        .join(PACKS_SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("DIR_ERROR: 无法创建 {dir:?}: {e}"))?;
    Ok(dir)
}

/// 把 `file` 规范化成**安全的纯文件名**。
///
/// 前端传来的字符串会直接参与路径拼接，必须挡住 `..\`、`/`、盘符等，
/// 否则等于给前端一个任意写文件的能力。
fn safe_file_name(file: &str) -> Result<String, String> {
    let bad = file.is_empty()
        || file.contains("..")
        || file.contains('/')
        || file.contains('\\')
        || file.contains(':')
        || !file.ends_with(".pmtiles");
    if bad {
        return Err(format!("BAD_FILE_NAME: 非法文件名 {file:?}"));
    }
    Ok(file.to_string())
}

fn is_in_flight(file: &str) -> bool {
    IN_FLIGHT.lock().map(|v| v.iter().any(|f| f == file)).unwrap_or(false)
}

fn mark_in_flight(file: &str) {
    if let Ok(mut v) = IN_FLIGHT.lock() {
        if !v.iter().any(|f| f == file) {
            v.push(file.to_string());
        }
    }
}

fn clear_in_flight(file: &str) {
    if let Ok(mut v) = IN_FLIGHT.lock() {
        v.retain(|f| f != file);
    }
}

fn take_cancel(file: &str) -> bool {
    match CANCEL_REQUESTED.lock() {
        Ok(mut v) => {
            let had = v.iter().any(|f| f == file);
            v.retain(|f| f != file);
            had
        }
        Err(_) => false,
    }
}

/// 前端请求取消某个包的下载。
///
/// 注意：取消**不删** `.part` —— 那正是下次续传的起点。
#[tauri::command]
pub fn pack_cancel(file: String) -> Result<(), String> {
    let file = safe_file_name(&file)?;
    if let Ok(mut v) = CANCEL_REQUESTED.lock() {
        if !v.iter().any(|f| f == &file) {
            v.push(file);
        }
    }
    Ok(())
}

/// 返回数据包目录的**绝对路径**，供前端拼 `convertFileSrc` 用。
///
/// 前端不自己算这个路径（`appDataDir()` 是另一套算法），避免两边不一致。
#[tauri::command]
pub fn pack_dir(app: AppHandle) -> Result<String, String> {
    packs_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

/// 查询若干包的落盘状态（正式文件 + 未完成的 `.part`）。
#[tauri::command]
pub fn pack_status(app: AppHandle, files: Vec<String>) -> Result<Vec<PackFileStatus>, String> {
    let dir = packs_dir(&app)?;
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let file = safe_file_name(&file)?;
        let bytes = fs::metadata(dir.join(&file)).map(|m| m.len()).unwrap_or(0);
        let part_bytes = fs::metadata(dir.join(format!("{file}{PART_SUFFIX}")))
            .map(|m| m.len())
            .unwrap_or(0);
        out.push(PackFileStatus {
            file,
            exists: bytes > 0,
            bytes,
            part_bytes,
        });
    }
    Ok(out)
}

/// 删除一个**已下载**的包（含残留的 `.part`）。
#[tauri::command]
pub fn pack_remove(app: AppHandle, file: String) -> Result<(), String> {
    let file = safe_file_name(&file)?;
    if is_in_flight(&file) {
        return Err(format!("BUSY: {file} 正在下载中，请先取消"));
    }
    let dir = packs_dir(&app)?;
    for name in [file.clone(), format!("{file}{PART_SUFFIX}")] {
        let p = dir.join(&name);
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("IO_ERROR: 无法删除 {p:?}: {e}"))?;
        }
    }
    Ok(())
}

/// 下载一个数据包（可断点续传）。
///
/// 命令本身是 `async`，但真正的 IO 在 `spawn_blocking` 里跑 —— 否则会堵住
/// Tauri 的异步运行时，界面（包括进度事件）都会卡住。
#[tauri::command]
pub async fn pack_download(
    app: AppHandle,
    req: PackDownloadRequest,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_blocking(&app, &req, &on_progress))
        .await
        .map_err(|e| format!("JOIN_ERROR: 下载任务异常: {e}"))?
}

fn download_blocking(
    app: &AppHandle,
    req: &PackDownloadRequest,
    progress: &Channel<DownloadProgress>,
) -> Result<(), String> {
    let dir = packs_dir(app)?;
    // 把 Channel 适配成普通闭包，让核心逻辑不依赖 Tauri 类型。
    let sink = |file: &str, received: u64, total: u64, force: bool| {
        emit_progress(progress, file, received, total, force);
    };
    download_pack_to_dir(&dir, req, &sink)
}

/// 下载核心：**只依赖目录**，不依赖 `AppHandle` / `Channel`，
/// 因此单元测试可以直接对着本地 HTTP 服务器跑，不必启动 GUI。
fn download_pack_to_dir<P>(dir: &Path, req: &PackDownloadRequest, progress: &P) -> Result<(), String>
where
    P: Fn(&str, u64, u64, bool),
{
    let file = safe_file_name(&req.file)?;
    let final_path = dir.join(&file);
    let part_path = dir.join(format!("{file}{PART_SUFFIX}"));

    if is_in_flight(&file) {
        return Err(format!("BUSY: {file} 已在下载中"));
    }
    let _ = take_cancel(&file);
    mark_in_flight(&file);
    let result = download_inner(&file, &final_path, &part_path, req, progress);
    clear_in_flight(&file);
    result
}

fn download_inner<P>(
    file: &str,
    final_path: &PathBuf,
    part_path: &PathBuf,
    req: &PackDownloadRequest,
    progress: &P,
) -> Result<(), String>
where
    P: Fn(&str, u64, u64, bool),
{
    // 断点位置 = `.part` 的真实长度。
    // ⚠️ 超过目标长度说明文件被改小过（或上次写坏），必须作废重下，
    //    否则 Range 会返回 416，或拼出一个长度对但内容错的文件。
    let mut offset = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
    if offset > req.bytes {
        eprintln!("[packs] {file}: .part 长度 {offset} 超过目标 {}，作废重下", req.bytes);
        let _ = fs::remove_file(part_path);
        offset = 0;
    }

    // 流式哈希必须**从头**建立：先把已有 `.part` 的内容喂进去，
    // 这样续传结束后得到的是整文件的摘要。
    let mut hasher = Sha256::new();
    if offset > 0 {
        let mut f = File::open(part_path).map_err(|e| format!("IO_ERROR: 无法读取 {part_path:?}: {e}"))?;
        let mut buf = vec![0u8; CHUNK];
        let mut fed = 0u64;
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("IO_ERROR: 读取断点失败: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            fed += n as u64;
        }
        // 若读到的比 metadata 少（并发写），以实际读到的为准
        offset = fed;
        println!("[packs] {file}: 从断点 {offset} 字节续传");
    }

    let total = if req.bytes > 0 { req.bytes } else { offset };
    progress(file, offset, total, true);

    if offset < req.bytes || req.bytes == 0 {
        let agent = build_agent();
        let range = format!("bytes={offset}-");
        let resp = agent
            .get(&req.url)
            .header("Range", &range)
            .call()
            .map_err(|e| describe_ureq_error(&file, offset, e))?;

        let status = resp.status().as_u16();
        // 只接受 206。200 意味着服务器**忽略了 Range**，那会从头返回整个文件 ——
        // 此时若直接 append 就会把文件拼坏，必须 truncate 重来。
        let append = match status {
            206 => {
                let start_ok = resp
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range_start);
                match start_ok {
                    Some(s) if s == offset => true,
                    Some(s) => {
                        eprintln!("[packs] {file}: Content-Range 起点 {s} != 断点 {offset}，作废重下");
                        false
                    }
                    None => {
                        eprintln!("[packs] {file}: 206 但缺少可解析的 Content-Range，作废重下");
                        false
                    }
                }
            }
            200 => {
                eprintln!("[packs] {file}: 服务器忽略 Range（返回 200），作废重下");
                false
            }
            other => {
                return Err(format!("HTTP_ERROR: {file} 返回 HTTP {other}"));
            }
        };

        if !append {
            let _ = fs::remove_file(part_path);
            offset = 0;
            hasher = Sha256::new();
            // 重下一次：这次不带 Range，等价于从 0 开始
            let retry = build_agent()
                .get(&req.url)
                .call()
                .map_err(|e| describe_ureq_error(file, 0, e))?;
            let st = retry.status().as_u16();
            if st != 200 && st != 206 {
                return Err(format!("HTTP_ERROR: {file} 重下返回 HTTP {st}"));
            }
            stream_to_part(
                file,
                retry.into_body().into_reader(),
                part_path,
                offset,
                req,
                progress,
                &mut hasher,
                true,
            )?;
        } else {
            stream_to_part(
                file,
                resp.into_body().into_reader(),
                part_path,
                offset,
                req,
                progress,
                &mut hasher,
                false,
            )?;
        }
    }

    // ---- 校验 ----
    let actual_len = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
    let want_len = if req.bytes > 0 { req.bytes } else { actual_len };
    if actual_len != want_len {
        return Err(format!(
            "SIZE_MISMATCH: {file} 期望 {want_len} 字节，实际 {actual_len} 字节（已保留 .part 以便续传）"
        ));
    }
    let digest = format!("{:x}", hasher.finalize());
    if !req.sha256.is_empty() && !digest.eq_ignore_ascii_case(&req.sha256) {
        // 🔴 损坏的文件绝不能进入运行目录：删掉 .part，正式文件保持原样。
        let _ = fs::remove_file(part_path);
        return Err(format!(
            "CHECKSUM_MISMATCH: {file} SHA256 不符（期望 {}…，实际 {}…）",
            &req.sha256[..req.sha256.len().min(12)],
            &digest[..12]
        ));
    }

    // ---- 原子落位 ----
    // Windows 上 std::fs::rename 会覆盖同名目标（底层用 MOVEFILE_REPLACE_EXISTING）。
    fs::rename(part_path, final_path)
        .map_err(|e| format!("IO_ERROR: 无法把 {part_path:?} 改名为 {final_path:?}: {e}"))?;

    progress(file, actual_len, actual_len, true);
    println!("[packs] {file}: 下载完成并校验通过（{actual_len} 字节，sha256={})", &digest[..12]);
    Ok(())
}
/// 把响应体逐块写入 `.part`，同时喂给哈希并上报进度。
///
/// ‼️ 收 `impl Read` 而不是 `http::Response<Body>` —— `http` 不是本项目的直接依赖，
///    写具体类型就得额外加一个 crate。调用方传 `resp.into_body().into_reader()` 即可。
#[allow(clippy::too_many_arguments)]
fn stream_to_part<R: Read, P>(
    file: &str,
    mut reader: R,
    part_path: &PathBuf,
    start_offset: u64,
    req: &PackDownloadRequest,
    progress: &P,
    hasher: &mut Sha256,
    truncate: bool,
) -> Result<(), String>
where
    P: Fn(&str, u64, u64, bool),
{
    let mut out = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(part_path)
        .map_err(|e| format!("IO_ERROR: 无法打开 {part_path:?}: {e}"))?;

    let mut buf = vec![0u8; CHUNK];
    let mut received = start_offset;
    let total = if req.bytes > 0 { req.bytes } else { 0 };
    let mut last_emit = Instant::now();
    let mut last_bytes = received;

    loop {
        if take_cancel(file) {
            let _ = out.flush();
            return Err(format!("CANCELLED: {file} 已取消（.part 保留，可续传）"));
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("NETWORK_ERROR: 读取响应失败: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("IO_ERROR: 写盘失败（磁盘空间不足？）: {e}"))?;
        hasher.update(&buf[..n]);
        received += n as u64;

        let due = last_emit.elapsed().as_millis() >= PROGRESS_MIN_INTERVAL_MS
            || received - last_bytes >= PROGRESS_MIN_DELTA;
        if due {
            progress(file, received, total, false);
            last_emit = Instant::now();
            last_bytes = received;
        }
    }
    out.flush().map_err(|e| format!("IO_ERROR: flush 失败: {e}"))?;
    progress(file, received, total, true);
    Ok(())
}

fn emit_progress(progress: &Channel<DownloadProgress>, file: &str, received: u64, total: u64, force: bool) {
    if !force && total == 0 {
        return;
    }
    let percent = if total > 0 {
        (received as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = progress.send(DownloadProgress {
        file: file.to_string(),
        received,
        total,
        percent,
    });
}

/// 从 `bytes 100-999/1000` 里取出起点 100。
fn parse_content_range_start(v: &str) -> Option<u64> {
    let rest = v.strip_prefix("bytes ")?;
    let (range, _) = rest.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    start.trim().parse().ok()
}

/// 把 ureq 的错误翻译成带类型前缀的中文说明，前端据此展示重试提示。
fn describe_ureq_error(file: &str, offset: u64, e: ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(416) => format!(
            "RANGE_NOT_SATISFIABLE: {file} 服务器拒绝 Range（断点 {offset} 无效），请重试"
        ),
        ureq::Error::StatusCode(code) => format!("HTTP_ERROR: {file} 返回 HTTP {code}"),
        ureq::Error::Timeout(_) => format!("TIMEOUT: {file} 请求超时（断点 {offset} 已保留）"),
        ureq::Error::Io(io) => format!("NETWORK_ERROR: {file} 网络错误: {io}（断点 {offset} 已保留）"),
        other => format!("NETWORK_ERROR: {file} 请求失败: {other:?}（断点 {offset} 已保留）"),
    }
}

// ============================================================================
// 测试
// ============================================================================
//
// ‼️ 用**自建的本地 HTTP 服务器**而不是真网络，原因有三：
//   1. 需要**故意**模拟「服务器忽略 Range 返回 200」（真实 CDN 不会配合演出）
//   2. 需要故意返回**错误字节**来验证校验失败路径
//   3. 不依赖外网，CI 与离线环境都能跑
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// 极小的 HTTP/1.1 服务器，只实现下载器用到的那部分。
    struct TestServer {
        port: u16,
        /// 服务器实际收到的 Range 起始值（没收到 Range 时为 None）
        seen_range_start: Arc<Mutex<Option<u64>>>,
        range_request_count: Arc<AtomicU64>,
    }

    impl TestServer {
        fn url(&self, name: &str) -> String {
            format!("http://127.0.0.1:{}/{name}", self.port)
        }
    }

    fn start_server(body: Vec<u8>, honour_range: bool) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(None));
        let count = Arc::new(AtomicU64::new(0));
        let (seen2, count2) = (seen.clone(), count.clone());

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let body = body.clone();
                let (seen, count) = (seen2.clone(), count2.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(s.try_clone().expect("clone 失败"));
                    let mut line = String::new();
                    let _ = reader.read_line(&mut line);
                    let mut range_start: Option<u64> = None;
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("range: bytes=") {
                            range_start = v.trim().split('-').next().and_then(|n| n.parse().ok());
                        }
                    }

                    let start = range_start.unwrap_or(0);
                    if range_start.is_some() {
                        count.fetch_add(1, Ordering::SeqCst);
                        *seen.lock().unwrap() = range_start;
                    }

                    let total = body.len() as u64;
                    if honour_range && range_start.is_some() && start < total {
                        let tail = &body[start as usize..];
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\n\
                             Accept-Ranges: bytes\r\nContent-Range: bytes {}-{}/{}\r\n\r\n",
                            tail.len(),
                            start,
                            total - 1,
                            total
                        );
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(tail);
                    } else {
                        // 忽略 Range：始终从头返回 200
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                            total
                        );
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(&body);
                    }
                    let _ = s.flush();
                });
            }
        });

        TestServer { port, seen_range_start: seen, range_request_count: count }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    /// 伪随机但可重复的内容 —— 刻意不用全零，否则「写到一半截断」这类 bug 也能通过。
    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i * 31 + 7) % 251) as u8).collect()
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gpg-packs-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(file: &str, url: String, bytes: &[u8]) -> PackDownloadRequest {
        PackDownloadRequest {
            file: file.to_string(),
            url,
            sha256: sha256_hex(bytes),
            bytes: bytes.len() as u64,
        }
    }

    fn noop(_: &str, _: u64, _: u64, _: bool) {}

    #[test]
    fn fresh_download_lands_with_correct_hash() {
        let body = payload(300 * 1024);
        let srv = start_server(body.clone(), true);
        let dir = tmp_dir("fresh");

        download_pack_to_dir(&dir, &request("a.pmtiles", srv.url("a.pmtiles"), &body), &noop)
            .expect("首次下载应当成功");

        let got = fs::read(dir.join("a.pmtiles")).unwrap();
        assert_eq!(got, body, "落盘内容必须与源一致");
        assert!(!dir.join("a.pmtiles.part").exists(), "完成后不应残留 .part");
        // ‼️ 首次下载**也会**发 `Range: bytes=0-`，这是刻意的：让服务器用 206/200
        //    明确告知它是否支持 Range，后续断点续传才有确定的依据。
        //    （我最初把断言写成「不发 Range」，是**断言错了**而不是代码错了。）
        assert_eq!(
            *srv.seen_range_start.lock().unwrap(),
            Some(0),
            "首次下载应从 0 发 Range（用于探测服务器是否支持 Range）"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resumes_from_existing_part_and_only_fetches_tail() {
        let body = payload(300 * 1024);
        let srv = start_server(body.clone(), true);
        let dir = tmp_dir("resume");
        let cut = 100 * 1024usize;

        // 模拟「上次下到一半被关掉」：手工放一个前 100 KB 的 .part
        fs::write(dir.join("b.pmtiles.part"), &body[..cut]).unwrap();

        download_pack_to_dir(&dir, &request("b.pmtiles", srv.url("b.pmtiles"), &body), &noop)
            .expect("续传应当成功");

        assert_eq!(fs::read(dir.join("b.pmtiles")).unwrap(), body, "续传结果必须完整正确");
        assert_eq!(
            *srv.seen_range_start.lock().unwrap(),
            Some(cut as u64),
            "必须从断点处发起 Range，而不是从头下"
        );
        assert_eq!(
            srv.range_request_count.load(Ordering::SeqCst),
            1,
            "续传应当一次 Range 请求搞定（发第二次说明它偷偷从头重下了）"
        );
        assert!(!dir.join("b.pmtiles.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_ignoring_range_still_yields_correct_file() {
        // 关键回归：服务器返回 200（忽略 Range）时，绝不能把整个响应 append 到 .part 上，
        // 否则会拼出一个「长度对但内容错」的文件，而且哈希也救不回来（长度会被校验挡住，
        // 但更糟的情况是长度恰好凑对）。
        let body = payload(200 * 1024);
        let srv = start_server(body.clone(), false); // ← 故意不理会 Range
        let dir = tmp_dir("norange");
        fs::write(dir.join("c.pmtiles.part"), &body[..80 * 1024]).unwrap();

        download_pack_to_dir(&dir, &request("c.pmtiles", srv.url("c.pmtiles"), &body), &noop)
            .expect("服务器忽略 Range 时应当作废重下并成功");

        assert_eq!(fs::read(dir.join("c.pmtiles")).unwrap(), body, "必须截断重下，不能拼接");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_payload_is_rejected_and_part_discarded() {
        let body = payload(120 * 1024);
        let mut wrong = body.clone();
        wrong[50 * 1024] ^= 0xff; // 只改一个字节，长度完全不变
        let srv = start_server(wrong, true);
        let dir = tmp_dir("corrupt");

        // 期望的哈希来自**正确**内容，服务器却返回被篡改的内容
        let req = request("d.pmtiles", srv.url("d.pmtiles"), &body);
        let err = download_pack_to_dir(&dir, &req, &noop).expect_err("校验必须失败");

        assert!(err.starts_with("CHECKSUM_MISMATCH"), "错误码必须是 CHECKSUM_MISMATCH，实际：{err}");
        assert!(!dir.join("d.pmtiles").exists(), "损坏文件绝不能进入运行目录");
        assert!(!dir.join("d.pmtiles.part").exists(), "损坏的 .part 必须被删除");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_path_traversal_file_names() {
        let body = payload(1024);
        let srv = start_server(body.clone(), true);
        let dir = tmp_dir("traversal");
        for bad in ["../evil.pmtiles", "a/b.pmtiles", "c:\\d.pmtiles", "noext"] {
            let req = request(bad, srv.url("x.pmtiles"), &body);
            let err = download_pack_to_dir(&dir, &req, &noop).expect_err("非法文件名必须被拒");
            assert!(err.starts_with("BAD_FILE_NAME"), "{bad} 的错误码应为 BAD_FILE_NAME，实际：{err}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// 🔴 回归防护：断言我们**显式**把 TLS provider 设成了 NativeTls。
    ///
    /// 这个断言存在的理由：ureq 的 `TlsProvider` 默认值是 `Rustls`，而该默认值
    /// **不随 feature 变化**。只启用 `native-tls` feature 而不显式设置 provider，
    /// 真正发 HTTPS 时会 panic（`provider is Rustls but feature is not enabled`）。
    ///
    /// ‼️ 这个断言能挡住「忘记显式设置」，但挡不住「设置错了后端」——
    ///    那种只能靠下面的 HTTPS 冒烟测试。
    #[test]
    fn tls_provider_is_explicitly_native_tls() {
        let agent = build_agent();
        assert_eq!(
            agent.config().tls_config().provider(),
            ureq::tls::TlsProvider::NativeTls,
            "必须显式设置 provider=NativeTls（ureq 默认是 Rustls，且不随 feature 变化）"
        );
    }

    /// 真发一次 HTTPS。默认 `#[ignore]`，**手动执行**：
    ///
    /// ```text
    /// cargo test --lib packs::tests::https_smoke -- --ignored --nocapture
    /// ```
    ///
    /// ‼️ 为什么需要一个「真的联网」的测试：上面那条断言只证明**配置写对了**，
    ///    证明不了 TLS 后端真能建立连接。而这个 bug 的症状恰好是
    ///    **只在发起 HTTPS 请求时才暴露** —— 用 http:// 的本地服务器
    ///    做端到端验证是抓不到的（我第一轮验证就是这么漏掉的）。
    ///    默认 ignore 是为了不给 CI / 离线环境引入网络依赖。
    #[test]
    #[ignore = "需要外网；手动验证 TLS 后端是否真的能建立 HTTPS 连接"]
    fn https_smoke_reaches_server() {
        let agent = build_agent();
        match agent.get("https://api.github.com/").call() {
            Ok(r) => assert_eq!(r.status().as_u16(), 200, "GitHub API 应当返回 200"),
            // 能拿到 HTTP 状态码本身就说明 TLS 握手已成功
            Err(ureq::Error::StatusCode(code)) => {
                assert!(code > 0, "收到 HTTP {code} 说明 TLS 已建立，仅状态码非 200");
            }
            Err(e) => panic!("HTTPS 请求失败（TLS 后端很可能没配置好）: {e:?}"),
        }
    }

    /// 真·公网 HTTPS **且带 Range** 的冒烟（手动执行）：
    ///
    /// ```text
    /// cargo test --lib packs::tests::public_https -- --ignored --nocapture
    /// ```
    ///
    /// 🔴 这条测试补的是一个**具体的验证盲点**：我第一轮用本地 `http://` 服务器
    /// 做端到端验证时，HTTPS 分支**从未被执行过**，所以 TLS 配置错误不可能被发现。
    /// 本测试把「HTTPS + 206 + Content-Range 解析」这条真实组合固定下来。
    ///
    /// 用的资产已实测支持 Range（`Accept-Ranges: bytes`、响应 206）。
    /// 只取前 100 字节，不下载整个文件。默认 `#[ignore]`，避免给 CI 引入外网依赖。
    #[test]
    #[ignore = "需要外网；手动验证 HTTPS + Range 的真实组合"]
    fn public_https_range_download_works() {
        const URL: &str = "https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_arm64.zip";
        let agent = build_agent();
        let resp = agent
            .get(URL)
            .header("Range", "bytes=0-99")
            .call()
            .expect("公网 HTTPS + Range 请求失败（TLS 或重定向有问题）");

        assert_eq!(
            resp.status().as_u16(),
            206,
            "服务器应当返回 206 Partial Content（GitHub Release 资产支持 Range）"
        );
        let cr = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .expect("响应应带 Content-Range");
        assert_eq!(
            parse_content_range_start(cr),
            Some(0),
            "Content-Range 起点应为 0，实际 {cr}"
        );
        println!("[packs] 公网 HTTPS + Range 冒烟通过：Content-Range={cr}");
    }
}

