#!/usr/bin/env node
// EchoLingo 生产用静态服务器（零依赖，只用 Node 内置模块）
//
// 为什么不用一个纯静态托管：这个应用要跑 onnxruntime 的 wasm 后端，
// 浏览器只有在响应带 COOP/COEP 头、进入 crossOriginIsolated 状态时才会开放
// SharedArrayBuffer，多线程推理才生效。缺少这两个头不会报错，只会悄悄退化成
// 单线程，识别时间成倍上升 —— 所以必须在服务端把头发出去。
//
// 用法: PORT=3000 node server.js

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { handleUrlApi } = require('./url-import.js');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.spm': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// 体积大且永不变化：模型、wasm、音频，交给浏览器长期缓存
const IMMUTABLE = /\.(onnx|wasm|spm|bin|m4a|mp3|mp4|webm|wav)$/i;

function createAppServer() {
  return http.createServer((req, res) => {
  // 链接导入接口要收 POST，所以必须在下面的 405 检查之前分流。
  if (req.url && req.url.startsWith('/api/url/')) {
    let apiPath = '/';
    try { apiPath = url.parse(req.url).pathname || '/'; } catch { /* 用它当 404 */ }
    if (handleUrlApi(req, res, apiPath)) return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  // 归一化后必须仍落在 ROOT 内，挡住 ../ 这类穿越
  let rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  let file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      // ⚠️ 目录要**重新 stat 一次**。
      // 曾经的写法是把 file 改成 index.html、然后把 st 置成 null 直接往下走，
      // 结果下一行的 `!st.isFile()` 必然成立 → 一律掉进首页兜底。
      // 表现是：访问 /app/ 打开的却是根目录的官网首页，而且不报任何错。
      const index = path.join(file, 'index.html');
      return fs.stat(index, (e2, st2) => {
        if (e2 || !st2 || !st2.isFile()) return fallbackToIndex(res, req);
        send(res, index, st2, req, false);
      });
    }
    if (err || !st || !st.isFile()) return fallbackToIndex(res, req);
    send(res, file, st, req, false);
  });
});

// 单页应用兜底：未知路径回到根入口，方便直接分享根地址
function fallbackToIndex(res, req) {
  const fallback = path.join(ROOT, 'index.html');
  fs.stat(fallback, (e2, st2) => {
    if (e2 || !st2) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    send(res, fallback, st2, req, true);
  });
}
}

function send(res, file, st, req, isFallback) {
  const ext = path.extname(file).toLowerCase();
  // 带上 ETag：HTML/CSS/JS 都是 no-cache，有验证器才能走 304，
  // 既保证「文件一变立刻看到新的」，又不用每次重传。
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs || 0).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': IMMUTABLE.test(ext) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (isFallback) headers['Cache-Control'] = 'no-cache';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);   // 304 不带 body，也不该带 Content-Length
    return res.end();
  }

  headers['Content-Length'] = st.size;

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.end());
  stream.pipe(res);
}

// 供 Electron 主进程复用：拿到「已监听」的 server 实例和实际端口。
// 传入 port: 0 让系统自动分配空闲端口（Electron 场景下避免端口冲突）。
module.exports = {
  createAppServer,
  listen(port = 0, host = HOST) {
    return new Promise((resolve, reject) => {
      const srv = createAppServer();
      srv.once('error', reject);
      srv.listen(port, host, () => {
        const addr = srv.address();
        resolve({ server: srv, port: addr.port, host });
      });
    });
  },
};

// 仅在「直接 node server.js 运行」时才启动独立监听；
// 被 require 时（Electron）不抢端口，交给上面的 listen() 按需起。
if (require.main === module) {
  createAppServer().listen(PORT, HOST, () => {
    console.log(`EchoLingo 已启动: http://${HOST}:${PORT}/`);
  });
}
