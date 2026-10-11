use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

mod export;
mod packs;

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

/// SQLite 文件头的 16 字节魔数。
///
/// ‼️ 「播种是否已完成」不能只看目标文件是否存在：一次被中断的拷贝
///    （磁盘满 / 断电 / 杀软拦截）会留下一个**截断的文件**，而它一旦存在，
///    旧逻辑就永远认为播种已完成 —— 全应用再也打不开数据库，
///    用户只能自己去 %APPDATA% 删掉它。所以必须真的看一眼文件内容。
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 数据库迁移定义。
///
/// 迁移由 tauri-plugin-sql 在事务里执行；sqlx 会记录已应用过的版本号，
/// 所以新增迁移不会重跑旧脚本。
///
/// - v1：只建三张空表，不插入任何数据
/// - v2：为接入真实数据源补充 gppd_idnr（唯一）与 primary_fuel 两列
/// - v3：灌入阶段21 的电力网络**演示数据**（200 变电站 / 100 线路）—— 已冻结，见下
/// - v4：清空 v3 遗留的演示行（阶段28 起改用真实 OSM 数据）
/// - v5：为「当前视野统计」的电厂计数加 (lat, lon) 索引（阶段30）
///
/// 🔴 为什么 v3 **不能删**（这是实测 + 读源码换来的结论，别再试一次）：
///
/// 阶段28 的本意是「把演示数据整体移除」，最直觉的做法是把 v3 从下面的列表里删掉、
/// 连 `003_seed_demo_grid.sql` 一起删。**这条路会把整个数据库加载搞挂，而且不报明显错误**：
///
/// 1. sqlx 的 `migrate/migrator.rs::validate_applied_migrations` 有这么一段：
///
///    ```text
///    if migrator.ignore_missing { return Ok(()); }
///    let migrations: HashSet<_> = migrator.iter().map(|m| m.version).collect();
///    ... return Err(MigrateError::VersionMissing(applied.version));
///    ```
///
///    ⚠️ 语言标记必须保持 `text`，**不要改成 `rust`**：这是一段为了说明问题而
///    **故意省略**的源码（用了 `...` 占位），标成 `rust` 会被 `cargo test`
///    的 doctest 拿去真编译，直接报 `unexpected token: ...` 等一堆错。
///    （实测：本阶段 `cargo test` 就是因为这两处一直失败。）
///    而 `ignore_missing` **默认为 false**（`tauri-plugin-sql` 也没有暴露这个开关）。
///    于是「数据库里有 v3、列表里没有 v3」= `pool.migrate()` 直接返回 Err。
/// 2. 插件的 `commands.rs::load` 是：
///
///    ```text
///    if let Some(m) = migrations.0.lock().await.remove(&db) {
///        let migrator = Migrator::new(m).await?;
///        pool.migrate(&migrator).await?;   // ← 这里报错就直接 return
///    }
///    db_instances.0.write().await.insert(db.clone(), pool);  // ← 根本执行不到
///    ```
///
///    （同样保持 `text` —— 这段依赖外部上下文，单独编译不可能通过。）
///    所以连接池**不会**被注册，前端 `Database.load()` 抛出。
/// 3. 更坑的是：那次失败的 `remove()` 已经**把迁移条目从 map 里拿走了**，
///    所以*再*调一次 `Database.load()` 反而会成功（没有迁移要跑，自然不会报错），
///    于是现象变成「第一次加载报错、手动重试却正常、数据库一行没改」—— 极难定位。
///
/// 实测现象（2026-09-12，长三角阶段）：`_sqlx_migrations` 停在 [1,2,3]，
/// `substations` / `transmission_lines` 仍是 200 / 100 行，而数据库文件 mtime 纹丝不动。
///
/// ⚠️ 同理，`003_seed_demo_grid.sql` 的内容**一个字都不能改**：
///    已应用过 v3 的库会比对 checksum，内容变了会报 `VersionMismatch`。
///    （所以它里面那句「由 scripts/make_demo_grid.py 生成」虽然脚本已删，也只能留在原地。）
///
/// 结论：**已应用的迁移只能新增、不能删除或修改**。清理由新迁移负责 —— 这就是 v4 的由来。
/// 对新库的副作用是「v3 先插、v4 立刻删」，用户完全看不到，可以接受。
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
        Migration {
            version: 3,
            description: "seed_demo_power_grid",
            // ⚠️ 阶段28 起这批数据已被 v4 清空，但本迁移必须原样保留 —— 原因见上面的说明。
            sql: include_str!("../migrations/003_seed_demo_grid.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "clear_demo_power_grid",
            sql: include_str!("../migrations/004_clear_demo_power_grid.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "index_plants_lat_lon",
            // 纯新增索引：不动表结构、不动数据。
            // 不重新生成 seed/global_power_gis.db —— 首次启动时本迁移会自动补上索引，
            // 所以不必为了一个索引去提交一个 3MB 的二进制差异。
            sql: include_str!("../migrations/005_index_plants_latlon.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_plant_metadata",
            // 阶段46：补回 WRI 里本就有、但导入脚本一直丢弃的 4 个字段
            // （commissioning_year / owner / source / url）。
            // 纯 ADD COLUMN：SQLite 只改元数据不重写行，对现有数据零风险。
            // ⚠️ 新列在**已有**记录上全是 NULL —— 必须重跑
            //    `python scripts/import_wri_plants.py --apply` 才会有值。
            //    旧 seed 库同理：列会自动加上，但值要等重新生成 seed 才有。
            sql: include_str!("../migrations/006_add_plant_metadata.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "index_plants_fuel_cover",
            // 阶段48：为「按燃料的视野统计」加的覆盖索引。
            // 实测把全球视图下的分组统计从 34.01ms 压到 10.33ms（3.2×），
            // 代价是 DB +1.24 MB。纯索引操作，不动表结构、不动数据。
            // ⚠️ 首次启动时会为现有 3.5 万行建一次索引（约 0.3s），之后零成本。
            sql: include_str!("../migrations/007_index_plants_fuel_cover.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_gem_coal_plants",
            // 阶段48-A：GEM（Global Energy Monitor）煤炭数据，**机组级**独立表。
            //
            // ‼️ 单独一张表，不并进 power_plants：两者粒度不同
            //    （WRI 是电站级、GEM 是机组级），混表必须带粒度判别列，
            //    一旦有人漏带就会把容量重复求和。分开存让粒度成为表自带的语义。
            // ⚠️ 本迁移只建**空表**；数据由 scripts/import_gem_coal.py 单独导入，
            //    与 WRI 的 001 建表 / import_wri_plants.py 导数是同一套流程。
            //    因此全新安装时这张表是空的 —— 这是预期行为，不是 bug。
            sql: include_str!("../migrations/008_add_gem_coal_plants.sql"),
            kind: MigrationKind::Up,
        },
        // 阶段50-C.3-C：**已启用**（原本这里是一整段被注释的注册）。
        //
        //   启用条件写在这里，现已满足 —— 50-C.0 ~ 50-C.3-A 已把 GEM 完全切到
        //   gem-plants.pmtiles 数据包：
        //     · `gem_coal_plants` 在 `src/` 里 **0 命中**
        //     · `sqlite_master` 在前端 **0 命中**（不存在枚举表的泛化路径）
        //     · 前端全部 SQL 只查 power_plants / substations / transmission_lines
        //     · `loadGem*` 只剩注释，加载函数已删除
        //   ⇒「表已删、前端还在查它」那种静默失败（走 catch 分支、不报错、更难查）
        //     不会再发生。
        //
        //   ⚠️ 上线后**不能撤**：sqlx 的 `ignore_missing` 默认为 false，
        //      「库里有 v9、列表里没有 v9」会让 `pool.migrate()` 直接返回 Err，
        //      连连接池都不会注册（完整机制见 `migrations()` 上方的 v3 说明）。
        //   ⚠️ 009 从未被应用过（两个库都停在 v8），所以本次修改它的 SQL 内容
        //      不会触发 checksum 校验 —— 只有**已应用**的迁移才比对 checksum。
        Migration {
            version: 9,
            description: "drop_gem_coal_plants",
            sql: include_str!("../migrations/009_drop_gem_coal_plants.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ‼️ 单实例插件必须**第一个**注册：它在插件初始化阶段就要抢占命名互斥体，
        //    排在其它插件之后就晚了 —— 第二个实例可能已经把数据库连接或下载任务
        //    建起来，「只允许一个实例」形同虚设。
        //
        //    第二个实例的行为：插件把它的 argv / cwd 转发给我们之后自行退出（exit 0），
        //    这里只负责把已经开着的窗口拉回前台，让用户觉得「双击图标 = 回到那个窗口」。
        //    窗口 label 是 tauri.conf.json 里的默认值 "main"。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        // ‼️ 阶段54：`tauri_plugin_fs` 已**移除** —— CSV 导出改为在 Rust 侧
        //    弹对话框并写盘（见 `export.rs`），前端不再需要写文件的能力，
        //    于是 `fs:write-all` 这个「可写任意路径」的过宽权限也随之删掉。
        //    ⚠️ `tauri_plugin_dialog` 必须保留：`export.rs` 用它的 Rust API
        //       (`DialogExt`) 弹原生「另存为」。删掉的只是它在**前端**的那一半
        //       （npm 包 + capability 放行）—— Rust 侧调插件不过 ACL。
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![
            greet,
            export::export_csv_file,
            packs::pack_dir,
            packs::pack_status,
            packs::pack_download,
            packs::pack_cancel,
            packs::pack_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 首次运行时，把内置的种子数据库拷到应用数据目录。
///
/// 判定依据是「**目标文件是否是完整的 SQLite 库**」，而不是
/// 「表里是否有数据」，也不是「文件是否存在」：
/// - 判断表是否为空必须先打开数据库，而打开就会创建文件，逻辑上自相矛盾；
/// - 那还会导致用户主动清空表后想重新开始时，数据被强行回填；
/// - 而只看 exists() 会把**被中断的拷贝**留下的截断文件当成播种完成，
///   全应用从此打不开数据库，且只能靠手删 %APPDATA% 恢复。
fn seed_database_if_needed(app: &AppHandle) -> Result<(), String> {
    let target = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))?
        .join(DB_FILE);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录 {parent:?}: {e}"))?;
    }

    let source = app
        .path()
        .resolve(SEED_RESOURCE, BaseDirectory::Resource)
        .map_err(|e| format!("无法定位内置种子数据: {e}"))?;
    let source_len = fs::metadata(&source)
        .map_err(|e| format!("无法读取内置种子数据 {source:?}: {e}"))?
        .len();

    if db_is_complete(&target, source_len) {
        return Ok(());
    }
    if target.exists() {
        eprintln!("[seed] {target:?} 存在但不是完整的 SQLite 库，重新播种");
    }

    seed_copy_atomic(&source, &target)?;
    println!("[seed] 已从内置数据初始化数据库: {target:?}");
    Ok(())
}

/// 同目录的临时文件路径（在目标名后追加 .tmp）。
///
/// ‼️ 必须**同目录**：`rename` 只在同一个卷内才是原子的，
///    放到 %TEMP% 再改名就退化成「复制 + 删除」，中途失败照样留下截断文件。
fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

/// 目标库看起来是否**完整**。
///
/// ‼️ 长度用 `>=` 而不是 `==`：用户导入数据后库会变大，那是完全正常的；
///    若按「大小必须等于种子」判定，就会把用户自己那份好库当成损坏而覆盖 ——
///    修一个 bug 反而制造数据丢失。这里只拦「明显偏小 / 根本不是 SQLite」两种情况。
fn db_is_complete(target: &Path, source_len: u64) -> bool {
    let Ok(meta) = fs::metadata(target) else {
        return false;
    };
    if meta.len() < source_len {
        return false;
    }
    let Ok(mut f) = File::open(target) else {
        return false;
    };
    let mut head = [0u8; 16];
    f.read_exact(&mut head).is_ok() && &head == SQLITE_MAGIC
}

/// 先写同目录的 .tmp、fsync、再原子改名到目标。
///
/// 🔴 为什么不直接 `fs::copy(source, target)`：拷贝中途失败（磁盘满 / 断电 / 杀软）
///    会在**目标位置**留下一个半截文件，而目标名一旦存在，下次启动就不会再播种 ——
///    失败被永久固化。临时文件 + 改名把不变量变成
///    「目标要么是完整的旧文件、要么是完整的新文件」。
fn seed_copy_atomic(source: &Path, target: &Path) -> Result<(), String> {
    let tmp = tmp_sibling(target);
    // 上一次失败可能留下 .tmp，先清掉，避免 fs::copy 撞上一个只读残留
    let _ = fs::remove_file(&tmp);

    let copied = fs::copy(source, &tmp).map_err(|e| format!("拷贝 {source:?} -> {tmp:?} 失败: {e}"))?;

    // ‼️ 比对**实际写入的字节数**：fs::copy 报成功但字数不对，说明源文件本身
    //    就有问题（例如被打包工具截断过），这种「成功」绝不能当成播种完成。
    let want = fs::metadata(source)
        .map_err(|e| format!("无法读取 {source:?} 大小: {e}"))?
        .len();
    if copied != want {
        let _ = fs::remove_file(&tmp);
        return Err(format!("拷贝不完整：{tmp:?} 只写入 {copied}/{want} 字节"));
    }

    // ‼️ 先 fsync 再改名：否则断电后可能出现「名字已就位、内容还在页缓存里」的空壳。
    if let Err(e) = OpenOptions::new().read(true).write(true).open(&tmp).and_then(|f| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("同步 {tmp:?} 失败: {e}"));
    }

    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("无法把 {tmp:?} 改名为 {target:?}: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个「合法 SQLite 头部 + 指定长度」的假库。
    /// 没必要用真的 sqlite3 文件 —— 这里验证的是判定逻辑，不是 SQLite 本身。
    fn fake_db(len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len.max(16)];
        v[..16].copy_from_slice(SQLITE_MAGIC);
        v
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // ‼️ 不用 std::env::temp_dir()：受限沙箱里子进程对 %TEMP% 只有拒绝访问（os error 5），
        //    测试会整片假失败；crate 的 target/ 必定可写（cargo 自己就在写），也随构建一起被清掉。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("gpg-seed-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// R2：完整性判定必须同时挡住「截断」与「根本不是 SQLite」。
    #[test]
    fn db_is_complete_rejects_truncated_and_foreign_files() {
        let dir = tmp_dir("full");
        let target = dir.join("t.db");

        assert!(!db_is_complete(&target, 100), "文件不存在时不算完整");

        fs::write(&target, fake_db(100)).unwrap();
        assert!(db_is_complete(&target, 100), "魔数对且长度相等，应当算完整");
        assert!(
            db_is_complete(&target, 50),
            "比种子大（用户导入过数据）必须算完整，否则会覆盖用户自己的数据"
        );
        assert!(!db_is_complete(&target, 101), "比种子小说明是截断的拷贝，必须重播种");

        fs::write(&target, vec![0u8; 200]).unwrap();
        assert!(!db_is_complete(&target, 100), "没有 SQLite 魔数的文件不算完整");

        let _ = fs::remove_dir_all(&dir);
    }

    /// R2：成功路径 —— 目标内容与源一致，且不残留 .tmp。
    #[test]
    fn seed_copy_atomic_writes_target_and_leaves_no_tmp() {
        let dir = tmp_dir("ok");
        let source = dir.join("seed.db");
        let target = dir.join("live.db");
        fs::write(&source, fake_db(4096)).unwrap();

        seed_copy_atomic(&source, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
        assert!(!tmp_sibling(&target).exists(), "不该残留 .tmp");
        let _ = fs::remove_dir_all(&dir);
    }

    /// R2：失败路径 —— 源不存在时必须报错、原文件原样保留、不留 .tmp。
    #[test]
    fn seed_copy_atomic_keeps_existing_file_when_copy_fails() {
        let dir = tmp_dir("fail");
        let target = dir.join("live.db");
        fs::write(&target, fake_db(16)).unwrap();
        let before = fs::read(&target).unwrap();

        let err = seed_copy_atomic(&dir.join("missing.db"), &target)
            .expect_err("源不存在时必须失败");

        assert!(err.contains("拷贝"), "错误信息应当说明是拷贝失败，实际：{err}");
        assert_eq!(fs::read(&target).unwrap(), before, "失败时原文件必须原样保留");
        assert!(!tmp_sibling(&target).exists(), "失败路径必须清掉 .tmp");
        let _ = fs::remove_dir_all(&dir);
    }
}

