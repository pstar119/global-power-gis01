// ============================================================================
// 【历史存档】阶段13 测试数据播种代码
// ============================================================================
//
// 这段代码原本位于 `src-tauri/src/lib.rs`，作用是：应用启动后向前端的
// `power_plants` 表插入 3 条**明确标记为测试用途**的假数据，用来验证
// 「SQLite → GeoJSON → MapLibre」这条渲染链路是否真的打通。
//
// 阶段14 起，真实数据改由外部导入脚本写入（见 `scripts/import_wri_plants.py`），
// 因此把播种逻辑从生产代码里整体移出，存于此处备查。
//
// ⚠️ 重要：本文件**不在 Cargo 的模块树内**（它在 `src-tauri/src/` 之外），
//    所以它**不会被编译、也不能直接运行** —— 它只是一份历史存档。
//
// 如果日后需要重新播种测试数据（例如数据库被清空后想再验证一次渲染），
// 请按以下三步临时恢复：
//   1. 把本文件里 `seed_test_points` 命令的代码贴回 `lib.rs`
//   2. 在 `lib.rs` 的 `invoke_handler` 里重新注册它
//   3. 在 `Cargo.toml` 里恢复 sqlx 直接依赖（见下方注释）
// 验证完记得再次移除 —— 生产代码里不应残留任何测试数据逻辑。
//
// Cargo.toml 当时需要的依赖声明（sqlx 本就是 tauri-plugin-sql 的传递依赖，
// 提升为直接依赖只是为了能在代码里命名它的类型，不增加编译量）：
//
//     sqlx = { version = "0.8", default-features = false,
//              features = ["runtime-tokio", "sqlite"] }
//
// ----------------------------------------------------------------------------
// 原始代码（逐字保留）
// ----------------------------------------------------------------------------
//
// use tauri::Manager;
//
// /// 仅在 `power_plants` 为空时插入 3 条明确标记为测试用途的假数据。
// ///
// /// 返回本次实际插入的条数；表非空时返回 0（**幂等**，不会重复插入）。
// /// 所有数据均带 `Test` 前缀与 `TEST` 国家标记，且 `capacity_mw` 故意留空，
// /// 以免被误当成真实电力数据。
// #[tauri::command]
// async fn seed_test_points(app: tauri::AppHandle) -> Result<u32, String> {
//     // 复用插件已经建好的连接池，不另开连接（因此调用前前端必须先 Database.load）
//     let instances = app.state::<tauri_plugin_sql::DbInstances>();
//     let guard = instances.0.read().await;
//     // ⚠️ DbPool 的 `sqlite()` 访问器在插件源码里是被**整块注释掉**的
//     // （见 wrapper.rs 的 `/* impl DbPool { ... } */`），所以这里直接匹配它的公开枚举变体。
//     let pool = match guard.get(DB_URL) {
//         Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => pool,
//         _ => return Err("数据库连接尚未就绪".to_string()),
//     };
//
//     let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM power_plants")
//         .fetch_one(pool)
//         .await
//         .map_err(|e| e.to_string())?;
//
//     if existing > 0 {
//         return Ok(0);
//     }
//
//     sqlx::query(
//         "INSERT INTO power_plants (name, country, capacity_mw, lat, lon) VALUES \
//          ('Test Plant A', 'TEST', NULL, 25.0, -40.0), \
//          ('Test Plant B', 'TEST', NULL, 35.0,  15.0), \
//          ('Test Plant C', 'TEST', NULL,  5.0,  50.0)",
//     )
//     .execute(pool)
//     .await
//     .map_err(|e| e.to_string())?;
//
//     Ok(3)
// }
//
// 注册方式（在 lib.rs 的 run() 里）：
//
//     .invoke_handler(tauri::generate_handler![greet, seed_test_points])
//
// 前端调用方式（在 MapPage.tsx 里，必须在 Database.load() 之后）：
//
//     await invoke<number>("seed_test_points");
//
// ============================================================================
