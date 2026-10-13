#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EchoLingo 本地静态服务器。

用法:
    python3 tools/serve.py [端口]

相比 python -m http.server 多做三件事:
  1. 发送 COOP/COEP 头，让浏览器启用 SharedArrayBuffer，
     onnxruntime 就能用多线程跑推理，识别速度提升数倍。
  2. 为 .onnx / .wasm / .m4a 等补充正确的 MIME 类型。
  3. 开发时禁用缓存，避免改动 js 后仍读到旧文件。

服务只监听 127.0.0.1，局域网内其他设备无法访问。
"""
import functools
import http.server
import os
import socket
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".spm": "application/octet-stream",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if self.path.endswith((".onnx", ".wasm", ".m4a")):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        if " 200 " in msg or " 304 " in msg or " 206 " in msg:
            return
        sys.stderr.write("[serve] " + msg + "\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_port(preferred):
    for p in [preferred] + list(range(preferred + 1, preferred + 40)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("找不到可用端口")


def main():
    preferred = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    port = find_port(preferred)
    url = f"http://127.0.0.1:{port}/index.html"
    print("EchoLingo 已启动")
    print("  地址 :", url)
    print("  根目录:", ROOT)
    print("  按 Ctrl+C 停止")
    if "--open" in sys.argv:
        webbrowser.open(url)
    with Server(("127.0.0.1", port), functools.partial(Handler)) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
