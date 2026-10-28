/* 账号与每日配额的纯逻辑层 —— 不绑定存储实现。
 *
 * 线上跑在 Netlify（Blobs 当库），本地跑在 server.js（JSON 文件当库）。
 * 两条路共用这一份判定，避免「本地能过、线上被挡」这种只有上线才发现的分叉。
 *
 * 存储接口（由调用方注入）：
 *   db.get(key)              → 值或 null
 *   db.set(key, value)       → 写入（覆盖）
 *   db.setIfNew(key, value)  → 原子写入；键已存在返回 false（并发下只有一个成功）
 *   db.incr(key, delta)      → 原子自增，返回新值
 *
 * 键布局：
 *   u/<id>            → { id, email, salt, hash, plan, serial, createdAt }
 *   e/<emailLower>    → <id>                邮箱索引，登录时用它找 id
 *   d/<id>/<dayKey>   → 当日已用秒数（数字）
 *
 * 关于「每天两小时」的诚实说明：
 * 识别与翻译全部在浏览器本地用 wasm 跑，服务端看不到真正算了几秒。
 * 这里的时间是客户端心跳上报的累计值，正常用户准确，但改前端 JS 的人可以不报。
 * 要做到严丝合缝，必须把模型搬到服务端跑，那是另一个量级的成本。
 * 所以这层配额的定位是「拦普通用户」，不是「防逆向」。
 */
import { ISSUED } from './issued.mjs';

export const FREE_SECONDS_PER_DAY = 2 * 60 * 60;   // 每天两小时
const DAY_OFFSET_MS = 8 * 3600 * 1000;             // 按北京时间换日
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;        // 登录凭据 90 天
const PBKDF2_ITER = 120000;
const MIN_PASS = 6;

const JSON_HEAD = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

export function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEAD });
}

/** 北京时间当天的日期键，形如 2026-10-27 */
export function dayKey(now = Date.now()) {
  // 先移到北京时间，再用本地日期字段取值。
  // 早先用 toISOString()（UTC）切片，虽然多数时候碰巧正确，
  // 但在东八区凌晨 0~8 点之间会算成前一天，白天的额度统计会串日。
  const d = new Date(now + DAY_OFFSET_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/* ------------------------------ 口令与凭据 ------------------------------ */

function b64u(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randHex(n) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(saltHex), iterations: PBKDF2_ITER },
    key, 256,
  );
  return b64u(bits);
}

/** 常数时间比较，避免按响应时间逐字节猜口令 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64u(sig);
}

/* 凭据是「id.过期时间.签名」，服务端可无状态校验。
 * 密钥来自环境变量 ECHOLINGO_SECRET —— 不放代码里，因为仓库是公开的，
 * 写死的密钥等于人人可自造凭据。缺变量时直接报错，不静默降级成不安全状态。 */
export function needSecret(secret) {
  const s = String(secret || '');
  if (s.length < 16) {
    throw new Error('ECHOLINGO_SECRET missing: set a random string of at least 16 chars in the Netlify environment (and .local/secret.txt for local runs)');
  }
  return s;
}

