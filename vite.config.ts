import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
// @ts-expect-error type error without @types/node package
import { join, dirname } from "node:path";

const host = process.env.TAURI_DEV_HOST;

/** public/ 目录名（dev 由 Vite 内置能力服务，build 由下面的插件精确拷贝） */
const PUBLIC_DIR = "public";

/**
 * MapLibre v6 在运行时用 `new URL(`./${name}`, import.meta.url)` 拼出 Worker 脚本地址，
 * 文件名藏在模板字符串里，打包器无法静态分析，所以产物里根本没有这个文件。
 * 又因为同源时 MapLibre 会直接 `new Worker(url)`，拿到 404 后 Worker 立即死亡，
 * 现象极其隐蔽：控制台不报错、底图只画出样式的背景色、矢量瓦片永远加载不出来。
 * 这里把 Worker 及其 import 的 shared 文件按原文件名原样放到与入口脚本同级的 assets/ 下。
 */
function maplibreWorkerAssets(): Plugin {
  const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

  return {
    name: "maplibre-worker-assets",

    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${file}`,
          source: readFileSync(
            `${process.cwd()}/node_modules/maplibre-gl/dist/${file}`,
            "utf8",
          ),
        });
      }
    },
  };
}

/**
 * `public/osm/` 里混着两类完全不同的东西：
 *   1. **运行时资产** —— 只有 `smoketest_power.geojson`（前端加载失败时的回退小样本）
 *   2. **构建中间产物** —— `<name>_power.geojson` / `<name>_power_meta.json`，
 *      是 prepare_osm_geojson.mjs 的产出、build_pmtiles.mjs 的输入；
 *      运行时**完全用不到**（应用读的是 pmtiles 包）
 *
 * Vite 默认把整个 public/ 原样拷进 dist/：实测那 8 个中间产物共 **359.9 MB**，
 * 让 dist 从 ~5 MB 膨胀到 264 MB，再被 tauri 的 frontendDist 打进安装包。
 *
 * 这里改成「按排除规则精确拷贝」。用**排除**而非白名单 —— 将来往 public/
 * 添加运行时资产（如新的 fonts/、清单文件）不会静默漏拷。
 */
const OSM_RUNTIME_KEEP = new Set([
  "smoketest_power.geojson",
  "smoketest_power_meta.json",
]);

function copyPublicRuntimeAssets(): Plugin {
  let outDir = "dist";
  let copiedFiles = 0;
  let skippedBytes = 0;

  const isBuildIntermediate = (rel: string) =>
    rel.startsWith("osm/") && !OSM_RUNTIME_KEEP.has(rel.slice("osm/".length));

  const walk = (relDir: string) => {
    const abs = join(PUBLIC_DIR, relDir);
    if (!existsSync(abs)) return;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(rel);
      } else if (isBuildIntermediate(rel)) {
        skippedBytes += statSync(join(PUBLIC_DIR, rel)).size;
      } else {
        const dest = join(outDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(PUBLIC_DIR, rel), dest);
        copiedFiles++;
      }
    }
  };

  return {
    name: "gpg-copy-public-runtime-assets",
    apply: "build",

    configResolved(config) {
      outDir = config.build.outDir;
    },

    closeBundle() {
      walk("");
      const skippedMb = (skippedBytes / 1048576).toFixed(1);
      console.log(
        `\n  public/ → ${outDir}/ ：拷贝 ${copiedFiles} 个运行时资产` +
          (skippedBytes
            ? `，跳过 ${skippedMb} MB 构建中间产物（osm/*_power.geojson）`
            : ""),
      );
    },
  };
}

/**
 * 该把哪些前缀的环境变量注入前端代码。
 *
 * ‼️ 目的：让 `PACKS_BASE_URL` **一个名字**同时管两件事，消除混淆：
 *   - `node scripts/gen_packs_manifest.mjs` 读它（决定清单里写哪个地址）
 *   - `vite dev` 注入它（决定前端运行时用哪个地址）
 *     → 于是 `$env:PACKS_BASE_URL="http://127.0.0.1:8099"; npm run tauri dev`
 *       就能直接生效，**不需要重新生成清单**。
 *
 * 🔴 阶段46：**build 时刻意不再注入 `PACKS_`**。
 *
 *   原因是实测出来的一个会让分发**静默全灭**的坑（已验证，不是假想）：
 *   Vite 会把构建时 shell 环境里匹配 envPrefix 的变量**原样内联进产物**，
 *   而 `PACKS_BASE_URL` 在前端里的优先级**高于清单** ——
 *   于是「本地联调完、shell 里还留着 `PACKS_BASE_URL=http://127.0.0.1:8099`，
 *   直接 `tauri build` 发版」就会把 localhost 写进安装包，
 *   所有用户的下载都指向自己的机器、100% 失败，而代码与清单看起来都完全正常。
 *
 *   实测证据（2026-09-15）：带 `PACKS_BASE_URL=http://127.0.0.1:9999` 跑 `npm run build`，
 *   `dist/assets/index-*.js` 里确实能搜到 `127.0.0.1:9999`。
 *
 *   ⇒ build 下不注入该前缀，字符串连进都进不了产物；
 *     前端侧还有第二道保险（`import.meta.env.DEV` 判断，见 PackManager.tsx）。
 *     要在生产模式改地址，走**清单这唯一配置点**：
 *       $env:PACKS_BASE_URL="http://127.0.0.1:8099"; node scripts/gen_packs_manifest.mjs
 *
 * ⚠️ 即使是 dev，也不要用这个前缀放密钥：注入的变量会原样进产物。
 *    `PACKS_BASE_URL` 是公开下载地址，不敏感。
 */
function resolveEnvPrefix(command: string): string[] {
  if (command === "build") {
    if (process.env.PACKS_BASE_URL) {
      console.warn(
        `\n⚠️ [vite] 构建时检测到 PACKS_BASE_URL=${process.env.PACKS_BASE_URL}\n` +
          "   生产构建**刻意不注入**该变量（否则会把本地联调地址打进发行包）。\n" +
          "   本次构建的下载地址取自 public/packs_manifest.json。\n" +
          "   要改它：node scripts/gen_packs_manifest.mjs\n",
      );
    }
    return ["VITE_"];
  }
  return ["VITE_", "PACKS_"];
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // dev：需要 Vite 内置的 publicDir 能力来服务 /fonts/、/packs_manifest.json。
  // build：关掉整体拷贝（否则会把 360 MB 构建中间产物带进 dist），
  //        改由 copyPublicRuntimeAssets() 按规则精确拷贝。
  publicDir: command === "serve" ? PUBLIC_DIR : false,

  // `PACKS_` 前缀只在 dev 下暴露 —— 理由见 resolveEnvPrefix 的注释（实测确认的坑）
  envPrefix: resolveEnvPrefix(command),

  plugins: [react(), maplibreWorkerAssets(), copyPublicRuntimeAssets()],

  // maplibre-gl 不能交给依赖预打包：预打包后 import.meta.url 会变成
  // .vite/deps/maplibre-gl.js，而该目录下并不存在 maplibre-gl-worker.mjs，
  // 开发环境会以完全相同的方式 404。排除后浏览器直接加载
  // node_modules/maplibre-gl/dist/maplibre-gl.mjs，
  // Worker 与 shared 都是它的同级文件，路径自然成立。
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
