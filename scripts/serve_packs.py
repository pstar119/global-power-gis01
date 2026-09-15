#!/usr/bin/env python3
"""
阶段44：验证数据包下载用的最小静态文件服务器。

# 为什么不用 `python -m http.server`

`http.server.SimpleHTTPRequestHandler` **不实现 HTTP Range** —— 它对任何请求都返回
`200` + 完整文件。用它验证下载的话：
  - 下载、SHA256 校验、进度条：能验证
  - **断点续传：验证不了**（客户端会正确识别出「服务器不支持 Range」并每次从头重下，
    行为是对的，但你就看不到「从断点续传」的效果）
本脚本实现 `206 Partial Content` + `Content-Range`，让续传路径可被真实验证。

# 限速是刻意的

163 MB 在 localhost 上几乎瞬间传完，进度条一闪而过，既截不到图也看不清状态机。
`--rate` 把速度压到可观察的量级（默认 4 MB/s，约 40 秒传完最大的包）。

# 用法

    # 正常模式（支持 Range），默认端口 8099，限速 4 MB/s
    python scripts/serve_packs.py

    # 故意不支持 Range，用来验证「服务器忽略 Range 时客户端必须截断重下」
    python scripts/serve_packs.py --no-range

    # 更快/更慢
    python scripts/serve_packs.py --rate 20000     # KB/s

⚠️ 只监听 127.0.0.1，不对外暴露。仅用于本机验证。
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ARGS = None


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """把 `bytes=100-` / `bytes=0-99` 解析成闭区间 (start, end)。不合法返回 None。"""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes="):].strip()
    # 只支持单区间；多区间（含逗号）直接当作不支持
    if "," in spec:
        return None
    if "-" not in spec:
        return None
    first, last = spec.split("-", 1)
    try:
        if first == "":
            # bytes=-N 表示最后 N 字节
            n = int(last)
            if n <= 0:
                return None
            start = max(0, size - n)
            return (start, size - 1)
        start = int(first)
        end = int(last) if last != "" else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        return None
    return (start, min(end, size - 1))


class Handler(BaseHTTPRequestHandler):
    server_version = "gpg-packs/1.0"

    def log_message(self, fmt, *args):  # noqa: D102
        # 只打印一行紧凑日志，突出 Range 请求（验证续传时最需要看的）
        sys.stderr.write("  [srv] " + (fmt % args) + "\n")

    def _resolve(self) -> tuple[str, int] | None:
        rel = unquote(self.path.split("?", 1)[0]).lstrip("/")
        # 防目录穿越：解析后必须仍在根目录内
        target = os.path.normpath(os.path.join(ARGS.directory, rel))
        root = os.path.normpath(ARGS.directory)
        if not target.startswith(root) or not os.path.isfile(target):
            return None
        return (target, os.path.getsize(target))

    def _send(self, code: int, headers: dict, body: bytes | None = None):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_HEAD(self):  # noqa: N802
        found = self._resolve()
        if not found:
            self._send(404, {"Content-Length": "0"})
            return
        _, size = found
        self._send(200, {"Content-Length": str(size), "Accept-Ranges": "bytes"})

    def do_GET(self):  # noqa: N802
        found = self._resolve()
        if not found:
            self._send(404, {"Content-Length": "0", "Content-Type": "text/plain"})
            return
        path, size = found

        rng = None if ARGS.no_range else parse_range(self.headers.get("Range"), size)
        if ARGS.no_range and self.headers.get("Range"):
            sys.stderr.write("  [srv] 本次请求带了 Range，但 --no-range 生效：返回 200 全量\n")

        if rng is None:
            start, end = 0, size - 1
            code = 200
        else:
            start, end = rng
            code = 206

        length = end - start + 1
        headers = {
            "Content-Length": str(length),
            "Content-Type": "application/octet-stream",
            "Accept-Ranges": "bytes",
        }
        if code == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        if code == 206:
            sys.stderr.write(
                f"  [srv] 206 从 {start} 开始，共 {length} 字节（总 {size}）—— 这是一次续传\n"
            )

        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()

        # 分块 + 限速发送：让客户端的进度条有可观察的中间状态
        chunk = 64 * 1024
        per_chunk_sleep = 0.0
        if ARGS.rate > 0:
            per_chunk_sleep = chunk / (ARGS.rate * 1024.0)
        sent = 0
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionAbortedError):
                    sys.stderr.write("  [srv] 客户端断开（模拟中断）\n")
                    return
                sent += len(data)
                remaining -= len(data)
                if per_chunk_sleep:
                    time.sleep(per_chunk_sleep)
        sys.stderr.write(f"  [srv] 发送完成 {sent} 字节\n")


def main():
    global ARGS
    p = argparse.ArgumentParser(description="阶段44 数据包验证服务器（支持 Range + 限速）")
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--dir", dest="directory", default=os.path.join("data", "packs"))
    p.add_argument("--rate", type=int, default=4096, help="限速 KB/s，0 表示不限速")
    p.add_argument("--no-range", action="store_true", help="故意忽略 Range，验证客户端截断重下")
    ARGS = p.parse_args()

    if not os.path.isdir(ARGS.directory):
        print(f"[err] 目录不存在: {ARGS.directory}")
        return 1

    files = sorted(f for f in os.listdir(ARGS.directory) if f.endswith(".pmtiles"))
    httpd = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print("=== 数据包验证服务器 ===")
    print(f"  监听   : http://127.0.0.1:{ARGS.port}/")
    print(f"  目录   : {os.path.abspath(ARGS.directory)}")
    print(f"  Range  : {'禁用（--no-range）' if ARGS.no_range else '启用（支持断点续传）'}")
    print(f"  限速   : {'不限速' if ARGS.rate <= 0 else str(ARGS.rate) + ' KB/s'}")
    print(f"  文件   : {len(files)} 个")
    for f in files:
        print(f"    {f}  {os.path.getsize(os.path.join(ARGS.directory, f)) / 1048576:.2f} MB")
    print("\n  Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