export async function signToken(secret, userId, now = Date.now()) {
  const exp = now + TOKEN_TTL_MS;
  const body = `${userId}.${exp}`;
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyToken(secret, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [id, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!id || !Number.isFinite(exp) || exp < now) return null;
  const want = await hmac(secret, `${id}.${exp}`);
  if (!safeEqual(sig, want)) return null;
  return id;
}

/* ------------------------------ 用户视图 ------------------------------ */

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailLooksOk(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 160;
}

/** 当日用量归一化。
 * 历史上有两种写法：裸数字（本地 JSON 文件）和 { sec } 对象（Blobs）。
 * 线上曾因为只认裸数字、而 Blobs 读回对象/空值，导致每次上报都被当成 0，
 * 配额永远停留在一次的量。两种都认，避免再踩。 */
function secOf(v) {
  if (v && typeof v === 'object') return Math.max(0, Math.floor(Number(v.sec) || 0));
  return Math.max(0, Math.floor(Number(v) || 0));
}

/** 组装给前端的用户视图：不含任何口令材料 */
function view(user, usedToday, now = Date.now()) {
  const used = Math.max(0, Math.floor(Number(usedToday) || 0));
  const pro = user.plan === 'pro';
  return {
    id: user.id,
    email: user.email,
    plan: pro ? 'pro' : 'free',
    serial: pro ? user.serial || null : null,
    createdAt: user.createdAt || null,
    usedToday: used,
    limitSec: pro ? 0 : FREE_SECONDS_PER_DAY,
    remaining: pro ? -1 : Math.max(0, FREE_SECONDS_PER_DAY - used),
    unlimited: pro,
    dayKey: dayKey(now),
  };
}

/** 用量前缀：d/<id>/<dayKey>/  —— 末尾的斜杠很重要，
 * 旧的单键写法是 d/<id>/<dayKey>（无斜杠），两者不会互相误匹配。 */
function usagePrefix(userId, now) {
  return `d/${userId}/${dayKey(now)}/`;
}

/** 读当日已用秒数：追加日志求和 + 兼容早期单键写法 */
async function readUsed(db, userId, now) {
  const legacy = secOf(await db.get(`d/${userId}/${dayKey(now)}`));
  const logged = db.sumUsage ? secOf(await db.sumUsage(usagePrefix(userId, now))) : 0;
  return legacy + logged;
}

/** 记一笔用量 */
async function addUsed(db, userId, now, sec) {
  if (db.addUsage) return db.addUsage(usagePrefix(userId, now), sec);
  if (db.incr) return db.incr(`d/${userId}/${dayKey(now)}`, sec);
  return 0;
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * @param {{ method: string, body: any }} input
 * @param {{ get: Function, set: Function, setIfNew: Function, incr: Function }} db
 * @param {{ secret: string, verifyCode: Function, now?: Function }} cfg
 */
export async function handleAccount(input, db, cfg) {
  const method = String(input.method || 'GET').toUpperCase();

  // 204 不能带 body（Netlify 运行时对带 body 的 204 直接抛 TypeError）。
  if (method === 'OPTIONS') {
    const { 'content-type': _drop, ...corsHead } = JSON_HEAD;
    return new Response(null, { status: 204, headers: corsHead });
  }
  if (method === 'GET') {
    return reply(200, {
      ok: true,
      service: 'echolingo-account',
      freeSecondsPerDay: FREE_SECONDS_PER_DAY,
      dayKey: dayKey(cfg.now ? cfg.now() : Date.now()),
    });
  }
  if (method !== 'POST') return reply(405, { ok: false, error: 'method' });

  const secret = needSecret(cfg.secret);
  const now = cfg.now ? cfg.now() : Date.now();
  const body = input.body || {};
  const op = String(body.op || '').toLowerCase();

  /* ---------- 注册 ---------- */
  if (op === 'register') {
    const email = normEmail(body.email);
    const password = String(body.password || '');
    if (!emailLooksOk(email)) return reply(200, { ok: false, reason: 'bad-email' });
    if (password.length < MIN_PASS) return reply(200, { ok: false, reason: 'weak-pass' });

    const id = randHex(9);
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await pbkdf2(password, salt);
    const user = { id, email, salt, hash, plan: 'free', serial: null, createdAt: new Date(now).toISOString() };

    // 邮箱索引用 setIfNew 做原子占位：两个人同时用同一邮箱注册，只有一个成功。
    const took = await db.setIfNew(`e/${email}`, id);
    if (!took) return reply(200, { ok: false, reason: 'exists' });

    await db.set(`u/${id}`, user);
    const token = await signToken(secret, id, now);
    return reply(200, { ok: true, token, user: view(user, 0, now) });
  }

  /* ---------- 登录 ---------- */
  if (op === 'login') {
    const email = normEmail(body.email);
    const password = String(body.password || '');
    if (!email || !password) return reply(200, { ok: false, reason: 'bad-email' });

    const id = await db.get(`e/${email}`);
    if (!id) return reply(200, { ok: false, reason: 'no-user' });
    const user = await db.get(`u/${id}`);
    if (!user) return reply(200, { ok: false, reason: 'no-user' });

    const hash = await pbkdf2(password, user.salt);
    if (!safeEqual(hash, user.hash)) return reply(200, { ok: false, reason: 'bad-pass' });

    const used = await db.get(`d/${id}/${dayKey(now)}`);
    const token = await signToken(secret, id, now);
    return reply(200, { ok: true, token, user: view(user, used, now) });
  }

  /* ---------- 以下都要凭据 ---------- */
  const userId = await verifyToken(secret, body.token, now);
  if (!userId) return reply(200, { ok: false, reason: 'need-login' });

  const user = await db.get(`u/${userId}`);
  if (!user) return reply(200, { ok: false, reason: 'need-login' });

  /* ---------- 刷新状态 ---------- */
  if (op === 'me') {
    const used = await readUsed(db, userId, now);
    return reply(200, { ok: true, user: view(user, used, now) });
  }

  /* ---------- 上报使用时长 ---------- */
  if (op === 'tick') {
    // 单次最多认 10 分钟：客户端一次报几小时也只会加一点点，压住明显作弊
    const raw = Math.max(0, Math.min(600, Math.floor(Number(body.seconds) || 0)));
    const used0 = await readUsed(db, userId, now);
    // 再按当日剩余额度夹一次：用满之后不再累加，避免「已用 2:10:00」这种越界显示
    const add = Math.min(raw, Math.max(0, FREE_SECONDS_PER_DAY - used0));
    if (!add) {
      return reply(200, { ok: true, user: view(user, used0, now) });
    }
    if (user.plan === 'pro') {
      // 永久会员不计时，但仍然记一笔，方便日后看真实用量
      await addUsed(db, userId, now, add);
      return reply(200, { ok: true, user: view(user, 0, now) });
    }
    await addUsed(db, userId, now, add);
    const used = await readUsed(db, userId, now);
    return reply(200, { ok: true, user: view(user, Math.min(used, FREE_SECONDS_PER_DAY), now) });
  }

  /* ---------- 绑定激活码，升级永久 ---------- */
  if (op === 'redeem') {
    if (user.plan === 'pro') {
      return reply(200, { ok: true, already: true, user: view(user, 0, now) });
    }
    const code = String(body.code || '').trim();
    if (!code) return reply(200, { ok: false, reason: 'invalid' });

    const v = cfg.verifyCode ? cfg.verifyCode(code) : { ok: false, serial: 0 };
    if (!v.ok) return reply(200, { ok: false, reason: 'invalid' });

    const serial = v.serial;
    if (!ISSUED.has(serial)) return reply(200, { ok: false, reason: 'unissued' });

    // 复用原激活码账本：一个码只能用一次，且记下它绑给了哪个账号
    const usedKey = `lic:used/${serial}`;
    const already = await db.get(usedKey);
    if (already) {
      if (already.account === userId) {
        return reply(200, { ok: true, already: true, user: view(user, 0, now) });
      }
      return reply(200, { ok: false, reason: 'used', at: already.at || null });
    }
    const took = await db.setIfNew(usedKey, { serial, account: userId, at: new Date(now).toISOString() });
    if (!took) {
      const who = await db.get(usedKey);
      if (who && who.account === userId) return reply(200, { ok: true, already: true, user: view(user, 0, now) });
      return reply(200, { ok: false, reason: 'used', at: who && who.at ? who.at : null });
    }

    const next = { ...user, plan: 'pro', serial, upgradedAt: new Date(now).toISOString() };
    await db.set(`u/${userId}`, next);
    return reply(200, { ok: true, serial, user: view(next, 0) });
  }

  return reply(400, { ok: false, error: 'unknown-op' });
}
