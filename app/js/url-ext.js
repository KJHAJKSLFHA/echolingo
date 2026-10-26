// EchoLingo · 浏览器扩展桥
// 装了「EchoLingo 取流助手」扩展时，链接导入优先走它——不用下载桌面版、不用开着本机服务。
// 没装扩展就返回 null，页面照旧走 server.js / 本机助手，行为完全不变。
//
// 协议：页面 --postMessage--> content.js --sendMessage--> background.js
//   { channel:'echolingo-ext', type:'call', id, action, url?, mode?, jobId? }
//   <-- { channel:'echolingo-ext', type:'reply', id, payload }

const CH = 'echolingo-ext';
const EXT_WAIT_MS = 600;   // content script 是 document_start 注入，最多等这么久
const EXT_CALL_MS = 20000; // 单次调用上限，YouTube 接口偶尔慢
const EXT_CHUNK_MS = 45000; // 分块代取单块最多等这么久（1 MB，4G 下也够）

let seq = 0;
const pending = new Map();
let helloResolve = null;
let helloPromise = null;

function ensureWaiter() {
  if (helloPromise) return helloPromise;
  helloPromise = new Promise((resolve) => {
    helloResolve = resolve;
    /* content script 是 document_start 注入的，它的 hello 很可能比这个模块的监听器更早发出，
       只被动等就会永远收不到（实测：手动 ping 能通、走真实 UI 却认不出扩展）。
       所以这里补一次主动 ping，content.js 收到会立刻回 hello。 */
    try {
      window.postMessage({ channel: CH, type: 'ping' }, location.origin || '*');
    } catch {
      /* 发不出去就靠对方主动 hello */
    }
    setTimeout(() => resolve(false), EXT_WAIT_MS);
  });
  return helloPromise;
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.channel !== CH) return;
    if (ev.source !== window) return;

    if (d.type === 'hello') {
      if (helloResolve) helloResolve(true);
      return;
    }
    if (d.type !== 'reply') return;
    const slot = pending.get(d.id);
    if (!slot) return;
    pending.delete(d.id);
    clearTimeout(slot.timer);
    slot.resolve(d.payload || { ok: false, error: '扩展返回了空结果' });
  }, false);
}

/** 扩展在不在位 */
export async function extAvailable() {
  if (typeof window === 'undefined') return false;
  const ok = await ensureWaiter();
  return ok === true;
}

function callOnce(action, extra, timeoutMs) {
  return new Promise((resolve) => {
    const id = 'c' + (++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: '扩展响应超时', code: 'timeout' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    window.postMessage({ channel: CH, type: 'call', id, action, ...extra }, location.origin || '*');
  });
}

/** 调扩展走一次；扩展不在位返回 null，好让上层回退到本机服务 */
export async function extCall(action, extra = {}) {
  if (!(await extAvailable())) return null;
  const ms = action === 'mediaChunk' ? EXT_CHUNK_MS : EXT_CALL_MS;
  return callOnce(action, extra, ms);
}

/** 把 base64 还原成 Uint8Array（不用 atob → 逐字符转，大块会卡） */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 经扩展后台把整个媒体资源拉下来，拼成一个 Blob。
 * 媒体主机不给页面的 CORS 放行（googlevideo 只发 vary: Origin；bilivideo 认 Referer），
 * 页面自己 fetch 一定失败，只能让扩展代取。
 * onProgress(已下载字节, 总字节)
 */
export async function extMediaBlob(mediaUrl, totalSize, onProgress) {
  const parts = [];
  let offset = 0;
  let size = Number(totalSize) || 0;
  let guard = 0;
  while (guard < 4096) {
    guard += 1;
    const res = await callOnce(
      'mediaChunk',
      { mediaUrl, offset, total: size, length: 1048576 },
      EXT_CHUNK_MS,
    );
    if (!res || res.ok !== true) {
      const err = new Error((res && res.error) || '扩展代取下片失败');
      err.code = (res && res.code) || 'chunk';
      throw err;
    }
    if (res.n > 0) parts.push(b64ToBytes(res.data));
    offset += res.n;
    size = Number(res.size) || size;
    if (typeof onProgress === 'function') onProgress(offset, size);
    if (res.n <= 0 || res.done || (size && offset >= size)) break;
  }
  return new Blob(parts);
}

/** 把扩展的 { ok:false, error, code } 变成本地同形态的异常，上层 catch 逻辑无需区分来源 */
export function extError(payload, fallback) {
  const err = new Error((payload && payload.error) || fallback || '取流失效');
  err.code = (payload && payload.code) || 'ext';
  err.fromExt = true;
  return err;
}
