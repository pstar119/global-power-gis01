use tauri::Manager;
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

/// 初始化脚本：**只建三张空表，不插入任何数据**。
/// 迁移由 tauri-plugin-sql 在事务里执行，可安全重复运行。
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_empty_power_tables",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

// ============================================================
// 【阶段13 临时】测试数据播种
//
// TODO: 接入真实数据时必须**整体删除**本节，包括：
//   1) 下面的 seed_test_points 命令
//   2) run() 里 generate_handler! 中的 seed_test_points 注册
//   3) 前端 src/pages/MapPage.tsx 里的 invoke("seed_test_points") 调用点
//   4) src/components/DbSelfCheck.tsx 里的 non_test 红线守卫（可保留，但语义要改）
//
// 为什么不用迁移（migration）播种：
//   sqlx 会记录已应用迁移的校验和，日后删除那个迁移文件会让**已有数据库**
//   在启动时报校验和不匹配。而本段代码的明确要求就是"后续必须能彻底移除"。
// ============================================================

/// 仅在 `power_plants` 为空时插入 3 条明确标记为测试用途的假数据。
///
/// 返回本次实际插入的条数；表非空时返回 0（**幂等**，不会重复插入）。
/// 所有数据均带 `Test` 前缀与 `TEST` 国家标记，且 `capacity_mw` 故意留空，
/// 以免被误当成真实电力数据。
#[tauri::command]
async fn seed_test_points(app: tauri::AppHandle) -> Result<u32, String> {
    // 复用插件已经建好的连接池，不另开连接（因此调用前前端必须先 Database.load）
    let instances = app.state::<tauri_plugin_sql::DbInstances>();
    let guard = instances.0.read().await;
    // ⚠️ DbPool 的 `sqlite()` 访问器在插件源码里是被**整块注释掉**的
    // （见 wrapper.rs 的 `/* impl DbPool { ... } */`），所以这里直接匹配它的公开枚举变体。
    let pool = match guard.get(DB_URL) {
        Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool,
        _ => return Err("数据库连接尚未就绪".to_string()),
    };

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM power_plants")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

    if existing > 0 {
        return Ok(0);
    }

    sqlx::query(
        "INSERT INTO power_plants (name, country, capacity_mw, lat, lon) VALUES \
         ('Test Plant A', 'TEST', NULL, 25.0, -40.0), \
         ('Test Plant B', 'TEST', NULL, 35.0,  15.0), \
         ('Test Plant C', 'TEST', NULL,  5.0,  50.0)",
    )
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(3)
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
        .invoke_handler(tauri::generate_handler![greet, seed_test_points])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
