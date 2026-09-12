use std::fs;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

/// 本地 SQLite 数据库。
/// 路径相对 `BaseDirectory::AppConfig`，即 Windows 上的
/// `%APPDATA%\<identifier>\global_power_gis.db`；文件不存在时由 SQLite 自动创建。
///
/// 该基目录与 tauri-plugin-sql 的 wrapper.rs 完全一致（两者都调 app_config_dir），
/// 所以播种写入的位置一定是插件随后要打开的那个文件。
const DB_URL: &str = "sqlite:global_power_gis.db";
const DB_FILE: &str = "global_power_gis.db";

/// 内置种子数据库在 bundle 资源里的相对路径。
/// 目的：让拿到安装包的普通用户第一次启动就有全量电厂数据，
/// 而不需要一个跑着 Python 导入脚本的开发环境。
const SEED_RESOURCE: &str = "seed/global_power_gis.db";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 数据库迁移定义。
///
/// 迁移由 tauri-plugin-sql 在事务里执行，可安全重复运行；
/// sqlx 会记录已应用过的版本号，所以新增迁移不会重跑旧脚本。
///
/// - v1：只建三张空表，不插入任何数据
/// - v2：为接入真实数据源补充 gppd_idnr（唯一）与 primary_fuel 两列
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_empty_power_tables",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_plant_source_and_fuel",
            sql: include_str!("../migrations/002_add_plant_source_and_fuel.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .setup(|app| {
            // 首次运行播种：必须在任何数据库连接建立之前执行。
            //
            // 为什么能做到：tauri.conf.json 里 plugins.sql.preload 为空数组，
            // 插件 setup 不会去 connect 任何库（否则它会抢先 create_database，
            // 建出一个空文件，播种的“文件不存在”判定就永远为假了）。
            // 真正建连发生在前端调用 Database.load()，晚于这里。
            //
            // 播种失败不阻断启动：宁可让用户看到一个空库，
            // 也不要因为一个拷贝错误直接闪退。
            if let Err(err) = seed_database_if_needed(app.handle()) {
                eprintln!("[seed] 跳过播种：{err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 首次运行时，把内置的种子数据库拷到应用数据目录。
///
/// 判定依据是“**目标文件是否存在**”，而不是“表里是否有数据”：
/// - 判断表是否为空必须先打开数据库，而打开就会创建文件，逻辑上自相矛盾；
/// - 那还会导致用户主动清空表后想重新开始时，数据被强行回填。
///
/// 因此：文件已存在就一律不动，已导入过数据的用户不会被覆盖。
fn seed_database_if_needed(app: &AppHandle) -> Result<(), String> {
    let target = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))?
        .join(DB_FILE);

    if target.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录 {parent:?}: {e}"))?;
    }

    let source = app
        .path()
        .resolve(SEED_RESOURCE, BaseDirectory::Resource)
        .map_err(|e| format!("无法定位内置种子数据: {e}"))?;

    fs::copy(&source, &target).map_err(|e| format!("拷贝 {source:?} -> {target:?} 失败: {e}"))?;

    println!("[seed] 已从内置数据初始化数据库: {target:?}");
    Ok(())
}
