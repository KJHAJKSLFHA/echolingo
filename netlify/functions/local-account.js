/* 本地开发用的账号与配额路由（server.js 与 desktop/site-server.js 共用）。
 *
 * 与线上 netlify/functions/account.mjs 走同一份判定逻辑（account-core.mjs），
 * 差别只在库：线上是 Netlify Blobs，本地是 .local/account-db.json。
 * 这样注册/登录/配额/绑码在本地就能验证，不必先部署才发现问题。
 *
 * 密钥：优先读 ECHOLINGO_SECRET，其次 .local/secret.txt，都没有就自动生成一份。
 * 线上必须用环境变量（仓库公开，写死的密钥等于人人可伪造凭据）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = '/api/account';

function dbFile(root) {
  return path.join(root, '.local', 'account-db.json');
}

function readDb(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

function writeDb(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** 本地开发密钥：环境变量 > .local/secret.txt > 自动生成并落盘 */
function localSecret(root) {
  if (process.env.ECHOLINGO_SECRET && process.env.ECHOLINGO_SECRET.length >= 16) {
    return process.env.ECHOLINGO_SECRET;
  }
  const f = path.join(root, '.local', 'secret.txt');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s.length >= 16) return s;
  } catch (e) { /* 还没有，下面生成 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
  return s;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} root 项目根目录（库写在 <root>/.local/ 下）
 * @returns {boolean} 是否已处理
 */
function handleAccountApi(req, res, root) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { return false; }
  if (pathname !== PREFIX) return false;

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' });
    res.end();
    return true;
  }

  const file = dbFile(root);
  const db = {
    async get(key) {
      const all = readDb(file);
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
    },
    async set(key, value) {
      const all = readDb(file);
      all[key] = value;
      writeDb(file, all);
      return true;
    },
    async setIfNew(key, value) {
      const all = readDb(file);
      if (Object.prototype.hasOwnProperty.call(all, key)) return false;
      all[key] = value;
      writeDb(file, all);
      return true;
    },
    async addUsage(prefix, sec) {
      const all = readDb(file);
      const n = Math.max(0, Math.floor(Number(sec) || 0));
      if (!n) return;
      const rand = Math.random().toString(36).slice(2, 8);
      all[`${prefix}${n}-${rand}`] = { sec: n };
      writeDb(file, all);
    },
    async sumUsage(prefix) {
      const all = readDb(file);
      let total = 0;
      for (const k of Object.keys(all)) {
        if (!k.startsWith(prefix)) continue;
        const n = Math.floor(Number(String(k).slice(prefix.length).split('-')[0]) || 0);
        if (n > 0) total += n;
      }
      return total;
    },
    async incr(key, delta) {
      const all = readDb(file);
      const cur = all[key] && typeof all[key] === 'object'
        ? Math.max(0, Math.floor(Number(all[key].sec) || 0))
        : Math.max(0, Math.floor(Number(all[key]) || 0));
      const next = cur + Math.max(0, Math.floor(Number(delta) || 0));
      all[key] = { sec: next };
      writeDb(file, all);
      return { sec: next };
    },
  };

  (async () => {
    const body = method === 'POST' ? await readBody(req) : null;
    const { handleAccount } = await import('./account-core.mjs');
    const { createRequire } = await import('node:module');
    const require2 = createRequire(__filename);
    const LIC = require2('../../app/js/license.js');
    const out = await handleAccount(
      { method, body },
      db,
      { secret: localSecret(root), verifyCode: LIC.check },
    );
    const text = await out.text();
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(text);
  })().catch((e) => {
    send(res, 500, { ok: false, error: 'local-account', detail: String((e && e.message) || e) });
  });

  return true;
}

module.exports = { handleAccountApi, dbFile, localSecret };
