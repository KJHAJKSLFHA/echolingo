/* 账号与每日免费额度（前端）。
 *
 * 职责：保管登录凭据、调 /api/account、按“真实在学习”的时间上报用量。
 *
 * 关于计时口径（重要）：识别与翻译都在本机 wasm 里跑，服务端看不到真实耗时，
 * 所以这里是客户端量出来的时长再上报。判断“在学”的条件是：
 * 页面在前台，并且（正在播放 / 正在识别 / 正在翻译 / 90 秒内有过操作）。
 * 只把页面开着不动不算，避免挂机把额度耗光。
 *
 * 服务端地址：优先同源（本机 server.js、Netlify 站点都能直连），
 * 静态镜像没有 /api/account，会自动退到线上那唯一一份账本。
 */

const PROD = 'https://echolingo-web.netlify.app/api/account';
const TOKEN_KEY = 'echolingo.acct.token';
const API_KEY = 'echolingo.acct.api';

const TICK_MS = 30000;          // 每 30 秒上报一次
const IDLE_MS = 90000;          // 90 秒没动静就算没在学

export const ACCT = {
  ready: false,
  offline: false,
  user: null,
  error: '',
};

let base = '';
let busy = { asr: false, mt: false, player: false };
let lastActive = 0;
let tickTimer = 0;
let pendingSec = 0;             // 攒着还没上报的秒数
let inFlight = false;

/* ------------------------------ 存取 ------------------------------ */

function readLS(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function writeLS(k, v) {
  try { localStorage.setItem(k, v); } catch (e) { /* 无痕模式写不进，只影响本次会话 */ }
}
function dropLS(k) {
  try { localStorage.removeItem(k); } catch (e) { /* 同上 */ }
}

export function token() { return readLS(TOKEN_KEY) || ''; }
export function isLoggedIn() { return !!ACCT.user; }

/** 永久会员，或者今天还有剩余额度 */
export function canUse() {
  const u = ACCT.user;
  if (!u) return false;
  if (u.unlimited || u.plan === 'pro') return true;
  return (u.remaining | 0) > 0;
}

export function remaining() {
  const u = ACCT.user;
  if (!u) return 0;
  if (u.unlimited || u.plan === 'pro') return -1;
  return Math.max(0, u.remaining | 0);
}

function emit() {
  try { window.dispatchEvent(new CustomEvent('acct:change', { detail: ACCT })); } catch (e) { /* 老浏览器 */ }
}

/* ------------------------------ 网络 ------------------------------ */

function candidates() {
  const out = [];
  const cached = readLS(API_KEY);
  if (cached) out.push(cached);
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    out.push(location.origin + '/api/account');
  }
  out.push(PROD);
  return out.filter((v, i, a) => v && a.indexOf(v) === i);
}

async function post(payload, url) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  // 静态镜像会把 404 页面当 HTML 返回，这里必须当成“这个地址没有接口”
  if (ct.indexOf('json') < 0) throw new Error('not-json');
  return r.json();
}

/** 按候选地址依次试，成功的那个记下来下次直接用 */
async function call(op, extra = {}) {
  const payload = { op, ...extra };
  const t = token();
  if (t && !payload.token) payload.token = t;

  let lastErr = null;
  for (const url of candidates()) {
    try {
      const data = await post(payload, url);
      if (!readLS(API_KEY)) writeLS(API_KEY, url);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('offline');
}

function applyUser(user) {
  ACCT.user = user || null;
  ACCT.offline = false;
  ACCT.error = '';
  emit();
}

/* ------------------------------ 对外动作 ------------------------------ */

export async function register(email, password) {
  const d = await call('register', { email, password });
  if (d && d.ok && d.token) {
    writeLS(TOKEN_KEY, d.token);
    applyUser(d.user);
    startTicker();
  }
  return d || { ok: false, reason: 'offline' };
}

export async function login(email, password) {
  const d = await call('login', { email, password });
  if (d && d.ok && d.token) {
    writeLS(TOKEN_KEY, d.token);
    applyUser(d.user);
    startTicker();
  }
  return d || { ok: false, reason: 'offline' };
}

export function logout() {
  dropLS(TOKEN_KEY);
  ACCT.user = null;
  stopTicker();
  emit();
}

/** 刷新账号状态（额度会在别处用掉，进来时对一下） */
export async function refresh() {
  if (!token()) { applyUser(null); return { ok: false, reason: 'need-login' }; }
  try {
    const d = await call('me');
    if (d && d.ok) { applyUser(d.user); return d; }
    if (d && d.reason === 'need-login') { logout(); return d; }
    return d || { ok: false, reason: 'offline' };
  } catch (e) {
    // 连不上时不要把已登录的人踢出去：保留上次的本地状态，只标记离线
    ACCT.offline = true;
    ACCT.error = 'offline';
    emit();
    return { ok: false, reason: 'offline' };
  }
}

export async function redeem(code) {
  const d = await call('redeem', { code });
  if (d && d.ok && d.user) applyUser(d.user);
  return d || { ok: false, reason: 'offline' };
}

/* ------------------------------ 计时上报 ------------------------------ */

export function markBusy(kind, on) {
  if (kind in busy) busy[kind] = !!on;
  if (on) lastActive = Date.now();
}

export function poke() {
  lastActive = Date.now();
}

function isActive() {
  if (document.visibilityState !== 'visible') return false;
  if (busy.asr || busy.mt || busy.player) return true;
  return Date.now() - lastActive < IDLE_MS;
}

async function flush() {
  const sec = pendingSec;
  if (!sec) return;
  if (inFlight) return;                 // 上一笔没回来就先攒着，不并发
  if (!token()) { pendingSec = 0; return; }
  if (ACCT.user && (ACCT.user.unlimited || ACCT.user.plan === 'pro')) {
    pendingSec = 0;                     // 永久会员不用上报，省一次请求
    return;
  }
  pendingSec = 0;
  inFlight = true;
  try {
    const d = await call('tick', { seconds: sec });
    if (d && d.ok) applyUser(d.user);
    else if (d && d.reason === 'need-login') logout();
  } catch (e) {
    // 网络断了就把秒数还回去，下次一起报；离线期间不惩罚用户
    pendingSec += sec;
  } finally {
    inFlight = false;
  }
}

export function startTicker() {
  if (tickTimer) return;
  lastActive = Date.now();
  tickTimer = setInterval(() => {
    if (!token()) { stopTicker(); return; }
    if (isActive()) pendingSec += TICK_MS / 1000;
    if (pendingSec >= 30) flush();
  }, TICK_MS);
}

export function stopTicker() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  pendingSec = 0;
}

/* ------------------------------ 启动 ------------------------------ */

export async function init() {
  // 页面切走时把没报的秒数补上，别让人白用
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', () => { flush(); });
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, poke, { passive: true });
  });

  if (!token()) {
    ACCT.ready = true;
    emit();
    return ACCT;
  }
  await refresh();
  ACCT.ready = true;
  emit();
  if (ACCT.user) startTicker();
  return ACCT;
}

/** 秒数 → 时:分:秒，用于顶栏倒计时 */
export function fmtRemain(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

/* 调试用：控制台里能直接看状态 */
try { window.ECAccount = { ACCT, init, login, register, logout, refresh, redeem, canUse, remaining, token, fmtRemain }; } catch (e) { /* 无所谓 */ }
