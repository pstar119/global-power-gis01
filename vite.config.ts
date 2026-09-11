import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

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

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), maplibreWorkerAssets()],

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
