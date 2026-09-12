use tauri_plugin_sql::{Migration, MigrationKind};

/// 本地 SQLite 数据库。
/// 路径相对 `BaseDirectory::AppConfig`，即 Windows 上的
/// `%APPDATA%\<identifier>\global_power_gis.db`；文件不存在时由 SQLite 自动创建。
const DB_URL: &str = "sqlite:global_power_gis.db";

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
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
